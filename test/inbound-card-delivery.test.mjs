/**
 * 飞书发起的回合：**卡片即投递 + 纯文本兜底**（用户 2026-09-24 拍板方案 A）。
 *
 * 背景：原来「飞书发起的回合」在 summary-service 里被 `fromFeishu` 直接早退，
 * 而 inbound-runtime 只有 `msg_type:'text'` 的 replyToMessage —— 所以这条通道
 * **永远拿不到卡片**，纯文本又不渲染 Markdown（`**加粗**` 会显示成星号）。
 * 现在入站路径 await `deliverTurnNotification` 走「摘要卡 + 话题线程全文」，
 * 只有**没有完整送达**时才回退纯文本回帖，保证正文只投递一次、且绝不丢。
 *
 * 本文件锁三条不变量：
 * 1. 送达成功 ⇒ 不再发纯文本（否则正文两遍）；
 * 2. 送达失败/异常 ⇒ 必须发纯文本（否则用户什么都收不到）；
 * 3. 飞书回合在 summary-service 的事件监听里**不重复投递**（去重靠入站二选一）。
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

/** 假 Lark SDK：记录 reply/create 调用，便于断言「有没有回纯文本」。 */
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
          bag.replies.push(args?.data?.content ?? '')
          return { data: { message_id: 'om_reply_' + bag.replies.length } }
        },
        create: async (args) => {
          bag.chatSends.push(args?.data?.content ?? '')
          return { data: { message_id: 'om_chat_' + bag.chatSends.length } }
        },
      },
      messageReaction: {
        create: async ({ path }) => ({ data: { reaction_id: 'r_' + path.message_id } }),
        delete: async () => ({}),
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
 * RPC 桩：`session.history` 用 maxMessages 区分存在性探测(1) 与等回合结束的轮询(50)，
 * 后者返回一个「立刻结束」的回合，让 ask() 快速返回 `{text:'ok', turn:1}`。
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
      if (method === 'session.history') {
        if (payload.maxMessages === 1) return ok({ events: [] })
        if (!state.promptRpcId) return ok({ events: [] })
        return ok({ events: [
          { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
          { event: { seq: 2, type: 'user/message', data: { source: { rpcId: state.promptRpcId }, turn: 1 } } },
          { event: { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'ok' }] } } } },
          { event: { seq: 4, type: 'turn/end', data: { turn: 1 } } },
        ] })
      }
      if (method === 'session.prompt') {
        state.promptRpcId = rpcId
        state.prompts.push(payload.content?.[0]?.text)
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
 * 跑一条入站消息，注入受控的 deliverTurnNotification。
 * @param {object} opts.delivery   deliverTurnNotification 的返回值（或抛错）
 */
async function driveInbound({ text = '第一件事', delivery = { delivered: true, reason: 'ok', rootId: 'om_root' } } = {}) {
  const bag = { replies: [], chatSends: [], mappings: [], botState: { version: 1, sessions: {}, seenMessageIds: [] } }
  const state = { created: 0, createdIds: [], promptRpcId: null, prompts: [] }
  const server = makeRpcServer(state)
  await listen(server.listen(0, '127.0.0.1'))

  const sdk = makeFakeLark(bag)
  const captured = []
  const origStart = sdk.WSClient.prototype.start
  sdk.WSClient.prototype.start = async function (opts) { captured.push(opts.eventDispatcher); return origStart.call(this, opts) }

  const deliveryCalls = []
  const helpers = {
    log: () => {},
    lookupReplyMapping: () => null,
    recordReplyMapping: (messageId, meta) => bag.mappings.push({ messageId, ...meta }),
    readBotState: () => structuredClone(bag.botState),
    writeBotState: (_bot, next) => { bag.botState = structuredClone(next) },
    deliverTurnNotification: async (args) => {
      deliveryCalls.push(args)
      if (delivery instanceof Error) throw delivery
      return delivery
    },
  }

  await startInboundForBot({
    origin: `http://127.0.0.1:${server.address().port}`,
    workspace: '/tmp/proj-w', agentPreset: 'standard',
    replyTimeoutMs: 3000, replyMaxChars: 9000,
    defaultSessionPolicy: 'fresh', defaultSessionIdleMinutes: 30,
    bot: BOT, appSecret: 's3cret', record: null, larkSdk: sdk, helpers,
  })

  captured[0]['im.message.receive_v1'](makeEvent(text, 'om_in_1'))
  // 以「投递调用已发生」为同步点，再等一小会儿让后续回帖分支尘埃落定。
  await waitFor(() => deliveryCalls.length >= 1, 'delivery called')
  await sleep(60)

  await closeServer(server)
  return { bag, state, deliveryCalls }
}

test('入站：卡片完整送达时，只投卡片、不再回纯文本（避免正文两遍）', async () => {
  const { bag, deliveryCalls, state } = await driveInbound({ text: '总结一下', delivery: { delivered: true, reason: 'ok', rootId: 'om_root' } })

  assert.equal(deliveryCalls.length, 1, '恰好投递一次')
  const call = deliveryCalls[0]
  assert.equal(call.sessionId, state.createdIds[0], '投递到本条入站新建的会话')
  assert.equal(call.turn, 1, 'ask() 必须把被锚定的回合号带回来')
  assert.equal(call.questionOverride, '总结一下', '本回合提问用用户原话')
  assert.equal(call.replyOverride, 'ok', '正文用 ask() 拿到的回答')

  assert.equal(bag.replies.length, 0, '卡片已完整送达 ⇒ 不得再发纯文本回帖')
  assert.ok(!bag.mappings.some((m) => m.source === 'feishu-outbound-reply'), '也不该有纯文本回帖的记账')
})

test('入站：卡片未完整送达 ⇒ 回退纯文本回帖，正文不能丢', async () => {
  const { bag, deliveryCalls } = await driveInbound({ delivery: { delivered: false, reason: 'thread-incomplete', rootId: 'om_root' } })

  assert.equal(deliveryCalls.length, 1)
  assert.equal(bag.replies.length, 1, '回退发了一条纯文本回帖')
  assert.match(bag.replies[0], /ok/, '回帖里必须带正文')
  await waitFor(() => bag.mappings.some((m) => m.source === 'feishu-outbound-reply'), 'fallback mapping')
})

test('入站：投递抛异常 ⇒ 同样回退纯文本回帖（异常不能吞掉正文）', async () => {
  const { bag } = await driveInbound({ delivery: new Error('飞书 500') })
  assert.equal(bag.replies.length, 1, '异常也必须兜住')
  assert.match(bag.replies[0], /ok/)
})

test('入站：没有注入投递能力时，退回旧的纯文本行为（向后兼容）', async () => {
  const bag = { replies: [], chatSends: [], mappings: [], botState: { version: 1, sessions: {}, seenMessageIds: [] } }
  const state = { created: 0, createdIds: [], promptRpcId: null, prompts: [] }
  const server = makeRpcServer(state)
  await listen(server.listen(0, '127.0.0.1'))
  const sdk = makeFakeLark(bag)
  const captured = []
  const origStart = sdk.WSClient.prototype.start
  sdk.WSClient.prototype.start = async function (opts) { captured.push(opts.eventDispatcher); return origStart.call(this, opts) }

  await startInboundForBot({
    origin: `http://127.0.0.1:${server.address().port}`,
    workspace: '/tmp/proj-w', agentPreset: 'standard',
    replyTimeoutMs: 3000, replyMaxChars: 9000,
    defaultSessionPolicy: 'fresh', defaultSessionIdleMinutes: 30,
    bot: BOT, appSecret: 's3cret', record: null, larkSdk: sdk,
    helpers: {
      log: () => {},
      lookupReplyMapping: () => null,
      recordReplyMapping: (messageId, meta) => bag.mappings.push({ messageId, ...meta }),
      readBotState: () => structuredClone(bag.botState),
      writeBotState: (_bot, next) => { bag.botState = structuredClone(next) },
    },
  })
  captured[0]['im.message.receive_v1'](makeEvent('没有投递能力时', 'om_in_1'))
  await waitFor(() => bag.mappings.some((m) => m.source === 'feishu-inbound'), 'inbound recorded')
  await waitFor(() => bag.replies.length >= 1, 'text fallback reply')
  assert.match(bag.replies[0], /ok/)
  await closeServer(server)
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

test('deliverTurnNotification：线程没上去 ⇒ delivered=false(thread-incomplete)，供入站回退纯文本', async () => {
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

test('deliverTurnNotification：没有正文 ⇒ delivered=false(empty-reply)，绝不空投', async () => {
  const ctx = makeCtx()
  const { deps, calls } = makeDeps()
  const { deliverTurnNotification } = installSummaryPush(ctx, deps)

  const res = await deliverTurnNotification({ sessionId: 'session-1', turn: 1, replyOverride: '' })
  assert.equal(res.delivered, false)
  assert.equal(res.reason, 'empty-reply')
  assert.equal(calls.card.length, 0)
})

test('飞书发起的回合由入站路径投递：事件监听不重复投递，手工调用才发', async () => {
  const ctx = makeCtx()
  const { deps, calls } = makeDeps()
  const { deliverTurnNotification } = installSummaryPush(ctx, deps)

  // rpcId 带 fsum- 前缀 ⇒ 标记为飞书发起的回合
  const session = makeSession({ promptRpcId: 'fsum-abc-123' })
  for (const event of session.snapshotEvents()) ctx.emit(session, event)
  await sleep(50)

  assert.equal(calls.card.length, 0, '事件监听必须放行，否则入站再投一次就重复了')

  const res = await deliverTurnNotification({ sessionId: session.id, turn: 1 })
  assert.equal(res.delivered, true)
  assert.equal(calls.card.length, 1, '手工调用才真正投递')
  assert.equal(calls.replyCard.length, 1)
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
