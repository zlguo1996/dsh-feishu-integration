/**
 * 出站投递的信息架构：**卡片 = 飞书原生话题根消息，完整回复 = 线程回复**。
 *
 * 契约（Codex FINAL 修订版）：
 * - 根消息先记账（reply-map），再投线程分段；首条必须 `reply_in_thread: true`；
 * - 每个分段各用自己的幂等 uuid（独立 deliveryUuid + 序号），绝不复用根的 uuid；
 * - 每个分段都写 reply-map（嵌套回复也能路由回同一会话）；
 * - 根失败/无 message_id/分段失败：保留根、不重发根，落线程死信；
 * - 唯一允许折叠面板的路径是「线程能力不可用」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installSummaryPush } from '../lib/host/summary-service.js'

const REPLY = '## 结论\n\n打包 3114176 成功 ✅\n\n- 要点甲\n- 要点乙\n'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error('waitFor 超时')
}

function makeSession({ id = 'session-1', cwd = '/tmp/w', events = null } = {}) {
  const evts = events ?? [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '帮我打包' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: REPLY }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return { id, header: { cwd }, snapshotEvents: () => evts }
}

/** 每个用例一个临时目录（死信落盘）+ 假飞书 API + 同步的假重试层。 */
function withHarness(fn, { deps: depOverrides = {}, deadLetter = true, cardResult = 'om_root_card' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-thread-'))
  const deadPath = deadLetter ? join(dir, 'pending-summaries.jsonl') : null
  const calls = { card: [], text: [], reply: [], replyText: [], mappings: [], digests: [] }
  // 卡片「尝试」单独记：覆盖 sendCardMessage 被拒的用例里 calls.card 会保持为空。
  const cardAttempts = []
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
      cardAttempts.push({ card, opts })
      if (cardResult instanceof Error) throw cardResult
      calls.card.push({ card, opts })
      return cardResult
    },
    sendTextMessage: async (creds, text, opts) => { calls.text.push({ text, opts }); return 'om_root_text' },
    // ⚠️ 必须与 feishu-api 的真实签名一致：`(creds, text/card, opts)`，**messageId 在 creds 里**。
    // 之前这个 mock 写成 `(creds, messageId, text, opts)`，与实现犯的是同一个错，于是单测
    // 全绿而线上 400 `Invalid ids: [undefined]`、线程永远不出现（2026-09-24 实测）。
    replyTextMessage: async (creds, text, opts) => {
      calls.replyText.push({ creds, text, opts })
      return 'om_textreply_' + calls.replyText.length
    },
    // 完整回复走**卡片**回帖：飞书纯文本不渲染 Markdown（`**加粗**` 会显示成星号）。
    replyCardMessage: async (creds, card, opts) => {
      calls.reply.push({ creds, card, opts })
      return 'om_reply_' + calls.reply.length
    },
    recordReplyMapping: (id, meta) => calls.mappings.push({ id, meta }),
    recordDigest: (r) => calls.digests.push(r),
    readDigestHistory: () => [],
    deadLetterPath: deadPath,
    formatDigest: async () => ({
      title: '打包 3114176', summary: '打包成功', bullets: ['要点甲'], via: 'llm',
      inputStats: { priorUsed: 0, priorDropped: 0, inputBytes: 100 },
    }),
    resilientSender: {
      sendWithRetry: async (fn) => {
        try { return { ok: true, value: await fn() } } catch (err) { return { ok: false, error: err } }
      },
    },
    log: () => {},
    ...depOverrides,
  }
  const handlers = []
  const ctx = { on: (name, fn) => { handlers.push({ name, fn }) } }
  const api = installSummaryPush(ctx, deps)
  const emit = (session, event) => handlers[0].fn(session, event)
  const dead = () => {
    if (!deadPath) return []
    try {
      return readFileSync(deadPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch { return [] }
  }
  const panelOf = (card) => card.body.elements.find((e) => e.tag === 'collapsible_panel')
  const markdownsOf = (card) => card.body.elements.filter((e) => e.tag === 'markdown').map((e) => e.content)
  return Promise.resolve(fn({ calls, emit, api, dead, panelOf, markdownsOf, cardAttempts, dir }))
    .finally(() => rmSync(dir, { recursive: true, force: true }))
}

const TURN_END = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }

test('正常路径：卡片作话题根（无面板，元信息只 turn/cwd），完整回复作首个线程回复', () => withHarness(async ({ calls, emit, panelOf, markdownsOf }) => {
  emit(makeSession(), TURN_END)
  await waitFor(() => calls.reply.length === 1)

  assert.equal(calls.card.length, 1, '根消息应是卡片')
  const card = calls.card[0].card
  assert.equal(card.header.title.content, '打包 3114176', '头部标题来自 formatter 的主题')
  assert.equal(panelOf(card), undefined, '正常路径不得出现折叠面板')
  assert.equal(markdownsOf(card)[0], '打包成功', '摘要必须在卡片里可见')
  assert.equal(markdownsOf(card).pop(), 'turn 1 · cwd: /tmp/w', '元信息只有 turn 与 cwd')
  assert.ok(!JSON.stringify(card).includes('要点乙'), '正文不得进卡片')

  // 根的记账发生在投线程之前
  assert.deepEqual(calls.mappings[0], {
    id: 'om_root_card', meta: { sessionId: 'session-1', turn: 1, ts: calls.mappings[0].meta.ts },
  })

  // 线程回复：挂在根下、首条带 reply_in_thread、完整回复原文、独立 uuid
  const first = calls.reply[0]
  assert.equal(first.creds.messageId, 'om_root_card', 'messageId 必须在 creds 里（真实签名）')
  // 必须是**卡片**回复：飞书纯文本消息不渲染 Markdown（`**加粗**` 会显示成星号），
  // 只有卡片的 markdown 组件会渲染（2026-09-24 实测对照）。
  assert.equal(first.card.schema, '2.0')
  assert.equal(first.card.body.elements[0].tag, 'markdown')
  assert.equal(first.card.body.elements[0].content, REPLY, '线程里必须是完整回复原文（不截断、不摘要、不改写）')
  assert.equal(first.card.header, undefined, '单分段不加索引头')
  assert.equal(first.opts.replyInThread, true, '首条必须带 reply_in_thread 才会创建原生话题')
  assert.match(first.opts.uuid, /-c0$/)
  assert.notEqual(first.opts.uuid, calls.card[0].opts.uuid, '绝不复用根的幂等 uuid')

  // 分段也要记账，嵌套回复才能路由回同一会话
  assert.deepEqual(calls.mappings[1].id, 'om_reply_1')
  assert.equal(calls.mappings[1].meta.sessionId, 'session-1')

  // 摘要先落 digest-history
  assert.deepEqual(calls.digests, [{ sessionId: 'session-1', turn: 1, summary: '打包成功' }])
}))

test('按卡片字节预算切段：多段各自成卡、uuid 递增、内容逐字不丢、多段才加索引头', () => withHarness(async ({ calls, emit }) => {
  // 用一条**长**回复逼出多段：卡片有 30KB 硬上限，分段必须按字节而不是按字符。
  const longReply = [
    '## 结论', '',
    '**卡片有硬性容量与折叠成本**，所以完整回复走话题线程。', '',
    ...Array.from({ length: 40 }, (_, i) => `- 第 ${i + 1} 条说明文字，用来把卡片撑到需要多段`),
    '', '补充说明。'.repeat(60),
  ].join('\n')
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '为什么' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: longReply }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  emit(makeSession({ events }), TURN_END)
  await waitFor(() => calls.reply.length > 1)
  const total = calls.reply.length
  assert.ok(total > 1, '预算压到 900 字节应当切成多段')
  const joined = calls.reply.map((r) => r.card.body.elements[0].content).join('')
  assert.equal(joined, longReply, '分段拼接后必须与原文逐字相同')
  calls.reply.forEach((r, i) => {
    assert.equal(r.opts.replyInThread, true)
    assert.match(r.opts.uuid, new RegExp(`-c${i}$`))
    assert.equal(r.creds.messageId, 'om_root_card')
    assert.equal(r.card.header.title.content, `完整回复 ${i + 1}/${total}`, '多分段才加索引头')
    assert.ok(Buffer.byteLength(JSON.stringify(r.card), 'utf8') <= 900, '每段卡片都不超预算')
    assert.equal(calls.mappings[i + 1].id, `om_reply_${i + 1}`, '每段都要记账')
  })
}, { deps: { threadByteBudget: 900 } }))

test('formatter 收到本回合提问与「最近 5 条」历史项（历史缺失的总结不补造）', () => withHarness(async ({ calls, emit }) => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '旧问题' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: '旧回复' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '新问题' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 2, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: REPLY }] } } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  emit(makeSession({ events }), { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await waitFor(() => calls.reply.length === 1)
}, {
  deps: {
    readDigestHistory: () => [{ turn: 1, summary: '旧摘要' }],
    formatDigest: async (reply, opts) => {
      assert.equal(opts.question, '新问题', '本回合提问取自 session 事件（source.kind=user）')
      assert.deepEqual(opts.priorItems, [
        { turn: 1, kind: 'user', text: '旧问题' },
        { turn: 1, kind: 'assistant_summary', text: '旧摘要' },
      ], '历史 = 旧回合的用户输入 + 当时真正产出过的总结；当前回合必须排除')
      return { title: '打包 3114176', summary: '打包成功', bullets: [], via: 'llm', inputStats: { priorUsed: 2 } }
    },
  },
}))

test('卡片确定不可发送 → 紧凑纯文本作根（复用同一幂等 uuid），然后照样建线程', () => withHarness(async ({ calls, emit, cardAttempts }) => {
  emit(makeSession(), TURN_END)
  await waitFor(() => calls.reply.length === 1)
  assert.equal(cardAttempts.length, 1, '卡片只尝试一次，被拒后不再重试卡片')
  assert.equal(calls.text.length, 1, '回退为纯文本根消息')
  const text = calls.text[0].text
  assert.ok(text.startsWith('打包 3114176'), '纯文本根与卡片同信息架构：标题在最前')
  assert.ok(text.includes('打包成功'))
  assert.ok(text.trimEnd().endsWith('turn 1 · cwd: /tmp/w'))
  assert.ok(!text.includes('要点乙'), '纯文本根也不含正文')
  assert.equal(calls.text[0].opts.uuid, cardAttempts[0].opts.uuid, '卡片→纯文本回退复用同一 uuid，由服务端去重')
  assert.equal(calls.reply[0].creds.messageId, 'om_root_text', '线程挂在纯文本根上')
}, {
  cardResult: (() => {
    const err = new Error('Failed to create card content')
    err.feishuCode = 230099
    return err
  })(),
}))

test('根消息没有回 message_id → 不投线程，落 thread-no-root 死信，不重发根', () => withHarness(async ({ calls, emit, dead }) => {
  emit(makeSession(), TURN_END)
  await waitFor(() => dead().length > 0)
  await sleep(20)
  assert.equal(calls.reply.length, 0, '没有根 id 就无处投线程')
  assert.equal(calls.card.length, 1, '不得重发根消息')
  const entry = dead()[0]
  assert.equal(entry.kind, 'thread-no-root')
  assert.equal(entry.detail, REPLY, '完整回复落盘待查')
  assert.equal(entry.error, 'missing-message-id')
}, { cardResult: '' }))

test('线程分段重试耗尽 → 保留根与记账、剩余分段落死信、绝不重发根', () => withHarness(async ({ calls, emit, dead }) => {
  emit(makeSession(), TURN_END)
  await waitFor(() => dead().length > 0)
  await sleep(20)
  assert.equal(calls.card.length, 1, '根只发一次')
  assert.deepEqual(calls.mappings.map((m) => m.id), ['om_root_card'], '根仍保留 reply-map 记账')
  const entry = dead()[0]
  assert.equal(entry.kind, 'thread-chunk')
  assert.equal(entry.rootMessageId, 'om_root_card')
  assert.deepEqual(entry.remaining, [REPLY], '未送达的分段落盘待查')
}, {
  deps: {
    replyCardMessage: async () => { throw new Error('feishu 500') },
  },
}))

test('线程能力不可用（threadDelivery:false）→ 唯一允许的降级：正文折回卡片且不投线程', () => withHarness(async ({ calls, emit, markdownsOf }) => {
  emit(makeSession(), TURN_END)
  await waitFor(() => calls.card.length === 1)
  await sleep(20)
  assert.equal(calls.reply.length, 0, '不得投线程')
  const md = markdownsOf(calls.card[0].card)
  assert.ok(md.some((m) => m.includes('打包 3114176 成功 ✅')), '降级路径把正文放回卡片')
  assert.equal(md.pop(), 'turn 1 · cwd: /tmp/w', '元信息规则不变')
}, { deps: { threadDelivery: false } }))

test('线程不可用 + 长回复 → 正文进折叠面板（唯一允许恢复面板的路径）', () => withHarness(async ({ calls, emit, panelOf }) => {
  const longReply = ['## 结论', '', '打包 3114176 成功 ✅', '', '- 要点甲', '- 要点乙', '', '补充说明。'.repeat(120)].join('\n')
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '帮我打包' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: longReply }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  emit(makeSession({ events }), TURN_END)
  await waitFor(() => calls.card.length === 1)
  await sleep(20)
  assert.equal(calls.reply.length, 0)
  const panel = panelOf(calls.card[0].card)
  assert.ok(panel, '长正文在降级路径应折叠')
  assert.ok(panel.elements[0].content.includes('打包 3114176 成功 ✅'))
}, { deps: { threadDelivery: false } }))

test('notificationFormat:text → 纯文本根 + 仍然建线程', () => withHarness(async ({ calls, emit }) => {
  emit(makeSession(), TURN_END)
  await waitFor(() => calls.reply.length === 1)
  assert.equal(calls.card.length, 0)
  assert.equal(calls.text.length, 1)
  assert.equal(calls.reply[0].creds.messageId, 'om_root_text')
  assert.equal(calls.reply[0].card.body.elements[0].content, REPLY)
}, { deps: { notificationFormat: 'text' } }))

test('飞书回复触发的回合绝不回发总结（防乒乓）', () => withHarness(async ({ calls, emit }) => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '来自飞书' }], source: { kind: 'user', rpcId: 'fsum-rpc-1' } } },
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: REPLY }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const session = makeSession({ events })
  emit(session, { type: 'turn/start', data: { turn: 1 } })
  emit(session, events[1])
  emit(session, TURN_END)
  await sleep(50)
  assert.equal(calls.card.length, 0)
  assert.equal(calls.text.length, 0)
  assert.equal(calls.reply.length, 0)
}))

test('非 completed 的结束原因不发通知', () => withHarness(async ({ calls, emit }) => {
  emit(makeSession(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  await sleep(50)
  assert.equal(calls.card.length + calls.text.length, 0)
  assert.equal(calls.digests.length, 0)
}))

test('Markdown 原样进线程卡片：**加粗** 不被转成纯文本（这正是纯文本回复做不到的）', () => withHarness(async ({ calls, emit }) => {
  const md = '## 结论\n\n**卡片有硬性容量与折叠成本**，所以正文走话题线程。\n\n- 要点甲'
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '为什么' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: md }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  emit(makeSession({ events }), TURN_END)
  await waitFor(() => calls.reply.length === 1)
  const content = calls.reply[0].card.body.elements[0].content
  assert.equal(content, md, '不得剥掉 Markdown 语法符号')
  assert.ok(content.includes('**卡片有硬性容量与折叠成本**'))
}))

test('线程卡片不可发送（老客户端）→ 该分段退化为纯文本：内容仍送达，只是不渲染 Markdown', () => withHarness(async ({ calls, emit }) => {
  emit(makeSession(), TURN_END)
  await waitFor(() => calls.replyText.length === 1)
  assert.equal(calls.reply.length, 0, '卡片回帖被拒')
  assert.equal(calls.replyText[0].text, REPLY, '纯文本兜底仍要送完整原文')
  assert.equal(calls.replyText[0].creds.messageId, 'om_root_card')
  assert.equal(calls.replyText[0].opts.replyInThread, true)
}, {
  deps: {
    replyCardMessage: async () => {
      const err = new Error('schema V2 不再支持该 tag')
      err.feishuCode = 200861
      throw err
    },
  },
}))
