/**
 * 发送层 formatter 的**输入组装**（纯函数，测试缝）。
 *
 * 职责：把「本回合提问 + 本回合回复 + 最近 5 条历史项」装成一段结构化 prompt，
 * 并在 16 KiB 总预算内按优先级分配（Codex FINAL 修订版）：
 *   1. 本回合回复（最高优先）
 *   2. 本回合提问
 *   3. 历史上下文（最低优先）
 *
 * 硬约束：
 * - PRIOR_CONTEXT 只做「指代消解与主题定位」的背景，**不授权任何事实**；
 *   校验权威仍按字段划分（title ← 提问，summary/bullets ← 回复）。
 * - 只允许**截断**（UTF-8 安全、保留开头、追加既有省略号），不许为了塞进预算
 *   而总结或改写原文；绝不为此再发一次 LLM 调用。
 * - 预算不够时先丢最老的历史项，再压缩提问，最后才压缩回复；**永不删掉提问**。
 */

import { summarizeForLlm, DEFAULT_MAX_INPUT_BYTES } from './notification-digest.js'

/** 最多携带的历史项数量：一条用户输入或一条该回合的总结各算一项。 */
export const MAX_PRIOR_ITEMS = 5
/** 单条历史项的字节上限。 */
export const PRIOR_ITEM_MAX_BYTES = 768
/** 全部历史项（含标签）的字节上限。 */
export const PRIOR_TOTAL_MAX_BYTES = 3 * 1024
/** 本回合提问的字节上限。 */
export const QUESTION_MAX_BYTES = 3 * 1024
/** 需要截断时，为回复预留的最小字节数。 */
export const REPLY_MIN_RESERVE_BYTES = 10 * 1024
/** 提问被压缩时的下限：再小就只剩语气词，等于删掉提问，因此不允许。 */
const QUESTION_FLOOR_BYTES = 256

export const LABEL_PRIOR = 'PRIOR_CONTEXT:'
export const LABEL_QUESTION = 'CURRENT_QUESTION:'
export const LABEL_REPLY = 'CURRENT_ASSISTANT_REPLY:'
export const NO_PRIOR_CONTEXT = '(none)'

/**
 * 按字节截断（UTF-8 安全、不切开代理对与多字节字符），超限则追加省略号。
 * 省略号本身占 3 字节，已计入预算。
 * @returns {{text: string, truncated: boolean}}
 */
export function clipToBytes(text, maxBytes) {
  const t = String(text ?? '')
  if (Buffer.byteLength(t, 'utf8') <= maxBytes) return { text: t, truncated: false }
  const budget = Math.max(1, maxBytes - Buffer.byteLength('…', 'utf8'))
  let out = ''
  let used = 0
  for (const ch of t) {
    const b = Buffer.byteLength(ch, 'utf8')
    if (used + b > budget) break
    out += ch
    used += b
  }
  return { text: out + '…', truncated: true }
}

/** 历史项标签：`[turn 7][user]` / `[turn 7][assistant_summary]`。 */
export function priorItemLabel(item) {
  const kind = item?.kind === 'assistant_summary' ? 'assistant_summary' : 'user'
  return `[turn ${item?.turn ?? '?'}][${kind}]`
}

/**
 * 选出最近 5 条历史项（不含当前回合），并恢复为时间顺序。
 *
 * 规则：每个更早的回合最多产出 0~2 项——先是直接人类输入（若有），再是该回合
 * 真正产出过的总结（若有）。**缺失的总结不补造**：只有用户输入的回合就只贡献
 * 那一项。飞书触发的回合不产出总结，因此通常只贡献用户输入项。
 *
 * @param {{prompts?: Array<{turn:number,text:string}>, summaries?: Array<{turn:number,summary:string}>, currentTurn?: number|null, maxItems?: number}} o
 * @returns {Array<{turn:number, kind:'user'|'assistant_summary', text:string}>}
 */
export function selectPriorItems({ prompts = [], summaries = [], currentTurn = null, maxItems = MAX_PRIOR_ITEMS } = {}) {
  const turns = new Map()
  const bucket = (turn) => {
    if (!turns.has(turn)) turns.set(turn, { turn, user: '', summary: '' })
    return turns.get(turn)
  }
  for (const p of prompts) {
    const turn = Number(p?.turn)
    const text = String(p?.text ?? '').trim()
    if (!Number.isFinite(turn) || !text) continue
    if (currentTurn != null && turn >= currentTurn) continue
    bucket(turn).user = bucket(turn).user ? bucket(turn).user + '\n' + text : text
  }
  for (const s of summaries) {
    const turn = Number(s?.turn)
    const summary = String(s?.summary ?? '').trim()
    if (!Number.isFinite(turn) || !summary) continue
    if (currentTurn != null && turn >= currentTurn) continue
    bucket(turn).summary = summary
  }
  const ordered = [...turns.values()].sort((a, b) => a.turn - b.turn)
  const items = []
  for (const t of ordered) {
    if (t.user) items.push({ turn: t.turn, kind: 'user', text: t.user })
    if (t.summary) items.push({ turn: t.turn, kind: 'assistant_summary', text: t.summary })
  }
  // 已按「回合升序 + 回合内 user 先、summary 后」排列，取尾部 N 项即最近 N 项。
  return items.slice(Math.max(0, items.length - maxItems))
}

/** 渲染一个历史项块（标签 + 预处理后的正文，单项受字节上限约束）。 */
function renderPriorItem(item) {
  const pre = summarizeForLlm(item.text)
  const clipped = clipToBytes(pre, PRIOR_ITEM_MAX_BYTES)
  return { block: priorItemLabel(item) + '\n' + clipped.text, truncated: clipped.truncated }
}

/**
 * 组装 formatter 输入。
 *
 * @param {object} o
 * @param {string} o.question 本回合直接人类提问（可为空）
 * @param {string} o.reply    本回合 assistant 回复
 * @param {Array} [o.priorItems] selectPriorItems() 的产出（时间顺序）
 * @param {number} [o.maxBytes] 总预算（含标签），默认 16 KiB
 * @returns {{text, priorUsed, priorDropped, questionTruncated, replyTruncated}}
 */
export function buildFormatterInput({ question = '', reply = '', priorItems = [], maxBytes = DEFAULT_MAX_INPUT_BYTES } = {}) {
  const questionPre = summarizeForLlm(String(question ?? ''))
  const replyPre = summarizeForLlm(String(reply ?? ''))

  // ── 预算账本：所有标签与换行都计入 ──
  const fixedBytes = Buffer.byteLength(
    [LABEL_PRIOR, NO_PRIOR_CONTEXT, LABEL_QUESTION, LABEL_REPLY].join('\n') + '\n\n\n\n', 'utf8',
  )
  // 先按「总历史预算 + 单项上限」渲染历史块（从新到旧累加，超预算就丢最老的）。
  const rendered = []
  for (const item of priorItems) rendered.push(renderPriorItem(item))
  const kept = [...rendered]
  let priorText = ''
  const composePrior = () => kept.map((r) => r.block).join('\n\n')
  priorText = composePrior()
  const dropped = []
  while (kept.length > 0 && Buffer.byteLength(priorText, 'utf8') > PRIOR_TOTAL_MAX_BYTES) {
    dropped.push(kept.shift())   // 最老的先丢
    priorText = composePrior()
  }

  // 提问：先按自身上限截断；预算不够时再压缩（但绝不删掉）。
  let q = clipToBytes(questionPre, QUESTION_MAX_BYTES)
  let questionText = q.text
  const replyBytesFull = Buffer.byteLength(replyPre, 'utf8')
  const reserve = Math.min(REPLY_MIN_RESERVE_BYTES, replyBytesFull)

  const available = () => maxBytes - fixedBytes
    - Buffer.byteLength(priorText, 'utf8')
    - Buffer.byteLength(questionText, 'utf8')

  // 1) 先丢最老的历史项，直到能给回复留出预留量。
  while (kept.length > 0 && available() < reserve) {
    dropped.push(kept.shift())
    priorText = composePrior()
  }
  // 2) 再把提问压到下限之上，为回复腾空间（永不删提问）。
  while (questionText.length > 0 && available() < reserve) {
    const cur = Buffer.byteLength(questionText, 'utf8')
    if (cur <= QUESTION_FLOOR_BYTES) break
    const next = Math.max(QUESTION_FLOOR_BYTES, Math.floor(cur / 2))
    const clippedQ = clipToBytes(questionText, next)
    if (clippedQ.text === questionText) break
    questionText = clippedQ.text
    q = { text: questionText, truncated: true }
  }

  // 3) 剩余预算全给回复。
  let r = clipToBytes(replyPre, Math.max(1, available()))
  let replyText = r.text
  // 极端情况：固定标签 + 提问就超预算时，至少保证回复非空且不超总预算。
  let text = assemble(priorText, questionText, replyText)
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const over = Buffer.byteLength(text, 'utf8') - maxBytes
    const shrunk = clipToBytes(replyText, Math.max(1, Buffer.byteLength(replyText, 'utf8') - over))
    replyText = shrunk.text
    r = { text: replyText, truncated: true }
    text = assemble(priorText, questionText, replyText)
  }

  return {
    text,
    priorUsed: kept.length,
    priorDropped: dropped.length,
    questionTruncated: q.truncated,
    replyTruncated: r.truncated,
  }
}

function assemble(priorText, questionText, replyText) {
  return [
    LABEL_PRIOR,
    priorText || NO_PRIOR_CONTEXT,
    '',
    LABEL_QUESTION,
    questionText,
    '',
    LABEL_REPLY,
    replyText,
  ].join('\n')
}
