/**
 * 端到端组合回归：**真实**入站处理器 → **真实**提问桥 → **真实**卡片构造器。
 *
 * 另外两个测试文件各自只覆盖一半（桥用假 postCard；处理器用假 handler），
 * 这个文件把三段接起来，确认：
 *   question/requested → 飞书收到真的提问卡片
 *   → card.action.trigger（真事件形状）→ 桥状态机提交作答
 *   → 回调响应里是**真实构造出来的已答态卡片**（含题面与选中项）
 * 这条路径是"卡片能点、点了真能答"的最小完整证据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { startInboundForBot } from '../lib/host/inbound-runtime.js'
import { createQuestionBridge } from '../lib/host/question-bridge.js'

async function until(fn, what = 'condition', ms = 3000) {
  const deadline = Date.now() + ms
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for ' + what)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function makeFakeLark() {
  const dispatchers = []
  class EventDispatcher {
    register(handlers) { Object.assign(this, handlers); return this }
  }
  class WSClient {
    async start({ eventDispatcher }) { dispatchers.push(eventDispatcher) }
    close() { /* noop */ }
  }
  class Client {
    im = {
      v1: {
        message: { create: async () => ({ data: {} }), reply: async () => ({ data: {} }) },
        messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) },
      },
    }
  }
  return { Domain: { Feishu: 'feishu', Lark: 'lark' }, LoggerLevel: { info: 'info' }, EventDispatcher, WSClient, Client, __dispatchers: dispatchers }
}

const QUESTION = {
  id: 'qq1',
  question: '用哪种方式部署？',
  header: '部署',
  options: [{ label: 'Docker' }, { label: '裸机' }],
}

test('端到端：问题 → 卡片 → 点击按钮 → 回调响应就是已答态卡片，且作答已提交', async () => {
  // ── 假 mux：把 question/requested 帧喂进真实提问桥 ──
  const sockets = []
  const openSocket = (_url, handlers) => {
    const sock = {
      deliver(rpcId, payload) {
        handlers.onFrame(JSON.stringify({ type: 'server-request', rpcId, method: payload.type, payload }))
      },
      close() { handlers.onClose() },
    }
    sockets.push(sock)
    queueMicrotask(() => handlers.onOpen())
    return sock
  }

  const posts = []
  const cards = []
  const patches = []
  const responds = []

  const bridge = createQuestionBridge({
    origin: 'http://127.0.0.1:1',
    log: () => {},
    openSocket,
    latestThreadLookup: () => null,
    recordReplyMapping: () => {},
    postToSession: async (text) => { posts.push(text); return { messageId: 'tmsg_' + posts.length } },
    postCardToSession: async (card) => { cards.push(card); return { messageId: 'cmsg_' + cards.length } },
    patchCard: async (messageId, card) => { patches.push({ messageId, card }) },
  })
  bridge.__setRespondForTest(async (message) => { responds.push(message); return { accepted: true } })

  // ── 真入站运行时，卡片作答交给真桥 ──
  const larkSdk = makeFakeLark()
  const warnings = []
  await startInboundForBot({
    origin: 'http://127.0.0.1:1',
    workspace: '/tmp/proj-w',
    agentPreset: 'standard',
    replyTimeoutMs: 1000,
    replyMaxChars: 9000,
    bot: { id: 'bot_x', appId: 'cli_a', secretRef: 'ref', botName: '测试机器人' },
    appSecret: 's3cret',
    record: null,
    larkSdk,
    helpers: {
      log: (level, ...a) => { if (level === 'warn') warnings.push(a.join(' ')) },
      debugLog: () => {},
      lookupReplyMapping: () => null,
      recordReplyMapping: () => {},
      readBotState: () => ({ version: 1, sessions: {}, seenMessageIds: [] }),
      writeBotState: () => {},
      handleCardAction: bridge.handleCardAction,
    },
  })
  const dispatcher = larkSdk.__dispatchers[0]

  // ① 问题到达 → 真的发出交互卡片
  sockets[0].deliver('rq_e2e', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => bridge.__pendingCount() === 1, 'question card posted and batch live')
  assert.equal(posts.length, 0, '有卡片就不该再发纯文本兜底')
  assert.ok(JSON.stringify(cards[0]).includes('用哪种方式部署？'))

  // ② 用户点「Docker」→ 走真实事件形状进处理器
  const out = await dispatcher['card.action.trigger']({
    operator: { open_id: 'ou_u1' },
    action: {
      tag: 'button',
      value: { rpcId: 'rq_e2e', questionId: 'qq1', kind: 'answer', option: 'Docker', optionIndex: 0 },
    },
    context: { open_message_id: 'cmsg_1', open_chat_id: 'oc_1' },
  })

  // ③ 回调响应必须是合法的方式一信封，且卡片是真实构造的已答态
  assert.equal(out.toast.type, 'success')
  assert.match(out.toast.content, /已选择：Docker/)
  assert.equal(out.card.type, 'raw')
  assert.equal(out.card.data.schema, '2.0')
  assert.equal(out.card.data.header.template, 'green')
  const painted = JSON.stringify(out.card.data)
  assert.ok(painted.includes('用哪种方式部署？'), '已答态卡片应保留题面')
  assert.ok(painted.includes('✓ Docker'), '选中项应打勾高亮')
  assert.ok(painted.includes('已选择：Docker'))
  assert.equal(out.card.data.config.update_multi, true, '共享卡片才允许事后 patch')

  // ④ 状态机真的提交了作答
  await until(() => responds.length === 1, 'answer submitted')
  assert.deepEqual(responds[0], {
    rpcId: 'rq_e2e',
    result: {
      ok: true,
      value: { sessionId: 'session-fixed', answer: { answers: [{ id: 'qq1', selected: ['Docker'] }] } },
    },
  })
  await until(() => bridge.__pendingCount() === 0, 'batch settled')
  assert.equal(warnings.length, 0, '正常路径不应有告警')
  bridge.close()
})

test('端到端：网页端先答 → 已发出的卡片被原地 patch 成已答态', async () => {
  const sockets = []
  const openSocket = (_url, handlers) => {
    const sock = {
      deliver(rpcId, payload) {
        handlers.onFrame(JSON.stringify({ type: 'server-request', rpcId, method: payload.type, payload }))
      },
      close() { handlers.onClose() },
    }
    sockets.push(sock)
    queueMicrotask(() => handlers.onOpen())
    return sock
  }
  const cards = []
  const patches = []
  const bridge = createQuestionBridge({
    origin: 'http://127.0.0.1:1',
    log: () => {},
    openSocket,
    latestThreadLookup: () => null,
    recordReplyMapping: () => {},
    postToSession: async () => ({ messageId: 'tmsg_1' }),
    postCardToSession: async (card) => { cards.push(card); return { messageId: 'cmsg_1' } },
    patchCard: async (messageId, card) => { patches.push({ messageId, card }) },
  })

  sockets[0].deliver('rq_e2e2', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => cards.length === 1, 'question card posted')

  // 网页端作答 → 宿主接缝注入 question/resolved（带 answer，第 5 步补的字段）
  bridge.__injectFrame({
    payload: {
      type: 'question/resolved',
      sessionId: 'session-fixed',
      questionRpcId: 'rq_e2e2',
      outcome: 'answered',
      answer: { answers: [{ id: 'qq1', selected: ['裸机'] }] },
    },
  })
  await until(() => patches.length === 1, 'card patched in place')
  assert.equal(patches[0].messageId, 'cmsg_1')
  const painted = JSON.stringify(patches[0].card)
  assert.ok(painted.includes('✓ 裸机'), '应显示网页端选的那一项')
  assert.ok(painted.includes('用哪种方式部署？'))
  assert.equal(patches[0].card.header.template, 'green')
  // 不删除原卡片、不发新卡片：就是"原地更新"
  assert.equal(cards.length, 1)
  bridge.close()
})
