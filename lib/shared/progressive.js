/**
 * 通知分层（progressive disclosure）：把一段 assistant 回复压成「一行头部 +
 * 可选要点 + 可折叠全文」，并组装成飞书卡片。纯函数、无副作用（测试缝）。
 *
 * ── 设计不变量（这是本模块唯一需要记住的规则）──────────────────────────
 * 1. 只说结构，不做语义猜测。信息来源只有 Markdown 结构（标题/列表/段落/
 *    围栏/引用），不猜「哪句话是结论」。
 * 2. 绝不改写正文。只允许剥掉 Markdown 语法符号（#、**、`、链接语法），
 *    不删除、不替换任何正文字符，也不做「一、」这类序号清洗——那属于改写
 *    作者原文，且实测会误伤 "1.1 标题"。
 * 3. 唯一的数值启发式是「标题短于 12 字就补后文首句」。12 不是拍的：
 *    在 2462 条真实推送上线扫描，空洞头部（≤8 字）占比在 T=8/12/16/24 时
 *    分别为 6.1% / 3.6% / 3.6% / 3.6%，而头部中位长度 21/25/31/42 ——
 *    T=12 是拐点：再往上只增长度、不再降空洞。
 *
 * 本文件刻意不包含任何「结论：」「TL;DR」「Goal marked complete」「一、」之类
 * 的短语表：实测这类规则会改写正文（旧实现里 61 条标题被 marker 正则截短、
 * 4 条 "1.1" 被序号正则吃成 "1"），用不可靠的匹配伪造可靠。
 */

/** 折叠正文的最大字符数。折叠态不占聊天列表空间，可比纯文本宽松。 */
export const DEFAULT_MAX_DETAIL_CHARS = 6000
/** 短于此长度不折叠：不为一条短消息增加一次点击。 */
export const DEFAULT_FOLD_THRESHOLD_CHARS = 400
/** 卡片头部（= 聊天列表预览）的最大字符数。 */
export const HEADER_MAX_CHARS = 80
/** 标题短于此长度时，与后文首句组合，避免头部只剩一个空洞标签。 */
export const HEADER_COMPOSE_BELOW = 12
export const BULLET_MAX_CHARS = 60
export const MAX_BULLETS = 5
/** 飞书卡片消息体硬上限 30KB（错误码 230025），留 20% 余量作安全线。 */
export const CARD_BYTE_BUDGET = 24 * 1024
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

/** 头部：首个标题（过短则补后文首句）→ 首段首句。 */
function pickHeader(blocks, composeBelow) {
  const hi = blocks.findIndex((b) => b.type === 'heading')
  if (hi >= 0) {
    const base = stripInline(blocks[hi].text)
    if (composeBelow > 0 && base.length < composeBelow) {
      const after = blocks.slice(hi + 1).find((b) => b.type === 'paragraph' || b.type === 'list')
      const tail = after
        ? firstSentence(stripInline(after.type === 'list' ? after.items[0] : after.text))
        : ''
      if (tail) {
        // 标题本身可能已以冒号结尾（如「问题1：」），此时不再重复插入。
        const separator = /[：:]$/.test(base) ? '' : '：'
        // base / tail / separator 一并回传：组合是唯一「拼接」而非「切片」的地方，
        // 调用方（审计、测试）据此逐段校验，不必去猜拼接点在哪。
        return { header: base + separator + tail, source: 'composed', base, tail, separator }
      }
    }
    return { header: base, source: 'heading', base, tail: '', separator: '' }
  }
  const p = blocks.find((b) => b.type === 'paragraph')
  if (p) return { header: firstSentence(stripInline(p.text)), source: 'paragraph', base: '', tail: '', separator: '' }
  return { header: '', source: 'none', base: '', tail: '', separator: '' }
}

/** 要点：文档里第一个列表块，最多 5 条；没有列表就不编造。 */
function pickBullets(blocks) {
  const list = blocks.find((b) => b.type === 'list' && b.items.length > 0)
  if (!list) return []
  return list.items.slice(0, MAX_BULLETS)
    .map((item) => clip(stripInline(item), BULLET_MAX_CHARS))
    .filter(Boolean)
}

/**
 * 抽取通知三层。
 * @param {string} text 原始 assistant 回复
 * @param {{maxDetailChars?: number, foldThresholdChars?: number, composeBelow?: number}} [opts]
 */
export function describeReply(text, opts = {}) {
  const {
    maxDetailChars = DEFAULT_MAX_DETAIL_CHARS,
    foldThresholdChars = DEFAULT_FOLD_THRESHOLD_CHARS,
    composeBelow = HEADER_COMPOSE_BELOW,
  } = opts
  const raw = String(text ?? '')
  const blocks = parseBlocks(raw)
  const { header, source, base, tail, separator } = pickHeader(blocks, composeBelow)
  const detailFull = raw.trim()
  const truncated = detailFull.length > maxDetailChars
  return {
    header: clip(header, HEADER_MAX_CHARS),
    headerSource: source,
    // 组合头部逐段回传（untouched by clip），供调用方校验「未改写原文」。
    headerBase: base,
    headerTail: tail,
    headerSeparator: separator,
    bullets: pickBullets(blocks),
    detail: truncated ? detailFull.slice(0, maxDetailChars) : detailFull,
    detailChars: detailFull.length,
    folded: detailFull.length > foldThresholdChars,
    truncated,
  }
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

const cardBytes = (card) => byteLength(JSON.stringify(card))

/**
 * 组装飞书卡片（JSON 1.0）。
 *
 * 头部放「抽出来的一行」而不是固定标题：飞书聊天列表的预览就是卡片头部，
 * 所以头部承担 progressive disclosure 的 L0，点开才看到 L1/L2。
 * 长回复：要点常驻可见 + collapsible_panel 折叠全文（就地展开，不新增消息）。
 * 短回复：正文本身就只有一层，直接展示。
 */
export function buildNotificationCard({
  title = '',
  turn,
  cwd = '',
  layers,
  byteBudget = CARD_BYTE_BUDGET,
}) {
  const fallbackHead = [title, turn != null && turn !== '' ? 'turn ' + turn : ''].filter(Boolean).join(' · ')
  const head = layers.header || fallbackHead || 'dsh'

  const build = (detail, truncated) => {
    const elements = []
    if (layers.folded) {
      if (layers.bullets.length > 0) {
        elements.push({
          tag: 'markdown',
          content: layers.bullets.map((b) => '• ' + b).join('\n'),
        })
      }
      if (detail) {
        elements.push({
          tag: 'collapsible_panel',
          expanded: false,
          header: {
            title: {
              tag: 'markdown',
              content: `展开完整回复（${layers.detailChars} 字${truncated ? '，已截断' : ''}）`,
            },
            icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
            icon_position: 'right',
            icon_expanded_angle: -180,
          },
          border: { color: 'grey', corner_radius: '5px' },
          vertical_spacing: '8px',
          padding: '8px 8px 8px 8px',
          elements: [{ tag: 'markdown', content: detail }],
        })
      }
    } else if (detail) {
      elements.push({ tag: 'markdown', content: detail })
    }
    const meta = [fallbackHead, cwd ? 'cwd: ' + cwd : ''].filter(Boolean).join('　·　')
    if (meta) elements.push({ tag: 'markdown', content: meta })
    return {
      config: { wide_screen_mode: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: head } },
      elements,
    }
  }

  let detail = layers.detail
  let truncated = layers.truncated
  let card = build(detail, truncated)
  for (let i = 0; i < BUDGET_ITERATIONS; i++) {
    if (cardBytes(card) <= byteBudget || detail.length <= MIN_DETAIL_CHARS) break
    const over = cardBytes(card) - byteBudget
    const ratio = Math.max(0.5, 1 - over / Math.max(1, byteLength(detail)))
    const nextLen = Math.max(MIN_DETAIL_CHARS, Math.floor(detail.length * ratio))
    if (nextLen >= detail.length) break
    detail = sliceSafe(detail, nextLen)
    truncated = true
    card = build(detail, truncated)
  }
  return card
}

/** 卡片 JSON 是否在预算内（发送前兜底判断）。 */
export function cardFitsBudget(card, byteBudget = CARD_BYTE_BUDGET) {
  return cardBytes(card) <= byteBudget
}

/**
 * 卡片 JSON 2.0 版本。
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
 */
export function buildNotificationCardV2({
  title = '',
  turn,
  summary = '',
  bullets = [],
  detail = '',
  cwd = '',
  byteBudget = CARD_BYTE_BUDGET,
}) {
  const meta = [
    title,
    turn != null && turn !== '' ? 'turn ' + turn : '',
    cwd ? 'cwd: ' + cwd : '',
  ].filter(Boolean).join(' · ')
  const detailChars = String(detail ?? '').length

  const build = (body, truncated) => {
    const elements = []
    if (bullets.length > 0) {
      elements.push({ tag: 'markdown', content: bullets.map((b) => '• ' + b).join('\n') })
    }
    if (body) {
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
