/**
 * 入站链路顺序回归：路由解析 → OnIt reaction → session.prompt → 登记待翻表情。
 *
 * 2026-09-24 变更（`571bc89`）：入站路径**不再等待回合、不再回帖、不再回退纯文本**。
 * 投递与表情翻转都交给 summary-service 的 turn/end 监听（飞书发起的回合与 Web 发起的
 * 回合同一条路径）。因此本文件的断言是：reaction 先于 prompt；入站路径全程（回合结束
 * 前后）都不发任何文字消息；DONE/ERROR 的翻转只能由登记的闭包（共享 turn/end 处理器）
 * 触发。更早（同日）还去掉了「✅ 已转发到对应 DSH 会话」那条即时回执 —— `OnIt` 表情
 * 本身就表达「收到、正在处理」，再补一条消息只是刷屏。入站消息与出站总结都仍写
 * reply-map，长按引用续聊的能力不受影响。
 *
 * 用假 Lark SDK + 本地 RPC 桩服务走真实 startInboundForBot 代码路径。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { startInboundForBot } from '../lib/host/inbound-runtime.js'

/** 假 Lark SDK：记录所有飞书写操作，暴露事件分发器给测试触发。 */
function makeFakeLark(log, { failReply = false } = {}) {
  const Domain = { Feishu: 'feishu', Lark: 'lark' }
  const LoggerLevel = { info: 'info' }
  let seq = 0

  class EventDispatcher {
    register(handlers) {
      Object.assign(this, handlers)
      return this
    }
  }

  class Client {
    im = {
      v1: {
        message: {
          reply: async ({ path, data }) => {
            if (failReply) throw new Error('feishu down')
            const id = 'om_reply_' + (++seq)
            log.push({ op: 'reply', to: path.message_id, text: JSON.parse(data.content).text, id })
            return { data: { message_id: id } }
          },
          create: async ({ data }) => {
            log.push({ op: 'send', text: JSON.parse(data.content).text })
            return { data: {} }
          },
        },
        messageReaction: {
          create: async ({ path, data }) => {
            log.push({ op: 'reaction', kind: 'add', emoji: data.reaction_type.emoji_type, to: path.message_id })
            return { data: { reaction_id: 'r_' + path.message_id } }
          },
          delete: async () => ({}),
        },
      },
    }
  }

  class WSClient {
    async start({ eventDispatcher }) {
      this.eventDispatcher = eventDispatcher
      log.push('ws-start')
    }
    close() { log.push('ws-close') }
  }

  return { Domain, LoggerLevel, EventDispatcher, WSClient, Client }
}

function makeFakeLarkWithCapture(log, opts) {
  const sdk = makeFakeLark(log, opts)
  const origStart = sdk.WSClient.prototype.start
  sdk.WSClient.prototype.start = async function (opts2) {
    sdk.__dispatchers.push(opts2.eventDispatcher)
    return origStart.call(this, opts2)
  }
  sdk.__dispatchers = []
  return sdk
}

function listen(server) {
  return new Promise((resolve) => server.once('listening', resolve))
}

function makeRpcServer(state) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const { rpcId, method, payload } = JSON.parse(body)
      const ok = (value) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }))
      }
      if (method === 'session.list') {
        return ok({ items: [{ sessionId: 'session-fixed', cwd: '/tmp/proj-w', projections: { values: { title: '测试会话' } } }] })
      }
      if (method === 'session.history') {
        return ok({ events: state.prompted ? structuredClone(state.historyEvents) : [] })
      }
      if (method === 'session.prompt') {
        state.prompted = true
        state.promptRpcId = rpcId
        state.promptText = payload.content?.[0]?.text
        return ok({})
      }
      res.statusCode = 200
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'unknown-method', message: method } } }))
    })
  })
  return server
}

function makeEvent(text) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_u1' } },
    message: {
      message_id: 'om_in_1',
      message_type: 'text',
      chat_type: 'p2p',
      chat_id: 'oc_chat1',
      content: JSON.stringify({ text }),
    },
  }
}

async function closeServer(server) {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

async function until(fn, label, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('timeout waiting for: ' + label)
}

function makeHelpers(mappings, pendingReactions = []) {
  return {
    log: () => {},
    lookupReplyMapping: () => null,
    recordReplyMapping: (messageId, meta) => mappings.push({ messageId, ...meta }),
    readBotState: () => ({ version: 1, sessions: { 'p2p:ou_u1': 'session-fixed' }, seenMessageIds: [] }),
    writeBotState: () => {},
    // 新契约下入站路径唯一的「收尾」动作：登记一个翻转闭包，由共享 turn/end 处理器取出。
    registerPendingReaction: (sessionId, entry) => pendingReactions.push({ sessionId, ...entry }),
  }
}

const BOT = { id: 'bot_x', appId: 'cli_a', secretRef: 'ref', botName: '测试机器人' }

/** 统一的启动+触发+收尾，保证任何断言失败都会关掉桩服务（否则 node --test 不会退出）。 */
async function driveFixture({ log, mappings, state, larkOpts, run, replyTimeoutMs = 4000, failReply = false, pendingReactions = [] }) {
  const server = makeRpcServer(state)
  await listen(server.listen(0, '127.0.0.1'))
  const origin = `http://127.0.0.1:${server.address().port}`
  const larkSdk = makeFakeLarkWithCapture(log, { failReply, ...larkOpts })
  try {
    await startInboundForBot({
      origin,
      workspace: '/tmp/proj-w',
      agentPreset: 'standard',
      replyTimeoutMs,
      replyMaxChars: 9000,
      defaultSessionPolicy: 'fixed',
      bot: BOT,
      appSecret: 's3cret',
      record: null,
      larkSdk,
      helpers: makeHelpers(mappings, pendingReactions),
    })
    const dispatcher = larkSdk.__dispatchers[0]
    assert.ok(dispatcher, 'dispatcher captured')
    dispatcher['im.message.receive_v1'](makeEvent('帮我看看'))
    await run(dispatcher)
  } finally {
    await closeServer(server)
  }
}

test('reaction 先于 prompt；入站路径全程不发文字消息，DONE 翻转交给共享 turn/end 处理器', async () => {
  const log = []
  const mappings = []
  const pendingReactions = []
  const state = { prompted: false, promptRpcId: null, promptText: null, historyEvents: [] }

  await driveFixture({
    log, mappings, state, pendingReactions,
    run: async () => {
      // 1. 第一条飞书写操作必须是 OnIt 表情（回执已去掉）
      await until(() => log.some((e) => e?.op === 'reaction' && e.emoji === 'OnIt'), 'OnIt reaction')
      assert.equal(log.filter((e) => e?.op === 'reply').length, 0, 'prompt 之前不得有任何回帖')

      // 2. prompt 注入的是用户文本，rpcId 带 fsum- 前缀（防回环依据）
      await until(() => state.prompted, 'prompt issued')
      assert.equal(state.promptText, '帮我看看')
      assert.match(state.promptRpcId, /^fsum-/)

      // 3. 新契约：入站路径不等待回合、不做任何投递。即便会话已经产出回答并结束了回合，
      //    飞书侧也不该出现任何文字消息 —— 投递只可能来自共享的 turn/end 处理器。
      state.historyEvents = [
        { event: { seq: 10, type: 'turn/start', data: { turn: 7 } } },
        { event: { seq: 11, type: 'user/message', data: { source: { rpcId: state.promptRpcId }, turn: 7 } } },
        { event: { seq: 12, type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: '最终回答' }] } } } },
        { event: { seq: 13, type: 'turn/end', data: { turn: 7 } } },
      ]
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(log.filter((e) => e?.op === 'reply').length, 0, '回合结束后入站路径也不发文字消息')
      assert.ok(
        !log.some((e) => e?.op === 'reaction' && (e.emoji === 'DONE' || e.emoji === 'ERROR')),
        '入站路径不翻表情：DONE/ERROR 归共享 turn/end 处理器',
      )

      // 4. 入站路径把「翻表情」登记成闭包交给共享处理器；调用它才真正翻 DONE。
      assert.equal(pendingReactions.length, 1, '登记了一条待翻表情')
      const pending = pendingReactions[0]
      assert.equal(pending.sessionId, 'session-fixed', '登记到本条入站命中的会话')
      assert.equal(pending.messageId, 'om_in_1', '翻转的是这条入站消息')
      assert.equal(typeof pending.flip, 'function')
      await pending.flip('DONE')
      assert.ok(log.some((e) => e?.op === 'reaction' && e.emoji === 'DONE'), 'DONE reaction added by shared handler')

      // 5. 入站消息本身是「引用续聊」的锚点（回帖与转发回执都已不存在）
      assert.ok(mappings.some((m) => m.messageId === 'om_in_1' && m.sessionId === 'session-fixed'))
      assert.ok(mappings.every((m) => m.sessionId === 'session-fixed'))
    },
  })
})

test('回帖失败不影响会话推进（reaction 状态照常收尾）', async () => {
  const log = []
  const state = { prompted: false, promptRpcId: null, promptText: null, historyEvents: [] }

  await driveFixture({
    log, mappings: [], state, failReply: true, replyTimeoutMs: 1200,
    run: async () => {
      // 回帖全失败，但仍应走到 prompt、并加上 OnIt
      await until(() => state.prompted, 'prompt despite reply failure')
      assert.ok(log.some((e) => e?.op === 'reaction' && e.emoji === 'OnIt'), 'OnIt reaction still added')
      assert.equal(state.promptText, '帮我看看')
    },
  })
})

test('等待回答超时时飞书侧完全静默：只有 OnIt 表情，没有文字消息、没有 ERROR 表情', async () => {
  const log = []
  const state = { prompted: false, promptRpcId: null, promptText: null, historyEvents: [] }

  await driveFixture({
    log, mappings: [], state, replyTimeoutMs: 600,
    run: async () => {
      await until(() => state.prompted, 'prompt issued')
      // 等 ask() 轮询超时并走完 handle() 的 catch（600ms 超时 + 轮询间隔余量）
      await new Promise((r) => setTimeout(r, 1800))

      // 去掉转发回执后：超时情况下飞书侧一条文字消息都没有
      assert.equal(log.filter((e) => e?.op === 'reply').length, 0, 'no text message at all')
      assert.ok(
        log.some((e) => e?.op === 'reaction' && e.emoji === 'OnIt'),
        'OnIt reaction kept as the only signal',
      )
      assert.ok(
        !log.some((e) => e?.op === 'reaction' && e.emoji === 'ERROR'),
        'no ERROR reaction on timeout',
      )
    },
  })
})
