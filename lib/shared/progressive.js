/**
 * 通知分层（progressive disclosure）的**结构层**：Markdown 结构解析 + 飞书卡片
 * JSON 2.0 渲染。纯函数、无副作用（测试缝）。
 *
 * ── 职责边界（第二批重构后的最终分工）────────────────────────────────
 * 本模块**不做语义判断**。「哪句话是结论」这类问题属于 `notification-digest.js`
 * 的语义层：优先交给发送层 LLM 做受约束压缩，失败则退化为逐字引用兜底。
 *
 * 本模块只做两件事：
 *   1. **结构解析**（parseBlocks 等）：按 Markdown 语法边界切块。它服务于两处——
 *      给 LLM 预处理输入（把代码/日志块折成一行标记），以及兜底路径取「首段首句 /
 *      首个列表块」这种显然正确的引用切片。
 *   2. **卡片渲染**（buildNotificationCardV2）：把语义层给出的 summary/bullets
 *      和原文正文装进 2.0 卡片。
 *
 * ── 唯一不变量：绝不改写作者原文 ───────────────────────────────────
 * 只允许剥掉 Markdown 语法符号（#、**、`、链接语法），只允许按字符截断；
 * 不删除、不替换、不重排任何正文内容。
 *
 * 历史教训（为什么这里不再有任何语义启发式）：本文件曾包含「标题优先」「标题短于
 * 12 字补后文首句」「中文序号剥离」「叙述开场词表」等规则，实测在 2463 条真实载荷上
 * 会把 "1.1 标题" 吃成 "1 标题"、把 "摘要已交付：…" 截成 "已交付：…"——用不可靠的
 * 文本匹配伪造可靠性。这些规则已全部删除，语义交给 LLM，兜底只做逐字引用。
 */

/** 短于此长度不折叠：不为一条短消息增加一次点击。 */
export const DEFAULT_FOLD_THRESHOLD_CHARS = 400
/** 飞书卡片消息体硬上限 30KB（错误码 230025），留 20% 余量作安全线。 */
export const CARD_BYTE_BUDGET = 24 * 1024
/** 卡片正文压缩下限：再小就只剩标题了，不如让超长正文走截断。 */
const MIN_DETAIL_CHARS = 200
const BUDGET_ITERATIONS = 24
const SENTENCE_SCAN_CHARS = 120

const isListLine = (s) => /^([-*+]|\d+[.)])\s+/.test(s)
const isHeadingLine = (s) => /^#{1,6}\s+/.test(s)

/**
 * 把正文切成结构块。这是「解析」而非「猜测」：只依据 Markdown 语法边界。
 * 围栏内的 # 与 - 是代码，不是结构。
 * @returns {Array<{type:'code'|'heading'|'list'|'quote'|'table'|'paragraph', text?:string, items?:string[]}>}
 */
export function parseBlocks(text) {
  const lines = String(text ?? '').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i].trim()
    if (!trimmed) { i++; continue }

    const fence = trimmed.match(/^(```|~~~)/)
    if (fence) {
      const mark = fence[1]
      i++
      const buf = []
      while (i < lines.length && !lines[i].trim().startsWith(mark)) { buf.push(lines[i]); i++ }
      i++
      blocks.push({ type: 'code', text: buf.join('\n') })
      continue
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      i++
      continue
    }

    if (trimmed.startsWith('>')) {
      const buf = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ type: 'quote', text: buf.join('\n') })
      continue
    }

    if (isListLine(trimmed)) {
      const items = []
      while (i < lines.length && isListLine(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^([-*+]|\d+[.)])\s+/, ''))
        i++
      }
      blocks.push({ type: 'list', items })
      continue
    }

    if (trimmed.startsWith('|')) {
      const buf = []
      while (i < lines.length && lines[i].trim().startsWith('|')) { buf.push(lines[i]); i++ }
      blocks.push({ type: 'table', text: buf.join('\n') })
      continue
    }

    const buf = []
    while (i < lines.length) {
      const t = lines[i].trim()
      if (!t || isHeadingLine(t) || /^(```|~~~)/.test(t) || t.startsWith('>') || isListLine(t) || t.startsWith('|')) break
      buf.push(t)
      i++
    }
    blocks.push({ type: 'paragraph', text: buf.join(' ') })
  }
  return blocks
}

/** 只剥 Markdown 语法符号，不动正文字符。 */
export function stripInline(s) {
  return String(s ?? '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
}

/** 取首个句子（位置规则，不判断语义）。 */
export function firstSentence(s) {
  const t = String(s ?? '')
  const limit = Math.min(t.length, SENTENCE_SCAN_CHARS)
  for (let i = 0; i < limit; i++) {
    const ch = t[i]
    if ('。！？'.includes(ch)) return t.slice(0, i + 1)
    if ((ch === '.' || ch === '!' || ch === '?') && (i + 1 >= t.length || t[i + 1] === ' ')) return t.slice(0, i + 1)
  }
  return t
}

/**
 * 安全切片：不把代理对（emoji 等星平面字符）切成两半——切一半会在客户端
 * 渲染成替换字符。按 UTF-16 码元计数，仅在边界落在高代理项时回退一位。
 */
function sliceSafe(text, end) {
  const t = String(text ?? '')
  let at = Math.max(0, Math.min(end, t.length))
  const last = t.charCodeAt(at - 1)
  if (last >= 0xd800 && last <= 0xdbff) at -= 1
  return t.slice(0, at)
}

export function clip(text, max) {
  const t = String(text ?? '')
  return t.length > max ? sliceSafe(t, Math.max(0, max - 1)) + '…' : t
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

const cardBytes = (card) => byteLength(JSON.stringify(card))

/** 卡片 JSON 是否在预算内（发送前兜底判断）。 */
export function cardFitsBudget(card, byteBudget = CARD_BYTE_BUDGET) {
  return cardBytes(card) <= byteBudget
}

/**
 * 组装飞书卡片（JSON 2.0）。
 *
 * 为什么用 2.0（官方文档核对）：
 * - 1.0 的 markdown 组件**不支持标题 / 引用 / 表格**；2.0 支持「除 HTMLBlock 外
 *   所有标准 Markdown 语法」。真实语料里 79.2% 的正文含标题/表格/引用，所以
 *   1.0 下「展开后不按 md 渲染」是必然结果；2.0 下不需要任何降级转换代码。
 * - 2.0 有官方字段 `config.summary.content`，正是「聊天列表预览文案」的落点：
 *   摘要不必再挤进卡片头部按 80 字裁剪。
 * - 代价：需客户端 ≥7.20（低于则卡片内容显示升级提示）。本通道读者唯一，
 *   故按「不支持就升级客户端」处理。
 *
 * 约束（官方）：必须显式声明 schema 2.0；update_multi 仅支持 true；单卡最多
 * 200 个元素；消息体仍受 30KB 限制（错误码 230025）。
 *
 * @param {object} o
 * @param {string} o.summary  语义层给的摘要 → config.summary.content（聊天列表预览）
 * @param {string[]} o.bullets 语义层给的要点（0~3 条），常驻可见
 * @param {string} o.detail   原始回复全文 → 折叠面板内由 2.0 原生渲染 Markdown
 */
export function buildNotificationCardV2({
  title = '',
  turn,
  summary = '',
  bullets = [],
  detail = '',
  cwd = '',
  foldThresholdChars = DEFAULT_FOLD_THRESHOLD_CHARS,
  byteBudget = CARD_BYTE_BUDGET,
}) {
  const meta = [
    title,
    turn != null && turn !== '' ? 'turn ' + turn : '',
    cwd ? 'cwd: ' + cwd : '',
  ].filter(Boolean).join(' · ')
  const detailChars = String(detail ?? '').length
  const folded = detailChars > foldThresholdChars

  const build = (body, truncated) => {
    const elements = []
    if (bullets.length > 0) {
      elements.push({ tag: 'markdown', content: bullets.map((b) => '• ' + b).join('\n') })
    }
    if (body && !folded) {
      // 短回复本身就是一层，直接展示；折叠它只增加一次无谓点击。
      elements.push({ tag: 'markdown', content: body })
    } else if (body) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: {
            tag: 'markdown',
            content: `展开完整回复（${detailChars} 字${truncated ? '，已截断' : ''}）`,
          },
          icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
          icon_position: 'right',
          icon_expanded_angle: -180,
        },
        border: { color: 'grey', corner_radius: '5px' },
        vertical_spacing: '8px',
        padding: '8px 8px 8px 8px',
        elements: [{ tag: 'markdown', content: body }],
      })
    }
    if (meta) elements.push({ tag: 'markdown', content: meta })
    return {
      schema: '2.0',
      config: { update_multi: true, summary: { content: summary || title || 'dsh 回复总结' } },
      header: { template: 'blue', title: { tag: 'plain_text', content: title || 'dsh 回复总结' } },
      body: { elements },
    }
  }

  let body = String(detail ?? '')
  let truncated = false
  let card = build(body, truncated)
  for (let i = 0; i < BUDGET_ITERATIONS; i++) {
    if (cardBytes(card) <= byteBudget || body.length <= MIN_DETAIL_CHARS) break
    const over = cardBytes(card) - byteBudget
    const ratio = Math.max(0.5, 1 - over / Math.max(1, byteLength(body)))
    const nextLen = Math.max(MIN_DETAIL_CHARS, Math.floor(body.length * ratio))
    if (nextLen >= body.length) break
    body = sliceSafe(body, nextLen)
    truncated = true
    card = build(body, truncated)
  }
  return card
}
