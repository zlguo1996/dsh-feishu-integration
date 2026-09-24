/**
 * 默认会话策略：**未引用任何会话**时，入站消息落在哪个会话。
 *
 * 用户报障：不引用会话直接发消息时，所有消息都被塞进**同一个固定会话**
 * （旧实现读 `botState.sessions[conversationKey]`），那个会话的上下文只增不减 ——
 * 聊得越久，每轮喂给模型的 token 越多，最终要么超上限、要么后续回答开始失焦
 * （「每次后面的回复都会有一些奇怪」）。修复后默认 `fresh`：每条消息新建会话，
 * 连续性改由「长按引用某条总结/机器人的回答」承担（reply-map 路由）。
 *
 * 用假 Lark SDK + 本地 RPC 桩服务走真实 startInboundForBot 代码路径。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { startInboundForBot } from '../lib/host/inbound-runtime.js'

const BOT = { id: 'bot_x', appId: 'cli_a', secretRef: 'ref', botName: '测试机器人' }
const P2P_KEY = 'p2p:ou_u1'

/** 假 Lark SDK：只保留写操作记录与事件分发器；会话创建由 RPC 桩计数。 */
function makeFakeLark(botId) {
  const Domain = { Feishu: 'feishu', Lark: 'lark' }
  const LoggerLevel = { info: 'info' }
  class EventDispatcher {
    register(handlers) { Object.assign(this, handlers); return this }
  }
  class Client {
    im = { v1: {
      message: {
        reply: async () => ({ data: { message_id: 'om_reply_' + botId.id++ } }),
        create: async () => ({ data: {} }),
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

function listen(server) {
  return new Promise((resolve) => server.once('listening', resolve))
}

async function closeServer(server) {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

async function until(fn, label, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('timeout waiting for: ' + label)
}

/**
 * RPC 桩：`session.history` 用 maxMessages 区分「存在性探测/基线」(1) 与
 * 「等回合结束的轮询」(50)，后者返回一个立即结束的回合，让 ask() 快速返回。
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
      message_id: messageId,
      message_type: 'text',
      chat_type: 'p2p',
      chat_id: 'oc_chat1',
      content: JSON.stringify({ text }),
    },
  }
}

/**
 * @param {{bots: object, mappings: object[], state: object}} bag
 * readBotState 返回**深拷贝**、writeBotState 整表写回 —— 与真实 state.json 的
 * 读写语义一致，避免共享引用掩盖「忘了持久化」的 bug。
 */
function makeHelpers(bag) {
  return {
    log: () => {},
    lookupReplyMapping: () => null,
    recordReplyMapping: (messageId, meta) => bag.mappings.push({ messageId, ...meta }),
    readBotState: () => structuredClone(bag.botState),
    writeBotState: (_bot, next) => { bag.botState = structuredClone(next) },
  }
}

async function drive({ texts, policy, idleMinutes, botState, replyTimeoutMs = 3000 }) {
  const bag = { mappings: [], botState }
  const state = { created: 0, createdIds: [], promptRpcId: null, prompts: [] }
  const server = makeRpcServer(state)
  await listen(server.listen(0, '127.0.0.1'))

  const sdk = makeFakeLark({ id: 0 })
  const captured = []
  const origStart = sdk.WSClient.prototype.start
  sdk.WSClient.prototype.start = async function (opts) {
    captured.push(opts.eventDispatcher)
    return origStart.call(this, opts)
  }

  await startInboundForBot({
    origin: `http://127.0.0.1:${server.address().port}`,
    workspace: '/tmp/proj-w',
    agentPreset: 'standard',
    replyTimeoutMs,
    replyMaxChars: 9000,
    defaultSessionPolicy: policy,
    defaultSessionIdleMinutes: idleMinutes,
    bot: BOT,
    appSecret: 's3cret',
    record: null,
    larkSdk: sdk,
    helpers: makeHelpers(bag),
  })

  const dispatcher = captured[0]
  texts.forEach((text, i) => dispatcher['im.message.receive_v1'](makeEvent(text, 'om_in_' + (i + 1))))
  // 只数**入站**记账：每条入站除了 'feishu-inbound' 还会为回帖写 'feishu-outbound-reply'，
  // 按 mappings.length 等会被第一条消息的回帖提前满足（测试竞态）。
  const inbound = () => bag.mappings.filter((m) => m.source === 'feishu-inbound')
  await until(() => inbound().length >= texts.length, `${texts.length} inbound mappings recorded`)

  await closeServer(server)
  return { bag, state }
}

/** 只看**入站**记账：回帖/总结也会写 reply-map（source=feishu-outbound-reply）。 */
const inboundOf = (bag) => bag.mappings.filter((m) => m.source === 'feishu-inbound')
const sessionIdsOf = (bag) => inboundOf(bag).map((m) => m.sessionId)

test('fresh（默认）：不引用会话时每条消息各自新建会话，绝不复用固定会话', async () => {
  const { bag, state } = await drive({
    texts: ['第一件事', '第二件事', '第三件事'],
    policy: 'fresh',
    // 故意预置一个「固定会话」：fresh 必须无视它，否则修复等于没生效
    botState: { version: 1, sessions: { [P2P_KEY]: 'session-fixed' }, seenMessageIds: [] },
  })

  assert.deepEqual(state.createdIds, ['session-new-1', 'session-new-2', 'session-new-3'],
    '每条入站消息都新建了一个会话')
  const ids = sessionIdsOf(bag)
  assert.equal(new Set(ids).size, 3, '三条消息落在三个不同会话')
  assert.ok(!ids.includes('session-fixed'), '未复用预置的固定会话')
  // 回帖（feishu-outbound-reply）也记账，且必须落在同一个新建会话上 ——
  // 这正是「引用机器人的回答就能继续那段上下文」的依据。
  assert.ok(bag.mappings.every((m) => ids.includes(m.sessionId)),
    '回帖记账也指向同一批新会话')
  assert.ok(bag.mappings.some((m) => m.source === 'feishu-outbound-reply'))
})

test('fixed：保留旧行为，未引用会话时复用同一固定会话', async () => {
  const { bag, state } = await drive({
    texts: ['第一件事', '第二件事', '第三件事'],
    policy: 'fixed',
    botState: { version: 1, sessions: { [P2P_KEY]: 'session-fixed' }, seenMessageIds: [] },
  })

  assert.deepEqual(state.createdIds, [], '复用已有会话时不新建')
  assert.deepEqual(new Set(sessionIdsOf(bag)), new Set(['session-fixed']))
})

test('fixed：会话不存在时才新建', async () => {
  const { bag, state } = await drive({
    texts: ['开始吧'],
    policy: 'fixed',
    botState: { version: 1, sessions: {}, seenMessageIds: [] },
  })
  assert.deepEqual(state.createdIds, ['session-new-1'])
  assert.deepEqual(sessionIdsOf(bag), ['session-new-1'])
})

test('idle：闲置时间未超阈值则延续同一会话', async () => {
  const { bag, state } = await drive({
    texts: ['接着说', '继续'],
    policy: 'idle',
    idleMinutes: 30,
    botState: {
      version: 1,
      sessions: { [P2P_KEY]: 'session-fixed' },
      sessionMeta: { [P2P_KEY]: { sessionId: 'session-fixed', lastUsedAt: Date.now() } },
      seenMessageIds: [],
    },
  })

  assert.deepEqual(state.createdIds, [], '未超阈值不新建')
  assert.deepEqual(new Set(sessionIdsOf(bag)), new Set(['session-fixed']))
})

test('idle：闲置超过阈值则新建会话（上下文膨胀的边界就在这里）', async () => {
  const stale = Date.now() - 31 * 60_000
  const { bag, state } = await drive({
    texts: ['隔了很久又来说'],
    policy: 'idle',
    idleMinutes: 30,
    botState: {
      version: 1,
      sessions: { [P2P_KEY]: 'session-fixed' },
      sessionMeta: { [P2P_KEY]: { sessionId: 'session-fixed', lastUsedAt: stale } },
      seenMessageIds: [],
    },
  })

  assert.deepEqual(state.createdIds, ['session-new-1'])
  assert.deepEqual(sessionIdsOf(bag), ['session-new-1'])
})

test('未知策略名收敛为 fresh，而不是静默沿用固定会话', async () => {
  const { bag } = await drive({
    texts: ['一', '二'],
    policy: 'typo-freshh',
    botState: { version: 1, sessions: { [P2P_KEY]: 'session-fixed' }, seenMessageIds: [] },
  })
  assert.equal(new Set(sessionIdsOf(bag)).size, 2)
})

test('fresh 仍会持久化「最近一次」会话，便于回退 fixed 与排障', async () => {
  const { bag } = await drive({
    texts: ['一', '二'],
    policy: 'fresh',
    botState: { version: 1, sessions: {}, seenMessageIds: [] },
  })
  assert.equal(bag.botState.sessions[P2P_KEY], 'session-new-2', '记住最新一次')
  assert.ok(bag.botState.sessionMeta[P2P_KEY].lastUsedAt > 0, '同时写了 idle 判空闲用的时间戳')
})

test('已被引用的消息仍然精确路由到 reply-map 指向的会话（引用路径不受策略影响）', async () => {
  const bag = { mappings: [], botState: { version: 1, sessions: { [P2P_KEY]: 'session-fixed' }, seenMessageIds: [] } }
  const state = { created: 0, createdIds: [], promptRpcId: null, prompts: [] }
  const server = makeRpcServer(state)
  await listen(server.listen(0, '127.0.0.1'))

  const sdk = makeFakeLark({ id: 0 })
  const captured = []
  const origStart = sdk.WSClient.prototype.start
  sdk.WSClient.prototype.start = async function (opts) { captured.push(opts.eventDispatcher); return origStart.call(this, opts) }

  const helpers = makeHelpers(bag)
  helpers.lookupReplyMapping = (id) => (id === 'om_summary' ? { sessionId: 'session-quoted', turn: 3 } : null)

  await startInboundForBot({
    origin: `http://127.0.0.1:${server.address().port}`,
    workspace: '/tmp/proj-w', agentPreset: 'standard',
    replyTimeoutMs: 3000, replyMaxChars: 9000,
    defaultSessionPolicy: 'fresh', defaultSessionIdleMinutes: 30,
    bot: BOT, appSecret: 's3cret', record: null, larkSdk: sdk, helpers,
  })

  const event = makeEvent('引用那条总结继续问', 'om_in_quoted')
  event.message.parent_id = 'om_summary'
  captured[0]['im.message.receive_v1'](event)
  await until(() => inboundOf(bag).length >= 1, 'quoted inbound mapping')

  const recorded = inboundOf(bag)[0]
  assert.deepEqual(state.createdIds, [], '引用命中的会话存在时不新建')
  assert.equal(recorded.sessionId, 'session-quoted')
  assert.equal(recorded.turn, 3)

  await closeServer(server)
})
