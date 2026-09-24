/**
 * 通知摘要的语义层契约与极简确定性兜底。
 *
 * 分工（Codex FINAL，2026-09-24 修订版）：
 * - **语义交给 LLM**：它只做受约束压缩，输出 `{title, summary, bullets}` 纯文本 JSON；
 * - **确定性代码只做两件事**：显然正确的兜底 + 按字段的契约校验。
 *
 * `title` 是「本回合提问在讲什么」，不是固定 chrome，也不是历史话题：
 * 校验权威是**本回合直接人类提问**（提问缺失时退化为回复），summary/bullets 的权威
 * 始终是**本回合 assistant 回复**。历史上下文（PRIOR_CONTEXT）只做指代消解，
 * 永不授权任何事实 token。
 *
 * 因此本文件**刻意不含任何语义启发式**：没有「结论：」短语表、没有「优先取标题」、
 * 没有「标题短于 12 字补后文首句」、没有中文序号剥离、没有叙述开场词表。
 * 这些规则曾被真实语料证明是在改写原文（把 "1.1 标题" 吃成 "1 标题"、把
 * "摘要已交付：…" 截成 "已交付：…"），且只在 19 条样本上「看起来有效」。
 * 兜底标题同样只按**位置**取引用（首个标题 → 首句），不做主题推断。
 */

import {
  parseBlocks, stripInline, firstSentence, clip, TITLE_FALLBACK_SENTINEL,
} from './progressive.js'

export const SUMMARY_MAX_CHARS = 80
export const BULLET_MAX_CHARS = 100
/** 标题硬上限：卡片头部空间有限，超过一律打回（不由代码「修好」模型输出）。 */
export const TITLE_MAX_CHARS = 20
export const MAX_BULLETS = 3
/** 结构哨兵（定义在 progressive.js，卡片与摘要层必须一致）。 */
export { TITLE_FALLBACK_SENTINEL }
/** 送给模型的输入上限（按字节）。真实语料 p90≈2939 字，16K 足够且不切掉结论段。 */
export const DEFAULT_MAX_INPUT_BYTES = 16 * 1024

/** 控制字符（不含 \n \t）：出现在卡片里会渲染异常。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
/** 输出必须是纯文本：不要 Markdown 结构、HTML、卡片 JSON、代码围栏。 */
const FENCED_CODE = /(```|~~~)/
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/
const MD_HEADING = /^\s{0,3}#{1,6}\s/m
const MD_STRONG = /(\*\*|__)/
const MD_QUOTE = /^\s{0,3}>\s/m
const LOOKS_LIKE_JSON = /^\s*[{[]/

/** 取首个标题块（位置规则，不判断语义）。 */
export function firstHeading(text) {
  const h = parseBlocks(text).find((b) => b.type === 'heading')
  return h ? stripInline(h.text) : ''
}

/** 取首个段落的首句（位置规则，不判断语义）。 */
export function firstParagraphSentence(text) {
  const para = parseBlocks(text).find((b) => b.type === 'paragraph')
  return para ? firstSentence(stripInline(para.text)) : ''
}

/**
 * 标题上限：超限只保留前 19 个字符 + `…`（`clip` 已是 UTF-16 安全的）。
 * 只截断，绝不换更短的措辞、不删编号/标点/开场词、不改写。
 */
export function clipTitle(text) {
  const t = String(text ?? '').trim()
  return t.length > TITLE_MAX_CHARS ? clip(t, TITLE_MAX_CHARS) : t
}

/**
 * 极简兜底：标题 + 首个段落的首句 + 首个列表块的前 N 条。
 * 这条路径必须「显然正确」——不做任何语义判断，因此永远不会歪曲原意。
 * 标题优先级（严格按位置引用，不猜主题）：
 *   问题首个标题 → 问题首句 → 回复首个标题 → 回复首句 → 结构哨兵。
 * @param {string} reply 原始 assistant 回复
 * @param {string} [question] 本回合直接人类提问（缺失时退化为只用回复）
 */
export function fallbackDigest(reply, question = '') {
  const r = String(reply ?? '')
  const q = String(question ?? '')
  const blocks = parseBlocks(r)
  const para = blocks.find((b) => b.type === 'paragraph')
  const list = blocks.find((b) => b.type === 'list' && b.items.length > 0)
  return {
    title: clipTitle(
      firstHeading(q)
      || firstParagraphSentence(q)
      || firstHeading(r)
      || firstParagraphSentence(r)
      || TITLE_FALLBACK_SENTINEL,
    ),
    summary: clip(para ? firstSentence(stripInline(para.text)) : '', SUMMARY_MAX_CHARS),
    bullets: list
      ? list.items.slice(0, MAX_BULLETS).map((x) => clip(stripInline(x), BULLET_MAX_CHARS)).filter(Boolean)
      : [],
  }
}

/**
 * 结构预处理后再喂模型：去掉大块代码/日志（它们既费 token 又几乎不进摘要），
 * 保留标题/段落/列表/引用的语义文本。真实语料 46.7% 含代码围栏，所以这一步
 * 能把输入显著压小，同时避免「简单截前 4000 字刚好切掉『### 测试结果』」。
 * @param {string} reply
 * @param {{maxBytes?: number}} [opts]
 */
export function summarizeForLlm(reply, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_INPUT_BYTES
  const blocks = parseBlocks(reply)
  const parts = []
  for (const b of blocks) {
    if (b.type === 'code') {
      const lines = String(b.text ?? '').split('\n').length
      parts.push(`[代码块已省略 ${lines} 行]`)
      continue
    }
    if (b.type === 'heading') { parts.push(stripInline(b.text)); continue }
    if (b.type === 'list') { parts.push(b.items.map((i) => '- ' + stripInline(i)).join('\n')); continue }
    if (b.type === 'quote' || b.type === 'paragraph' || b.type === 'table') { parts.push(stripInline(b.text ?? '')); continue }
  }
  let out = parts.filter(Boolean).join('\n\n').trim()
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = clip(out, Math.max(0, Math.floor(maxBytes / 3))) + '\n[输入已按上限截断]'
  }
  return out
}

/**
 * 从模型输出里取出 JSON。只接受两种形态：整段 JSON，或围栏/散文里第一个
 * 配平的花括号块。取不到就判失败（宁可回退，也不猜）。
 *
 * `title` 缺失/非字符串**不在这里判失败**：交给 validateDigest 给出精确原因
 * （title-not-string / title-empty），排障时能区分「模型没输出 JSON」与
 * 「输出缺字段」。
 * @returns {{title: string|null, summary: string, bullets: string[]} | null}
 */
export function parseDigestJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const candidates = []
  candidates.push(text)
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())
  const start = text.indexOf('{')
  if (start >= 0) {
    let depth = 0
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) { candidates.push(text.slice(start, i + 1)); break }
      }
    }
  }
  for (const c of candidates) {
    let obj
    try { obj = JSON.parse(c) } catch { continue }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : null
    if (summary === null) continue
    const title = typeof obj.title === 'string' ? obj.title.trim() : null
    const bullets = Array.isArray(obj.bullets)
      ? obj.bullets.filter((b) => typeof b === 'string').map((b) => b.trim()).filter(Boolean)
      : []
    return { title, summary, bullets }
  }
  return null
}

/**
 * 事实强度词表：同组内任一变体都算「同一强度等级」。
 *
 * 为什么需要同义组：真实语料是中英混排的（原文常写 "success ✅"），若只按字面
 * 比对，摘要写「成功」就会被误判为「原文没有的断言」而打回兜底 —— 这正是冒烟
 * 测试抓到的误报。分组的判据是「强度等级」，不是措辞。
 */
const STATUS_GROUPS = [
  ['完成', '已完成', 'done', 'complete', 'completed'],
  ['修复', '已修复', 'fix', 'fixed'],
  ['解决', '已解决', 'resolve', 'resolved'],
  ['通过', 'passed', 'pass'],
  ['成功', 'success', 'succeeded', 'ok'],
  ['失败', 'failed', 'fail'],
  ['上线', '发布', 'deployed', 'released'],
  ['合并', 'merged'],
]

/**
 * 来源词覆盖：输出里出现的「具体事实 token」必须能在原文找到。
 * 这是**异常检测，不是事实验证** —— 用来兜住生成式摘要最危险的一类失真：
 * 编造数字/文件/版本/URL，或把「怀疑 X」升级成「已修复 X」。
 * @returns {string[]} 违规 token 列表（空数组 = 通过）
 */
export function coverageViolations(candidate, source) {
  const cand = String(candidate ?? '')
  const src = String(source ?? '')
  const bad = []
  const stripTail = (s) => s.replace(/[.,;:，。；：、!！?？)\]）]+$/, '')
  const need = (token) => {
    const t = stripTail(String(token))
    if (!t || !cand.includes(t)) return
    if (!src.includes(t)) bad.push(t)
  }
  // 数字（含百分比/时间/行号）、URL、文件名、版本号
  for (const m of cand.match(/\d[\d.,:%+\-/]*/g) ?? []) need(m)
  for (const m of cand.match(/https?:\/\/[^\s)）]+/g) ?? []) need(m)
  for (const m of cand.match(/[\w./-]+\.(?:js|mjs|cjs|ts|tsx|json|jsonl|py|md|java|kt|swift|yml|yaml|sh|html|css|go|rs|c|cpp|h)\b/gi) ?? []) need(m)
  for (const m of cand.match(/\bv?\d+\.\d+(?:\.\d+)?\b/g) ?? []) need(m)
  // 事实强度：同组任一变体出现在输出里，原文就必须有该组的任一变体
  const lowerSrc = src.toLowerCase()
  for (const group of STATUS_GROUPS) {
    const hit = group.find((w) => cand.includes(w))
    if (!hit) continue
    const supported = group.some((w) => src.includes(w) || lowerSrc.includes(w.toLowerCase()))
    if (!supported) bad.push(hit)
  }
  return [...new Set(bad)]
}

/**
 * 审计用不变量：该文本是否只由「删除字符 + 截断」从原文得到。
 *
 * 为什么需要：兜底摘要是**逐字引用**，它当然不该被上面的契约校验拦住——实测
 * 2463 条语料里有 67 条引用会被拦（`clip()` 把数字截成半截、原文本身含 `<div>`
 * 或落单的 `**`）。所以「引用路径」用这条更弱但正确的判据：
 *   去掉空白后（段落软换行会被拼成空格）与末尾的截断标记 `…`，正文必须仍是
 *   原文的**子序列** —— 即只删不改、只截不造。
 * 契约校验 `validateDigest` 只用于 **LLM 产出**。
 */
export function isQuoteOf(text, source) {
  const raw = String(text ?? '')
  const needle = [...(raw.endsWith('…') ? raw.slice(0, -1) : raw)].filter((c) => !/\s/.test(c))
  const hay = [...String(source ?? '')].filter((c) => !/\s/.test(c))
  if (needle.length === 0) return true
  let i = 0
  for (const ch of hay) {
    if (ch === needle[i]) i++
    if (i >= needle.length) return true
  }
  return i >= needle.length
}

/**
 * 契约校验：形状 / 长度 / 纯文本 / 控制字符 / **按字段的来源词覆盖**。
 *
 * 来源权威是**按字段**划分的（Codex FINAL 修订版）：
 *   - `title` 只由「本回合直接人类提问」授权（提问缺失时退化为回复）；
 *   - `summary` / `bullets` 只由「本回合 assistant 回复」授权。
 * 历史上下文（PRIOR_CONTEXT）永远不授权任何事实 token：只出现在历史里的数字 /
 * URL / 文件名 / 版本 / 状态词出现在本次输出里，一律打回。
 *
 * ⚠️ **只用于 LLM 产出**，不用于确定性兜底：兜底是逐字引用（用 `isQuoteOf` 审计），
 * 而这里的「纯文本、无 HTML、无 Markdown、来源词逐字命中」等要求会误伤被截断的
 * 引用（实测 67/2463）。任一不过即由调用方回退；不允许「修一修继续用」。
 * @param {{title?: unknown, summary: unknown, bullets?: unknown}} candidate
 * @param {string} source 本回合 assistant 回复（summary/bullets 的权威来源）
 * @param {string} [question] 本回合直接人类提问（title 的权威来源）
 * @returns {{ok: true, digest: {title: string, summary: string, bullets: string[]}} | {ok: false, reason: string, violations?: string[]}}
 */
export function validateDigest(candidate, source, question = '') {
  if (!candidate || typeof candidate !== 'object') return { ok: false, reason: 'not-an-object' }
  const title = candidate.title
  const summary = candidate.summary
  const bullets = candidate.bullets ?? []
  if (typeof title !== 'string') return { ok: false, reason: 'title-not-string' }
  if (title.trim() === '') return { ok: false, reason: 'title-empty' }
  if (title.length > TITLE_MAX_CHARS) return { ok: false, reason: `title-too-long:${title.length}` }
  if (typeof summary !== 'string') return { ok: false, reason: 'summary-not-string' }
  if (!Array.isArray(bullets) || bullets.some((b) => typeof b !== 'string')) return { ok: false, reason: 'bullets-not-string-array' }
  if (summary.trim() === '') return { ok: false, reason: 'summary-empty' }
  if (summary.length > SUMMARY_MAX_CHARS) return { ok: false, reason: `summary-too-long:${summary.length}` }
  if (bullets.length > MAX_BULLETS) return { ok: false, reason: `too-many-bullets:${bullets.length}` }
  for (const b of bullets) {
    if (b.trim() === '') return { ok: false, reason: 'bullet-empty' }
    if (b.length > BULLET_MAX_CHARS) return { ok: false, reason: `bullet-too-long:${b.length}` }
  }
  const joined = [title, summary, ...bullets].join('\n')
  if (CONTROL_CHARS.test(joined)) return { ok: false, reason: 'control-chars' }
  if (FENCED_CODE.test(joined)) return { ok: false, reason: 'contains-fenced-code' }
  if (HTML_TAG.test(joined)) return { ok: false, reason: 'contains-html' }
  if (MD_HEADING.test(joined)) return { ok: false, reason: 'contains-heading' }
  if (MD_STRONG.test(joined)) return { ok: false, reason: 'contains-bold' }
  if (MD_QUOTE.test(joined)) return { ok: false, reason: 'contains-quote' }
  if (LOOKS_LIKE_JSON.test(joined)) return { ok: false, reason: 'looks-like-json' }
  // 按字段分别校验来源：标题查提问，摘要/要点查回复。
  const titleViolations = coverageViolations(title, question || source)
  if (titleViolations.length > 0) {
    return { ok: false, reason: 'title-source-coverage', violations: titleViolations }
  }
  const bodyViolations = coverageViolations([summary, ...bullets].join('\n'), source)
  if (bodyViolations.length > 0) return { ok: false, reason: 'source-coverage', violations: bodyViolations }
  return {
    ok: true,
    digest: { title: title.trim(), summary: summary.trim(), bullets: bullets.map((b) => b.trim()) },
  }
}
