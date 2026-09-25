/**
 * 飞书发起的回合：**入站只登记、出站统一投递**（2026-09-24 `571bc89` 起）。
 *
 * 背景：原先入站路径 await 整轮并自己投递摘要卡（未完整送达再回退纯文本），所以必须有
 * `replyTimeoutMs` 硬超时；实测长回合（14 分钟）超时后通知被**静默丢弃**。现在入站路径
 * 只做四件事：OnIt 表情 → 注入 prompt → 登记「待翻表情」闭包 → 返回。投递（根卡片 +
 * 话题线程）只发生在 summary-service 的 turn/end 监听里，飞书发起的回合与 Web 发起的
 * 回合**走同一条路**；去重靠「唯一投递方」，不再靠 `fromFeishu` 闸门。
 *
 * 本文件锁三组不变量：
 * 一（入站，真实 startInboundForBot）：
 * 1. 发 OnIt、注入 prompt、登记待翻表情；**绝不投递、绝不回任何文字消息**；
 * 2. 新契约没有「回退纯文本」这条路：没有投递能力也不回退；
 * 3. 唯一的入站错误路径是「注入失败」⇒ ERROR 表情 + 错误回帖。
 * 二（summary-service）：投递结果语义 + 飞书回合由事件监听恰好投递一次。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { startInboundForBot } from '../lib/host/inbound-runtime.js'
import { installSummaryPush } from '../lib/host/summary-service.js'

const BOT = { id: 'bot_x', appId: 'cli_a', secretRef: 'ref', botName: '测试机器人' }
const REPLY = '## 结论\n\n打包成功 ✅\n\n- 要点甲\n'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(predicate, label, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error('waitFor 超时: ' + label)
}

// ───────────────────────── 一、入站集成（真实 startInboundForBot） ─────────────────────────

/**
 * 假 Lark SDK：记录所有飞书写操作（reply/create/reaction），并暴露事件分发器。
 * `bag.ops` 是与 RPC 桩共享的**有序**操作日志（prompt 也记进去），用于断言先后关系。
 */
function makeFakeLark(bag) {
  const Domain = { Feishu: 'feishu', Lark: 'lark' }
  const LoggerLevel = { info: 'info' }
  class EventDispatcher {
    register(handlers) { Object.assign(this, handlers); return this }
  }
  class Client {
    im = { v1: {
      message: {
        reply: async (args) => {
          const content = args?.data?.content ?? ''
          bag.ops.push({ op: 'reply', content })
          bag.replies.push(content)
          return { data: { message_id: 'om_reply_' + bag.replies.length } }
        },
        create: async (args) => {
          const content = args?.data?.content ?? ''
          bag.ops.push({ op: 'send', content })
          bag.chatSends.push(content)
          return { data: { message_id: 'om_chat_' + bag.chatSends.length } }
        },
      },
      messageReaction: {
        create: async ({ path, data }) => {
          const emoji = data?.reaction_type?.emoji_type
          bag.ops.push({ op: 'reaction', kind: 'add', emoji, to: path.message_id })
          bag.reactions.push({ kind: 'add', emoji, to: path.message_id })
          return { data: { reaction_id: 'r_' + path.message_id } }
        },
        delete: async ({ path }) => {
          bag.ops.push({ op: 'reaction', kind: 'delete', to: path.message_id })
          bag.reactions.push({ kind: 'delete', to: path.message_id })
          return {}
        },
      },
    } }
  }
  class WSClient {
    async start({ eventDispatcher }) { this.eventDispatcher = eventDispatcher }
    close() {}
  }
  return { Domain, LoggerLevel, EventDispatcher, WSClient, Client }
}

const listen = (server) => new Promise((resolve) => server.once('listening', resolve))
async function closeServer(server) {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

/**
 * RPC 桩：入站路径只用到 workspace/session.create + session.prompt（不再有 history 轮询）。
 * `state.failPrompt` 让注入返回 `{ok:false}`（触发入站唯一的错误路径）。
 * `state.ops` 与假 Lark 的 `bag.ops` 是**同一个数组**，prompt 也按发生顺序记进去。
 */
function makeRpcServer(state) {
  return createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const { rpcId, method, payload } = JSON.parse(body)
      const ok = (value) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }))
      }
      if (method === 'workspace.list') return ok({ items: [] })
      if (method === 'workspace.create') return ok({ workspace: { workspaceId: 'ws1', path: payload.path } })
      if (method === 'session.list') return ok({ items: [] })
      if (method === 'session.create') {
        const sessionId = 'session-new-' + (++state.created)
        state.createdIds.push(sessionId)
        return ok({ sessionId })
      }
      if (method === 'session.history') return ok({ events: [] })
      if (method === 'session.prompt') {
        if (state.failPrompt) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'prompt-failed', message: '注入炸了' } } }))
          return
        }
        state.promptRpcId = rpcId
        state.prompts.push(payload.content?.[0]?.text)
        state.ops.push({ op: 'prompt', text: payload.content?.[0]?.text })
        return ok({})
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'unknown-method', message: method } } }))
    })
  })
}

function makeEvent(text, messageId) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_u1' } },
    message: {
      message_id: messageId, message_type: 'text', chat_type: 'p2p',
      chat_id: 'oc_chat1', content: JSON.stringify({ text }),
    },
  }
}

/**
 * 跑一条**真实**入站消息。helpers 与生产一致：只有 `registerPendingReaction`，
 * **没有** `deliverTurnNotification`（入站路径已不再投递，投递只在 section 二 覆盖的
 * summary-service turn/end 监听里发生）。
 *
 * @param {object} opts
 * @param {string} opts.text        入站文本
 * @param {boolean} opts.failPrompt 让 session.prompt 返回失败（注入异常路径）
 */
async function driveInbound({ text = '第一件事', failPrompt = false } = {}) {
  const bag = {
    replies: [], chatSends: [], ops: [], reactions: [], mappings: [],
    botState: { version: 1, sessions: {}, seenMessageIds: [] },
  }
  const state = { created: 0, createdIds: [], promptRpcId: null, prompts: [], failPrompt, ops: bag.ops }
  const server = makeRpcServer(state)
  await listen(server.listen(0, '127.0.0.1'))

  const sdk = makeFakeLark(bag)
  const captured = []
  const origStart = sdk.WSClient.prototype.start
  sdk.WSClient.prototype.start = async function (opts) { captured.push(opts.eventDispatcher); return origStart.call(this, opts) }

  const pendingReactions = []
  const helpers = {
    log: () => {},
    lookupReplyMapping: () => null,
    recordReplyMapping: (messageId, meta) => bag.mappings.push({ messageId, ...meta }),
    readBotState: () => structuredClone(bag.botState),
    writeBotState: (_bot, next) => { bag.botState = structuredClone(next) },
    registerPendingReaction: (sessionId, entry) => pendingReactions.push({ sessionId, ...entry }),
  }

  try {
    await startInboundForBot({
      origin: `http://127.0.0.1:${server.address().port}`,
      workspace: '/tmp/proj-w', agentPreset: 'standard',
      replyTimeoutMs: 3000, replyMaxChars: 9000,
      defaultSessionPolicy: 'fresh', defaultSessionIdleMinutes: 30,
      bot: BOT, appSecret: 's3cret', record: null, larkSdk: sdk, helpers,
    })

    captured[0]['im.message.receive_v1'](makeEvent(text, 'om_in_1'))
    // 同步点：成功路径的收尾是「登记待翻表情」，失败路径的收尾是「错误回帖」。
    await waitFor(
      () => pendingReactions.length >= 1 || bag.replies.length >= 1,
      '入站路径收尾（登记待翻表情 / 错误回帖）',
    )
    // 再等一小会儿，确认「本不该发生的事」（投递/翻表情）真的没有发生。
    await sleep(60)
  } finally {
    // 必须无条件收掉桩服务：断言失败时若漏掉它，node --test 会挂住不退出。
    await closeServer(server)
  }
  return { bag, state, pendingReactions }
}

test('入站：OnIt 先于 prompt，只登记待翻表情；不投递、不回任何文字消息', async () => {
  const { bag, state, pendingReactions } = await driveInbound({ text: '总结一下' })

  // 1. 顺序：OnIt 表情是第一条飞书写操作，且发生在注入 prompt 之前
  const onItAt = bag.ops.findIndex((e) => e.op === 'reaction' && e.emoji === 'OnIt')
  const promptAt = bag.ops.findIndex((e) => e.op === 'prompt')
  assert.ok(onItAt >= 0, 'OnIt reaction 已添加')
  assert.ok(promptAt > onItAt, 'OnIt 必须发生在注入 prompt 之前')

  // 2. 注入：进入本条入站新建的会话，rpcId 带 fsum- 前缀（防回环依据）
  assert.deepEqual(state.prompts, ['总结一下'])
  assert.match(state.promptRpcId, /^fsum-/)

  // 3. 收尾：登记一个翻转闭包；DONE/ERROR 由共享的 turn/end 处理器翻
  assert.equal(pendingReactions.length, 1, '登记了一条待翻表情')
  assert.equal(pendingReactions[0].sessionId, state.createdIds[0], '登记到本条入站新建的会话')
  assert.equal(pendingReactions[0].messageId, 'om_in_1')
  assert.equal(typeof pendingReactions[0].flip, 'function')

  // 4. 不投递、不回文字：既没有回帖/主动发送，也没有回帖记账，更没翻表情
  assert.equal(bag.replies.length, 0, '入站路径不得回任何文字消息')
  assert.equal(bag.chatSends.length, 0, '入站路径不得主动发消息')
  assert.ok(!bag.mappings.some((m) => m.source === 'feishu-outbound-reply'), '不得有回帖记账')
  assert.ok(!bag.reactions.some((r) => r.emoji === 'DONE' || r.emoji === 'ERROR'), '入站路径不翻表情')
})

test('入站：没有投递能力也不回退纯文本（旧「卡片失败 → 纯文本」兜底已随入站投递一起删除）', async () => {
  const { bag, pendingReactions } = await driveInbound({ text: '没有投递能力时' })

  // helpers 里没有 deliverTurnNotification —— 与生产一致。若还残留回退逻辑，
  // 这里就会冒出一条纯文本；新契约下唯一的收尾是登记待翻表情。
  assert.equal(pendingReactions.length, 1, '收尾是登记待翻表情')
  assert.equal(bag.replies.length, 0, '绝不回退纯文本')
  assert.equal(bag.chatSends.length, 0, '也不主动发消息')
  assert.ok(!bag.mappings.some((m) => m.source === 'feishu-outbound-reply'), '没有回帖记账')
})

test('入站：注入 prompt 失败 ⇒ ERROR 表情 + 错误回帖（唯一的入站错误路径）', async () => {
  const { bag, pendingReactions } = await driveInbound({ text: '会失败的一个', failPrompt: true })

  assert.ok(bag.reactions.some((r) => r.kind === 'add' && r.emoji === 'OnIt'), '先加了 OnIt')
  assert.ok(bag.reactions.some((r) => r.kind === 'add' && r.emoji === 'ERROR'), '失败必须翻 ERROR')
  assert.ok(!bag.reactions.some((r) => r.kind === 'add' && r.emoji === 'DONE'), '不得翻 DONE')

  assert.equal(bag.replies.length, 1, '必须回一条错误消息告知用户')
  assert.match(JSON.parse(bag.replies[0]).text, /处理失败/, '回帖要说明处理失败')
  assert.ok(!pendingReactions.length, '失败不登记待翻表情（表情已经翻过）')
  assert.ok(bag.mappings.some((m) => m.source === 'feishu-outbound-reply'), '错误回帖也要记账（可引用锚点）')
})

// ───────────────────── 二、summary-service：投递结果语义 + 不重复投递 ─────────────────────

function makeCtx() {
  const handlers = []
  return {
    on: (name, fn) => { if (name === 'session/event') handlers.push(fn) },
    emit: (session, event) => { for (const h of handlers) h(session, event) },
  }
}

function makeSession({ id = 'session-1', cwd = '/tmp/w', promptRpcId = null, events = null } = {}) {
  const source = promptRpcId ? { kind: 'user', rpcId: promptRpcId } : { kind: 'user' }
  const evts = events ?? [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '帮我打包' }], source } },
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: REPLY }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return { id, header: { cwd }, snapshotEvents: () => evts }
}

/** 假飞书 API + 同步重试层。 */
function makeDeps({ cardResult = 'om_root_card', threadResult = null, replyCardFails = false, textResult = 'om_root_text' } = {}) {
  const calls = { card: [], text: [], replyCard: [], replyText: [], digests: [] }
  const deps = {
    includeReasons: ['completed'],
    botSelection: 'all',
    chatId: 'oc_test',
    notificationFormat: 'card',
    maxText: 1500,
    loadBots: () => [{ id: 'b1', appId: 'cli_test', ownerOpenIds: ['ou_1'] }],
    resolveSecret: async () => ({ value: 'secret' }),
    sendCardMessage: async (creds, card, opts) => {
      void creds
      calls.card.push({ card, opts })
      if (cardResult instanceof Error) throw cardResult
      return cardResult
    },
    sendTextMessage: async (creds, text, opts) => { calls.text.push({ text, opts }); return textResult },
    // 与 feishu-api 真实签名一致：messageId 在 creds 里。
    replyCardMessage: async (creds, card, opts) => {
      calls.replyCard.push({ creds, card, opts })
      if (replyCardFails) throw new Error('thread boom')
      return threadResult ?? 'om_reply_' + calls.replyCard.length
    },
    replyTextMessage: async (creds, text, opts) => {
      calls.replyText.push({ creds, text, opts })
      return 'om_textreply_' + calls.replyText.length
    },
    recordReplyMapping: () => {},
    recordDigest: (entry) => calls.digests.push(entry),
    readDigestHistory: () => [],
    log: () => {},
    // 同步重试层：真实实现是指数退避（10 次、分钟级），单测里必须立即返回。
    resilientSender: {
      sendWithRetry: async (fn) => {
        try { return { ok: true, value: await fn() } } catch (err) { return { ok: false, error: err } }
      },
    },
  }
  return { deps, calls }
}

test('deliverTurnNotification：根卡 + 线程都到位 ⇒ delivered=true', async () => {
  const ctx = makeCtx()
  const { deps, calls } = makeDeps()
  const { deliverTurnNotification } = installSummaryPush(ctx, deps)

  const res = await deliverTurnNotification({ sessionId: 'session-1', turn: 1, session: makeSession() })

  assert.equal(res.delivered, true)
  assert.equal(res.reason, 'ok')
  assert.equal(res.rootId, 'om_root_card')
  assert.equal(calls.card.length, 1, '发了根卡片')
  assert.equal(calls.replyCard.length, 1, '全文挂到了话题线程')
  assert.equal(calls.digests.length, 1, '摘要已落 digest-history')
})

test('deliverTurnNotification：线程没上去 ⇒ delivered=false(thread-incomplete)（表情据此翻 ERROR）', async () => {
  const ctx = makeCtx()
  const { deps, calls } = makeDeps({ replyCardFails: true })
  const { deliverTurnNotification } = installSummaryPush(ctx, deps)

  const res = await deliverTurnNotification({ sessionId: 'session-1', turn: 1, session: makeSession() })

  assert.equal(res.delivered, false)
  assert.equal(res.reason, 'thread-incomplete')
  assert.equal(calls.card.length, 1, '根卡片已发出（保留，不重发）')
})

test('deliverTurnNotification：根消息发送失败 ⇒ delivered=false(root-failed)', async () => {
  const ctx = makeCtx()
  const { deps } = makeDeps({ cardResult: new Error('feishu 500') })
  const { deliverTurnNotification } = installSummaryPush(ctx, deps)

  const res = await deliverTurnNotification({ sessionId: 'session-1', turn: 1, session: makeSession() })
  assert.equal(res.delivered, false)
  assert.equal(res.reason, 'root-failed')
})

test('deliverTurnNotification：显式空正文 ⇒ delivered=false(empty-reply)，改投说明卡而不是空投', async () => {
  const ctx = makeCtx()
  const { deps, calls } = makeDeps()
  const { deliverTurnNotification } = installSummaryPush(ctx, deps)

  // 显式给了空 replyOverride ⇒ 听调用方的（不去替它捞推理），走说明卡兜底。
  const res = await deliverTurnNotification({ sessionId: 'session-1', turn: 1, replyOverride: '' })
  assert.equal(res.delivered, false, '说明卡只是告知，回答依然没有送达')
  assert.equal(res.reason, 'empty-reply')
  assert.equal(calls.card.length, 1, '改投一条说明卡（不再静默早退）')
  // 「绝不空投」的新语义：说明卡必须带可读文案，且没有任何空 body 被发出去。
  const notice = JSON.stringify(calls.card[0].card)
  assert.match(notice, /没有可投递的正文/, '卡片要说明「为什么没有回答」')
  assert.match(notice, /显式指定了空正文/, '并说清是哪一种「没有正文」')
  assert.equal(calls.replyCard.length, 0, '正文本来就不存在，不该建空线程')
  const bodies = [...calls.card.map((c) => JSON.stringify(c.card)), ...calls.text.map((t) => t.text)]
  assert.ok(bodies.length > 0 && bodies.every((b) => String(b ?? '').trim().length > 0),
    '不得发送空 body')
})

test('飞书发起的回合由事件监听投递，且恰好一次（去重靠唯一投递方，不再靠 fromFeishu 闸门）', async () => {
  const ctx = makeCtx()
  const { deps, calls } = makeDeps()
  installSummaryPush(ctx, deps)

  // rpcId 带 fsum- 前缀 ⇒ 标记为飞书发起的回合
  const session = makeSession({ promptRpcId: 'fsum-abc-123' })
  for (const event of session.snapshotEvents()) ctx.emit(session, event)
  await waitFor(() => calls.replyCard.length >= 1, 'event-listener delivery')
  await sleep(30)

  assert.equal(calls.card.length, 1, '飞书回合与 Web 回合走同一条投递路径，恰好一次')
  assert.equal(calls.replyCard.length, 1, '完整回复照样进话题线程')
  assert.equal(calls.digests.length, 1, '摘要只落一次')
})

test('非飞书回合仍由事件监听自动投递（原有行为不变）', async () => {
  const ctx = makeCtx()
  const { deps, calls } = makeDeps()
  installSummaryPush(ctx, deps)

  const session = makeSession({ promptRpcId: 'f0ec4c4a-0000-0000-0000-000000000000' })
  for (const event of session.snapshotEvents()) ctx.emit(session, event)
  await waitFor(() => calls.card.length >= 1, 'auto delivery')

  assert.equal(calls.card.length, 1)
  assert.equal(calls.replyCard.length, 1, '完整回复照样进话题线程')
})
