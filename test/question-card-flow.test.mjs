/**
 * 提问卡片化集成测试（第 2–5 步）：
 *   卡片优先发送 + 发卡失败回退纯文本；
 *   卡片回传作答（answer / custom / skip，含跳过=跳单题）；
 *   过期卡片与未知 rpcId 只回提示不动作；
 *   网页端先答 → im.message.patch 刷已答态；
 *   回滚时把卡片退回待答态。
 *
 * 全部用注入式假 WebSocket + 桩 postToSession/postCardToSession/patchCard，
 * 不触网。文本回帖那条路的行为由 question-bridge.test.mjs 继续锁住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createQuestionBridge } from '../lib/host/question-bridge.js'

async function until(fn, what = 'condition', ms = 2000) {
  const deadline = Date.now() + ms
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for ' + what)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const QUESTION = {
  id: 'qq1',
  question: '用哪种方式部署？',
  header: '部署',
  options: [{ label: 'Docker' }, { label: '裸机' }],
}

function makeFakeMux() {
  const state = { sockets: [], responds: [] }
  function openSocket(_url, handlers) {
    const sock = {
      handlers,
      closed: false,
      deliver(rpcId, payload) {
        handlers.onFrame(JSON.stringify({ type: 'server-request', rpcId, method: payload.type, payload }))
      },
      close() { this.closed = true; handlers.onClose() },
    }
    state.sockets.push(sock)
    queueMicrotask(() => handlers.onOpen())
    return sock
  }
  async function respondImpl(message) {
    state.responds.push(message)
    return { accepted: true }
  }
  return { openSocket, state, respondImpl }
}

function makeBridge({ mux, posts, cards, patches, cardFails = false, patchFails = false, log = () => {} }) {
  const bridge = createQuestionBridge({
    origin: 'http://127.0.0.1:1',
    log,
    openSocket: mux.openSocket,
    latestThreadLookup: (sessionId) => (sessionId === 'session-fixed' ? 'thread_root_1' : null),
    recordReplyMapping: () => {},
    postToSession: async (text, sessionId, parentMessageId, meta = {}) => {
      await new Promise((r) => setImmediate(r))
      posts.push({ text, sessionId, parentMessageId })
      if (parentMessageId === 'thread_root_1') { meta.rootId = 'thread_root_1'; meta.parentId = 'thread_root_1' }
      return { messageId: 'tmsg_' + posts.length }
    },
    postCardToSession: async (card, sessionId, parentMessageId, meta = {}) => {
      await new Promise((r) => setImmediate(r))
      if (cardFails) {
        const err = new Error('feishu im/v1/messages(card) 400: {"code":230025}')
        err.feishuCode = 230025
        throw err
      }
      cards.push({ card, sessionId, parentMessageId })
      if (parentMessageId === 'thread_root_1') { meta.rootId = 'thread_root_1'; meta.parentId = 'thread_root_1' }
      return { messageId: 'cmsg_' + cards.length }
    },
    patchCard: async (messageId, card) => {
      if (patchFails) throw new Error('feishu im/v1/messages(patch) 400: {"code":230025}')
      patches.push({ messageId, card })
    },
  })
  bridge.__setRespondForTest(mux.respondImpl)
  return bridge
}

function harness(over = {}) {
  const mux = makeFakeMux()
  const posts = []
  const cards = []
  const patches = []
  const bridge = makeBridge({ mux, posts, cards, patches, ...over })
  return { mux, posts, cards, patches, bridge }
}

// ── 第 2 步：发卡优先 + 失败回退 ───────────────────────────────────────────

test('提问优先以交互卡片发出（选项即按钮），有卡片就不再发纯文本', async () => {
  const { mux, posts, cards, bridge } = harness()
  mux.state.sockets[0].deliver('rq_c1', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => cards.length === 1, 'card post')
  assert.equal(posts.length, 0, '发卡成功后不应再发纯文本')
  assert.equal(cards[0].parentMessageId, 'thread_root_1', '首题应接该会话最近线程')
  const json = JSON.stringify(cards[0].card)
  assert.ok(json.includes('"kind":"answer"'), '卡片应带选项回传')
  assert.equal(cards[0].card.config.update_multi, true, '共享卡片才允许事后 patch')
  assert.equal(bridge.__pendingCount(), 1)
  bridge.close()
})

test('卡片发不出去 → 自动回退纯文本，且该批次仍可正常作答', async () => {
  const { mux, posts, cards, bridge } = harness({ cardFails: true })
  mux.state.sockets[0].deliver('rq_c2', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => posts.length === 1, 'text fallback')
  assert.equal(cards.length, 0)
  assert.match(posts[0].text, /1\. Docker/)
  assert.equal(bridge.__pendingCount(), 1)

  const consumed = await bridge.interceptReply({
    parentMessageId: 'tmsg_1', rootMessageId: null, messageId: 'u1', text: '1',
  })
  assert.equal(consumed, true)
  await until(() => mux.state.responds.length === 1, 'answer via text')
  assert.deepEqual(mux.state.responds[0].result.value.answer.answers, [
    { id: 'qq1', selected: ['Docker'] },
  ])
  bridge.close()
})

test('多选与超量选项不发卡片（构造器返回 null）→ 回退纯文本', async () => {
  for (const question of [
    { ...QUESTION, multiSelect: true },
    { ...QUESTION, options: Array.from({ length: 6 }, (_, i) => ({ label: 'o' + i })) },
  ]) {
    const { mux, posts, cards, bridge } = harness()
    mux.state.sockets[0].deliver('rq_c3', {
      type: 'question/requested', sessionId: 'session-fixed', questions: [question],
    })
    await until(() => posts.length === 1, 'text fallback for unsupported shape')
    assert.equal(cards.length, 0)
    bridge.close()
  }
})

// ── 第 3 步：卡片作答 ─────────────────────────────────────────────────────

test('卡片点选选项 → 提交作答，并回一张已答态卡片（方式一：立即更新）', async () => {
  const { mux, cards, bridge } = harness()
  mux.state.sockets[0].deliver('rq_c4', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => cards.length === 1, 'card post')

  const res = await bridge.handleCardAction({
    rpcId: 'rq_c4', questionId: 'qq1', kind: 'answer', option: '裸机', optionIndex: 1, messageId: 'cmsg_1',
  })
  assert.equal(res.toast.type, 'success')
  assert.match(res.toast.content, /已选择：裸机/)
  assert.equal(res.card.header.template, 'green')
  assert.equal(res.card.config.update_multi, true)
  const painted = JSON.stringify(res.card)
  assert.ok(painted.includes('✓ 裸机'), '选中项应打勾高亮')
  assert.ok(painted.includes('已选择：裸机'))

  await until(() => mux.state.responds.length === 1, 'respond')
  assert.deepEqual(mux.state.responds[0], {
    rpcId: 'rq_c4',
    result: {
      ok: true,
      value: { sessionId: 'session-fixed', answer: { answers: [{ id: 'qq1', selected: ['裸机'] }] } },
    },
  })
  await until(() => bridge.__pendingCount() === 0, 'batch cleared')
  bridge.close()
})

test('卡片自定义输入 → custom 作答（form_value 那条路）', async () => {
  const { mux, cards, bridge } = harness()
  mux.state.sockets[0].deliver('rq_c5', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => cards.length === 1, 'card post')

  const res = await bridge.handleCardAction({
    rpcId: 'rq_c5', questionId: 'qq1', kind: 'custom', customText: 'a.example.com', messageId: 'cmsg_1',
  })
  assert.match(res.toast.content, /已提交自定义答案/)
  assert.ok(JSON.stringify(res.card).includes('a.example.com'))

  await until(() => mux.state.responds.length === 1, 'respond')
  assert.deepEqual(mux.state.responds[0].result.value.answer.answers, [
    { id: 'qq1', selected: [], custom: 'a.example.com' },
  ])
  bridge.close()
})

test('卡片自定义输入为空 → 不提交，只回提示', async () => {
  const { mux, cards, bridge } = harness()
  mux.state.sockets[0].deliver('rq_c6', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => cards.length === 1, 'card post')

  const res = await bridge.handleCardAction({
    rpcId: 'rq_c6', questionId: 'qq1', kind: 'custom', customText: '   ', messageId: 'cmsg_1',
  })
  assert.equal(res.card, null)
  assert.equal(res.toast.type, 'warning')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(mux.state.responds.length, 0)
  assert.equal(bridge.__pendingCount(), 1, '批次仍活着，等用户真的作答')
  bridge.close()
})

test('卡片「跳过本次提问」= 跳单题（空 selected），不是取消整批', async () => {
  const { mux, cards, bridge } = harness()
  mux.state.sockets[0].deliver('rq_c7', {
    type: 'question/requested',
    sessionId: 'session-fixed',
    questions: [QUESTION, { ...QUESTION, id: 'qq2', header: '域名' }],
  })
  await until(() => cards.length === 1, 'first card')

  const res = await bridge.handleCardAction({
    rpcId: 'rq_c7', questionId: 'qq1', kind: 'skip', messageId: 'cmsg_1',
  })
  assert.equal(res.toast.type, 'warning')
  assert.match(res.toast.content, /已跳过本题/)
  assert.equal(res.card.header.template, 'grey')
  assert.ok(JSON.stringify(res.card).includes('已跳过本次提问'))

  // 跳第 1 题 → 继续问第 2 题；不产生取消、也不提交
  await until(() => cards.length === 2, 'second card')
  assert.equal(mux.state.responds.length, 0, '跳单题不应产生取消或提交')

  await bridge.handleCardAction({
    rpcId: 'rq_c7', questionId: 'qq2', kind: 'answer', option: 'Docker', optionIndex: 0, messageId: 'cmsg_2',
  })
  await until(() => mux.state.responds.length === 1, 'submit after second answer')
  assert.deepEqual(mux.state.responds[0].result.value.answer.answers, [
    { id: 'qq1', selected: [] },
    { id: 'qq2', selected: ['Docker'] },
  ])
  bridge.close()
})

test('过期卡片（questionId 不匹配）与未知 rpcId 只回提示、不动作', async () => {
  const { mux, cards, bridge } = harness()
  mux.state.sockets[0].deliver('rq_c8', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => cards.length === 1, 'card post')

  const stale = await bridge.handleCardAction({
    rpcId: 'rq_c8', questionId: 'old-question', kind: 'answer', option: 'Docker', messageId: 'cmsg_1',
  })
  assert.equal(stale.card, null)
  assert.match(stale.toast.content, /已过期/)

  const unknown = await bridge.handleCardAction({
    rpcId: 'no-such-rpc', questionId: 'qq1', kind: 'answer', option: 'Docker',
  })
  assert.equal(unknown.card, null)
  assert.match(unknown.toast.content, /已结束/)

  // 伪造的选项（不在本题选项里）同样拒绝
  const forged = await bridge.handleCardAction({
    rpcId: 'rq_c8', questionId: 'qq1', kind: 'answer', option: '不存在的选项', messageId: 'cmsg_1',
  })
  assert.equal(forged.card, null)

  await new Promise((r) => setTimeout(r, 30))
  assert.equal(mux.state.responds.length, 0)
  assert.equal(bridge.__pendingCount(), 1)
  bridge.close()
})

// ── 第 4 步：网页端先答 → patch 卡片 ──────────────────────────────────────

test('网页端先答 → im.message.patch 把卡片刷成「选了哪一项」', async () => {
  const { mux, cards, patches, bridge } = harness()
  mux.state.sockets[0].deliver('rq_c9', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => cards.length === 1, 'card post')

  bridge.__injectFrame({
    payload: {
      type: 'question/resolved', sessionId: 'session-fixed', questionRpcId: 'rq_c9',
      outcome: 'answered', answer: { answers: [{ id: 'qq1', selected: ['Docker'] }] },
    },
  })
  await until(() => patches.length === 1, 'card patched')
  assert.equal(patches[0].messageId, 'cmsg_1', '应 patch 那一轮卡片的消息 id')
  assert.equal(patches[0].card.header.template, 'green')
  const painted = JSON.stringify(patches[0].card)
  assert.ok(painted.includes('✓ Docker'), '应显示网页端选中的那一项')
  assert.ok(painted.includes('已选择：Docker'))
  await until(() => bridge.__pendingCount() === 0, 'batch cleared')
  bridge.close()
})

test('网页端先答且带了自定义文本 → 卡片显示自定义答案', async () => {
  const { mux, cards, patches, bridge } = harness()
  mux.state.sockets[0].deliver('rq_c10', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => cards.length === 1, 'card post')

  bridge.__injectFrame({
    payload: {
      type: 'question/resolved', sessionId: 'session-fixed', questionRpcId: 'rq_c10',
      outcome: 'answered', answer: { answers: [{ id: 'qq1', selected: [], custom: '先在本地试' }] },
    },
  })
  await until(() => patches.length === 1, 'card patched')
  assert.ok(JSON.stringify(patches[0].card).includes('先在本地试'))
  bridge.close()
})

test('纯文本回退发出的那一轮不会被 patch（不是卡片，PATCH 必然失败）', async () => {
  const { mux, posts, patches, bridge } = harness({ cardFails: true })
  mux.state.sockets[0].deliver('rq_c11', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => posts.length === 1, 'text post')

  bridge.__injectFrame({
    payload: {
      type: 'question/resolved', sessionId: 'session-fixed', questionRpcId: 'rq_c11',
      outcome: 'answered', answer: { answers: [{ id: 'qq1', selected: ['Docker'] }] },
    },
  })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(patches.length, 0)
  bridge.close()
})

test('取消结算不 patch 卡片（只回取消说明）', async () => {
  const { mux, cards, patches, bridge } = harness()
  mux.state.sockets[0].deliver('rq_c12', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => cards.length === 1, 'card post')

  bridge.__injectFrame({
    payload: { type: 'question/resolved', sessionId: 'session-fixed', questionRpcId: 'rq_c12', outcome: 'cancelled' },
  })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(patches.length, 0)
  bridge.close()
})

// ── 失败路径：回滚要把卡片退回待答态 ──────────────────────────────────────

test('提交被回滚（bad-response）→ 卡片退回待答态，避免「界面说答了实际没提交」', async () => {
  const { mux, cards, patches, bridge } = harness()
  mux.state.sockets[0].deliver('rq_c13', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => cards.length === 1, 'card post')

  bridge.__setRespondForTest(async () => ({
    receipt: { accepted: false, reason: 'bad-response' }, retried: false,
  }))
  const res = await bridge.handleCardAction({
    rpcId: 'rq_c13', questionId: 'qq1', kind: 'answer', option: 'Docker', optionIndex: 0, messageId: 'cmsg_1',
  })
  // 响应是乐观的（3 秒约束），已答态
  assert.match(res.toast.content, /已选择：Docker/)

  await until(() => patches.length === 1, 'rollback patch')
  assert.equal(patches[0].messageId, 'cmsg_1')
  assert.equal(patches[0].card.header.template, 'blue', '应退回待答态')
  assert.equal(bridge.__pendingCount(), 1, '批次仍活着，等用户重答')
  bridge.close()
})

test('卡片作答失败（respond 抛错）→ 同样退回待答态', async () => {
  const { mux, cards, patches, bridge } = harness()
  mux.state.sockets[0].deliver('rq_c14', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => cards.length === 1, 'card post')

  bridge.__setRespondForTest(async () => { throw new Error('respond HTTP 500') })
  await bridge.handleCardAction({
    rpcId: 'rq_c14', questionId: 'qq1', kind: 'answer', option: 'Docker', optionIndex: 0, messageId: 'cmsg_1',
  })
  await until(() => patches.length === 1, 'rollback patch')
  assert.equal(patches[0].card.header.template, 'blue')
  bridge.close()
})

test('patch 自身失败不影响作答（只留日志）', async () => {
  const warnings = []
  const { mux, cards, bridge } = harness({
    patchFails: true,
    log: (level, ...a) => { if (level === 'warn') warnings.push(a.join(' ')) },
  })
  mux.state.sockets[0].deliver('rq_c15', {
    type: 'question/requested', sessionId: 'session-fixed', questions: [QUESTION],
  })
  await until(() => cards.length === 1, 'card post')

  // 触发一次回滚 → 桥会尝试把卡片退回待答态，而这次 patch 注定失败
  bridge.__setRespondForTest(async () => ({
    receipt: { accepted: false, reason: 'bad-response' }, retried: false,
  }))
  await bridge.handleCardAction({
    rpcId: 'rq_c15', questionId: 'qq1', kind: 'answer', option: 'Docker', optionIndex: 0, messageId: 'cmsg_1',
  })
  await until(() => warnings.some((w) => w.includes('卡片退回待答态失败')), 'patch failure warned')
  assert.equal(bridge.__pendingCount(), 1, 'patch 失败不应改变批次状态')
  bridge.close()
})
