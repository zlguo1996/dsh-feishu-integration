/**
 * 回归：**推理回退 + 说明卡兜底 + 表情诚实性**（2026-09-25 线上问题）。
 *
 * 现象（用户报障）：飞书里「新消息只标记 done，没有回我消息」。
 * 根因链（已在 live 会话流水里逐条证实）：
 *   1. 该回合**最后一步只输出 reasoning 块** —— 模型把回答写进了推理通道，正文一个
 *      `text` 块都没有（turn 6/7 实测 3038 / 8164 字推理、末步 types=['reasoning']）；
 *   2. `lastAssistantText` 倒序取「最后一条 assistant 消息」的 text ⇒ 返回 ''；
 *   3. 投递层 `if (!reply) return {delivered:false, reason:'empty-reply'}` **静默**早退：
 *      不投递、不落死信、**连 debugLog 都在它之后** ⇒ 磁盘上零痕迹；
 *   4. 而表情在 turn/end 里**无条件翻 DONE**（且在投递之前）⇒ 用户看到「✅ done、
 *      一条消息都没有」。
 *
 * 处置（用户 2026-09-25 拍板）：
 *   - **末步没有正文时，用推理内容当正文**，继续走同一条 LLM 摘要链路投出卡片
 *     （`turnReplyBody`：text → reasoning-last → reasoning-turn）；
 *   - 但**必须标注** provenance：推理是模型的思考过程，卡片元信息与线程正文首行都要
 *     写明「正文取自推理通道」——内容照发是用户的决定，不标注就是误导；
 *   - 真的什么都没有（无推理可退 / 调用方显式空 `replyOverride`）才发说明卡；
 *   - 表情**跟随投递结果**：送达 ⇒ DONE，未送达/异常 ⇒ ERROR。
 *
 * 本文件锁六条不变量：
 * A. 末步只有推理 ⇒ 走正常摘要链路投出卡片 + 线程，`delivered` 为 true（不再发说明卡）；
 * B. 卡片与线程都**标注**了「正文取自推理通道」；
 * C. **不退回**中途进度话术（「最后一条非空 text」是错的正文明）；
 * D. 末步连推理都没有 ⇒ 退回本回合全部推理；
 * E. 真的没有正文 ⇒ 日志 + 死信 + 说明卡，且 `delivered` 为 false；
 * F. 表情跟随投递结果（送达 DONE / 未送达 ERROR），且条目必须**同步**取出。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installSummaryPush } from '../lib/host/summary-service.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, what = 'condition', timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for ' + what)
    await sleep(10)
  }
}

const REASONING_CHARS = 3038
const REASONING_TEXT = 'x'.repeat(REASONING_CHARS)
const X50 = 'x'.repeat(50)
/** 中途进度话术：**绝不能**被当成正文投出去。 */
const MID_TEXT = 'Launched. Waiting for the regression diff.'

const AM = (turn, step, content) => ({ type: 'assistant/message', data: { turn, step, message: { content } } })

/**
 * **线上真实形态**（turn 6/7）：中途有过 text（工具间隙的进度话术），
 * 但**最后一步只有 reasoning**。
 */
function reasoningOnlySession({ turn = 6 } = {}) {
  return {
    id: 'session-r',
    header: { cwd: '/tmp/demo' },
    snapshotEvents: () => [
      { type: 'turn/start', data: { turn } },
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '手机不能直连是什么意思？' }], source: { kind: 'user' } } },
      AM(turn, 1, [{ type: 'text', text: MID_TEXT }]),
      AM(turn, 2, [{ type: 'reasoning', text: REASONING_TEXT }]),
      { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    ],
  }
}

/** 末步连推理都没有（只有工具调用），但本回合**更早**的步骤有推理。 */
function earlyReasoningSession({ turn = 6 } = {}) {
  return {
    id: 'session-e',
    header: { cwd: '/tmp/demo' },
    snapshotEvents: () => [
      { type: 'turn/start', data: { turn } },
      AM(turn, 1, [{ type: 'reasoning', text: 'earlier analysis only' }]),
      AM(turn, 2, [{ type: 'tool-call', id: 'call_1', name: 'bash' }]),
      { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    ],
  }
}

/** 真的什么都没有：既无正文，也无任何推理。 */
function bareSession({ turn = 6 } = {}) {
  return {
    id: 'session-b',
    header: { cwd: '/tmp/demo' },
    snapshotEvents: () => [
      { type: 'turn/start', data: { turn } },
      AM(turn, 1, [{ type: 'tool-call', id: 'call_1', name: 'bash' }]),
      { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    ],
  }
}

function normalSession({ turn = 1 } = {}) {
  return {
    id: 'session-n',
    header: { cwd: '/tmp/demo' },
    snapshotEvents: () => [
      { type: 'turn/start', data: { turn } },
      AM(turn, 1, [{ type: 'text', text: '结论：三条腿互相独立。' }]),
      { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    ],
  }
}

function makeCtx() {
  const handlers = {}
  return { on: (name, fn) => { handlers[name] = fn }, fire: (s, e) => handlers['session/event'](s, e) }
}

function makeDeps({ lines = [], deadLetterPath = null, notificationFormat = 'card', rootFails = false } = {}) {
  const calls = { card: [], text: [], replyCard: [], replyText: [], digests: [] }
  const deps = {
    maxText: 1500, includeReasons: ['completed'], botSelection: 'all', chatId: 'oc_test',
    notificationFormat,
    loadBots: () => [{ id: 'b1', appId: 'cli_test', ownerOpenIds: ['ou_1'] }],
    resolveSecret: async () => ({ value: 'secret' }),
    sendCardMessage: async (creds, card, opts) => {
      calls.card.push({ card, opts })
      if (rootFails) throw new Error('feishu 500')
      return 'om_root'
    },
    sendTextMessage: async (creds, text, opts) => { calls.text.push({ text, opts }); return 'om_text' },
    replyCardMessage: async (creds, card, opts) => { calls.replyCard.push({ card, opts }); return 'om_reply_1' },
    replyTextMessage: async (creds, text, opts) => { calls.replyText.push({ text, opts }); return 'om_treply_1' },
    recordReplyMapping: () => {},
    // 走没走「摘要链路」由它证明（本次要求：推理正文也要照常总结成卡片）。
    recordDigest: (entry) => calls.digests.push(entry),
    readDigestHistory: () => [],
    log: () => {},
    debugLog: (...args) => lines.push(`[${new Date().toISOString()}] ${args.join(' ')}`),
    deadLetterPath,
    // 同步重试层：真实实现是指数退避（分钟级），单测里必须立即返回。
    resilientSender: {
      sendWithRetry: async (fn) => {
        try { return { ok: true, value: await fn() } } catch (err) { return { ok: false, error: err } }
      },
    },
  }
  return { deps, calls }
}

const parseLine = (line) => JSON.parse(line.slice(line.indexOf('{')))
const summaryLines = (lines) => lines.map(parseLine).filter((r) => r.sessionId && !r.reason?.kind)

// ───────────────── A. 末步只有推理 ⇒ 走正常摘要链路 ─────────────────

test('末步只有推理 ⇒ 照常投卡片 + 线程（不再发「没有正文」的说明卡）', async () => {
  const lines = []
  const { deps, calls } = makeDeps({ lines })
  const { deliverTurnNotification } = installSummaryPush(makeCtx(), deps)

  const res = await deliverTurnNotification({ sessionId: 'session-r', turn: 6, session: reasoningOnlySession() })

  assert.equal(res.delivered, true, '推理回退后内容真的送达了')
  assert.equal(res.reason, 'ok')
  assert.equal(calls.card.length, 1, '投出根卡片')
  assert.equal(calls.replyCard.length, 1, '完整正文进话题线程')
  assert.equal(calls.digests.length, 1, '走了摘要链路（recordDigest 被调用）')
})

test('推理回退会在落盘行里标明 bodyFrom / 推理字数（一条 grep 可自查）', async () => {
  const lines = []
  const { deps } = makeDeps({ lines })
  const { deliverTurnNotification } = installSummaryPush(makeCtx(), deps)

  await deliverTurnNotification({ sessionId: 'session-r', turn: 6, session: reasoningOnlySession() })

  const rec = summaryLines(lines).find((r) => r.sessionId === 'session-r')
  assert.ok(rec, '必须有 summary 行；实际: ' + JSON.stringify(lines))
  assert.equal(rec.bodyFrom, 'reasoning-last')
  assert.equal(rec.reasoningChars, REASONING_CHARS)
  assert.ok(!lines.some((l) => l.includes('summary-skip')), '走了推理回退就不该再记 summary-skip')
})

// ───────────────── B. 必须标注 provenance ─────────────────

test('卡片元信息标注「正文取自推理通道」', async () => {
  const { deps, calls } = makeDeps({})
  const { deliverTurnNotification } = installSummaryPush(makeCtx(), deps)

  await deliverTurnNotification({ sessionId: 'session-r', turn: 6, session: reasoningOnlySession() })

  const root = JSON.stringify(calls.card[0].card)
  assert.match(root, /正文取自推理通道/, '不标注就是误导：读的人有权知道这段正文来自推理通道')
})

test('线程正文首行带说明，且正文就是推理原文', async () => {
  const { deps, calls } = makeDeps({})
  const { deliverTurnNotification } = installSummaryPush(makeCtx(), deps)

  await deliverTurnNotification({ sessionId: 'session-r', turn: 6, session: reasoningOnlySession() })

  const thread = JSON.stringify(calls.replyCard[0].card)
  assert.match(thread, /取自模型的推理通道/, '线程正文首行必须有说明')
  assert.ok(thread.includes(X50), '线程正文里必须有推理原文')
})

// ───────────────── C. 不退回中途进度话术 ─────────────────

test('不退回「本回合最后一条非空 text」——那是进度话术，不是回答', async () => {
  const { deps, calls } = makeDeps({})
  const { deliverTurnNotification } = installSummaryPush(makeCtx(), deps)

  await deliverTurnNotification({ sessionId: 'session-r', turn: 6, session: reasoningOnlySession() })

  assert.ok(!JSON.stringify(calls.replyCard[0].card).includes(MID_TEXT),
    '把进度话术当正文投出去比不投更误导')
})

// ───────────────── D. 末步无推理 ⇒ 退回本回合全部推理 ─────────────────

test('末步连推理都没有 ⇒ 退回本回合全部推理（bodyFrom=reasoning-turn）', async () => {
  const lines = []
  const { deps, calls } = makeDeps({ lines })
  const { deliverTurnNotification } = installSummaryPush(makeCtx(), deps)

  const res = await deliverTurnNotification({ sessionId: 'session-e', turn: 6, session: earlyReasoningSession() })

  assert.equal(res.delivered, true)
  const rec = summaryLines(lines).find((r) => r.sessionId === 'session-e')
  assert.equal(rec.bodyFrom, 'reasoning-turn')
  assert.ok(JSON.stringify(calls.replyCard[0].card).includes('earlier analysis only'))
})

test('推理回退成功时**不落死信**（它不是故障路径）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-reasoning-'))
  const deadLetterPath = join(dir, 'dead.jsonl')
  const { deps } = makeDeps({ deadLetterPath })
  const { deliverTurnNotification } = installSummaryPush(makeCtx(), deps)

  await deliverTurnNotification({ sessionId: 'session-r', turn: 6, session: reasoningOnlySession() })

  assert.equal(existsSync(deadLetterPath), false, '用推理兜住了就不该记死信')
})

// ───────────────── E. 真的没有正文 ⇒ 说明卡 + 日志 + 死信 ─────────────────

test('真的没有正文（无推理可退）⇒ summary-skip + 死信 + 说明卡，delivered=false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-empty-'))
  const deadLetterPath = join(dir, 'dead.jsonl')
  const lines = []
  const { deps, calls } = makeDeps({ lines, deadLetterPath })
  const { deliverTurnNotification } = installSummaryPush(makeCtx(), deps)

  const res = await deliverTurnNotification({ sessionId: 'session-b', turn: 6, session: bareSession() })

  assert.equal(res.delivered, false, '说明卡只是告知，回答依然没有送达')
  assert.equal(res.reason, 'empty-reply')

  const skip = lines.map(parseLine).find((r) => r.sessionId === 'session-b')
  assert.ok(skip, '必须落 summary-skip；实际: ' + JSON.stringify(lines))
  assert.equal(skip.cause, 'no-content')

  assert.ok(existsSync(deadLetterPath), '落死信（本次排查就卡在「无死信、无日志」）')
  const entry = parseLine(readFileSync(deadLetterPath, 'utf8').trim())
  assert.equal(entry.kind, 'empty-reply')
  assert.equal(entry.cause, 'no-content')

  assert.equal(calls.card.length, 1, '发一张说明卡，用户不再干等')
  assert.match(JSON.stringify(calls.card[0].card), /没有可投递的正文/)
  assert.equal(calls.replyCard.length, 0, '正文本来就不存在，不该建空线程')
})

test('显式空 replyOverride 优先：不去替它捞推理，仍走说明卡', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-override-'))
  const lines = []
  const { deps, calls } = makeDeps({ lines, deadLetterPath: join(dir, 'dead.jsonl') })
  const { deliverTurnNotification } = installSummaryPush(makeCtx(), deps)

  // 会话里**有**推理，但调用方显式给了空正文 ⇒ 听调用方的
  const res = await deliverTurnNotification({
    sessionId: 'session-r', turn: 6, session: reasoningOnlySession(), replyOverride: '',
  })

  assert.equal(res.reason, 'empty-reply')
  const skip = lines.map(parseLine).find((r) => r.sessionId === 'session-r')
  assert.equal(skip.cause, 'override-empty')
  const card = JSON.stringify(calls.card[0].card)
  assert.match(card, /没有可投递的正文/)
  assert.ok(!card.includes(X50), '显式空正文时不得把推理内容塞进去')
})

test('notificationFormat:text ⇒ 推理回退也走纯文本根 + 线程', async () => {
  const { deps, calls } = makeDeps({ notificationFormat: 'text' })
  const { deliverTurnNotification } = installSummaryPush(makeCtx(), deps)

  const res = await deliverTurnNotification({ sessionId: 'session-r', turn: 6, session: reasoningOnlySession() })

  assert.equal(res.delivered, true)
  assert.equal(calls.card.length, 0)
  assert.equal(calls.text.length, 1)
  assert.match(calls.text[0].text, /正文取自推理通道/, '纯文本形态同样要标注')
  // 线程始终用**卡片**回帖（飞书纯文本不渲染 Markdown），与根消息形态无关。
  assert.equal(calls.replyCard.length, 1, '完整正文照常进话题线程')
  assert.ok(JSON.stringify(calls.replyCard[0].card).includes(X50), '线程正文里必须有推理原文')
})

// ───────────────── F. 表情跟随投递结果 ─────────────────

function makeReactionHarness({ rootFails = false } = {}) {
  const lines = []
  const { deps, calls } = makeDeps({ lines, rootFails })
  const flips = []
  const taken = []
  const takePendingReaction = (sid) => {
    taken.push(sid)
    return { messageId: 'om_in_1', flip: (emoji) => { flips.push(emoji); return Promise.resolve() } }
  }
  const ctx = makeCtx()
  installSummaryPush(ctx, { ...deps, takePendingReaction })
  return { ctx, calls, flips, taken, lines }
}

test('表情：正常回合送达 ⇒ DONE', async () => {
  const h = makeReactionHarness({})
  h.ctx.fire(normalSession(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await until(() => h.flips.length > 0, 'flip')
  assert.deepEqual(h.flips, ['DONE'])
})

test('表情：推理回退送达 ⇒ 也是 DONE（内容确实送达了）', async () => {
  const h = makeReactionHarness({})
  h.ctx.fire(reasoningOnlySession(), { type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } })
  await until(() => h.flips.length > 0, 'flip')
  assert.deepEqual(h.flips, ['DONE'])
})

test('表情：真的没有正文 ⇒ ERROR，而不是 DONE（本次事故的核心）', async () => {
  const h = makeReactionHarness({})
  h.ctx.fire(bareSession(), { type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } })
  await until(() => h.flips.length > 0, 'flip')
  assert.deepEqual(h.flips, ['ERROR'], '投递没送出回答，表情就不许说 DONE')
  assert.equal(h.calls.card.length, 1, '同时说明卡已发出，用户知道为什么没回答')
})

test('表情：根消息发送失败 ⇒ ERROR', async () => {
  const h = makeReactionHarness({ rootFails: true })
  h.ctx.fire(normalSession(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await until(() => h.flips.length > 0, 'flip')
  assert.deepEqual(h.flips, ['ERROR'])
})

test('表情：结束原因不在白名单 ⇒ 只收掉表情、不投递（不留悬停 OnIt）', async () => {
  const h = makeReactionHarness({})
  h.ctx.fire(normalSession(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  await until(() => h.flips.length > 0, 'flip')
  assert.deepEqual(h.flips, ['DONE'])
  assert.equal(h.calls.card.length, 0)
  assert.equal(h.calls.text.length, 0)
})

test('表情条目必须**同步**取出：投递未返回时条目已被取走，翻的结果才可以迟到', async () => {
  const lines = []
  const { deps } = makeDeps({ lines })
  const taken = []
  const flips = []
  const ctx = makeCtx()
  // 让投递**永不 settle**：formatDigest 卡住 ⇒ 只可能靠同步取出通过本用例。
  installSummaryPush(ctx, {
    ...deps,
    formatDigest: () => new Promise(() => {}),
    takePendingReaction: (sid) => {
      taken.push(sid)
      return { messageId: 'om_A', flip: (e) => { flips.push(e); return Promise.resolve() } }
    },
  })

  ctx.fire(normalSession(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  assert.deepEqual(taken, ['session-n'], '取出必须同步 —— 否则前后紧邻的两条回合会取错对象')
  assert.deepEqual(flips, [], 'flip 必须等投递结果，不能提前翻')
})
