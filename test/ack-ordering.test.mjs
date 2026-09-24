/**
 * 入站链路顺序回归：路由解析 → OnIt reaction → session.prompt → 最终回复。
 *
 * 2026-09-24 变更：**去掉了「✅ 已转发到对应 DSH 会话」那条即时回执**。
 * 理由：`OnIt` 表情本身已经表达「收到、正在处理」，再补一条消息只是刷屏（用户要求）。
 * 因此本文件的断言从「回执先于 prompt」改为「reaction 先于 prompt，且回合结束前飞书侧没有文字消息」。
 * 另注：回执原先也是「可长按引用」的锚点，但入站消息与最终回答都仍写 reply-map，引用续聊不受影响。
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

function makeHelpers(mappings) {
  return {
    log: () => {},
    lookupReplyMapping: () => null,
    recordReplyMapping: (messageId, meta) => mappings.push({ messageId, ...meta }),
    readBotState: () => ({ version: 1, sessions: { 'p2p:ou_u1': 'session-fixed' }, seenMessageIds: [] }),
    writeBotState: () => {},
  }
}

const BOT = { id: 'bot_x', appId: 'cli_a', secretRef: 'ref', botName: '测试机器人' }

/** 统一的启动+触发+收尾，保证任何断言失败都会关掉桩服务（否则 node --test 不会退出）。 */
async function driveFixture({ log, mappings, state, larkOpts, run, replyTimeoutMs = 4000, failReply = false }) {
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
      helpers: makeHelpers(mappings),
    })
    const dispatcher = larkSdk.__dispatchers[0]
    assert.ok(dispatcher, 'dispatcher captured')
    dispatcher['im.message.receive_v1'](makeEvent('帮我看看'))
    await run(dispatcher)
  } finally {
    await closeServer(server)
  }
}

test('reaction 先于 prompt；回合结束前飞书侧没有文字消息，结束后回帖最终答案', async () => {
  const log = []
  const mappings = []
  const state = { prompted: false, promptRpcId: null, promptText: null, historyEvents: [] }

  await driveFixture({
    log, mappings, state,
    run: async () => {
      // 1. 第一条飞书写操作必须是 OnIt 表情（回执已去掉）
      await until(() => log.some((e) => e?.op === 'reaction' && e.emoji === 'OnIt'), 'OnIt reaction')
      assert.equal(log.filter((e) => e?.op === 'reply').length, 0, 'prompt 之前不得有任何回帖')

      // 2. prompt 注入的是用户文本，rpcId 带 fsum- 前缀（防回环依据）
      await until(() => state.prompted, 'prompt issued')
      assert.equal(state.promptText, '帮我看看')
      assert.match(state.promptRpcId, /^fsum-/)
      assert.equal(log.filter((e) => e?.op === 'reply').length, 0, '回合进行中也不发文字消息')

      // 3. 会话产生回答后：DONE reaction + 回帖到同一线程
      state.historyEvents = [
        { event: { seq: 10, type: 'turn/start', data: { turn: 7 } } },
        { event: { seq: 11, type: 'user/message', data: { source: { rpcId: state.promptRpcId }, turn: 7 } } },
        { event: { seq: 12, type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: '最终回答' }] } } } },
        { event: { seq: 13, type: 'turn/end', data: { turn: 7 } } },
      ]
      await until(() => log.some((e) => e?.op === 'reply'), 'final reply')
      const final = log.find((e) => e?.op === 'reply')
      assert.equal(final.to, 'om_in_1')
      assert.equal(final.text, '最终回答')
      assert.ok(log.some((e) => e?.op === 'reaction' && e.emoji === 'DONE'), 'DONE reaction added')

      // 4. 入站消息与最终回帖都映射到同一 session（连续线程路由依据；
      //    回执没了，但入站消息本身仍是可引用锚点）
      const mappedIds = new Set(mappings.map((m) => m.messageId))
      for (const id of ['om_in_1', final.id]) {
        assert.ok(mappedIds.has(id), `mapping recorded for ${id}`)
      }
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
