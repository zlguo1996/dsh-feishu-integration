/**
 * 通知分层（progressive disclosure）：把一段 assistant 回复抽成
 *   L0 结论行（必有）/ L1 要点（可空）/ L2 全文（折叠）
 * 并组装成飞书 interactive 卡片。全部纯函数、无副作用（测试缝）。
 *
 * 设计约束（来自对 19 条真实推送的回测）：
 * - 只做「引用」，不改写语义：结论行必须能在原文里找到出处。生成式摘要
 *   可能给出自信但失真的结论，而结论行的唯一用途就是让用户判断「要不要
 *   点开细看」——一条错误的结论行会直接毁掉这个判断。
 * - 跳过代码围栏与引用块，跳过叙述型开场（如 "Goal marked complete.
 *   Now let me…"），并剥掉中文序号前缀（"一、"）：否则章节标签会被误当
 *   结论、要点会抓到编译错误行。
 * - 飞书卡片消息体硬上限 30KB（错误码 230025），按 UTF-8 字节而非字符数
 *   做预算（中文 1 字 = 3 字节）。
 */

/** 折叠正文的最大字符数。折叠态不占聊天列表空间，可比纯文本宽松得多。 */
export const DEFAULT_MAX_DETAIL_CHARS = 6000
/** 短回复不折叠：不为一条短消息增加一次点击成本。 */
export const DEFAULT_FOLD_THRESHOLD_CHARS = 400
export const HEADLINE_MAX_CHARS = 80
export const BULLET_MAX_CHARS = 60
export const MAX_BULLETS = 5
/** 只在前 N 行找结论：再往后基本都是细节。 */
const SCAN_LINES = 60
/** 飞书卡片消息体 30KB 硬上限，留 20% 余量作安全线。 */
export const CARD_BYTE_BUDGET = 24 * 1024
/** 压缩正文时的下限与迭代上限，保证有界收敛。 */
const MIN_DETAIL_CHARS = 200
const BUDGET_ITERATIONS = 24

const FENCE_RE = /^\s*(?:```|~~~)/
const QUOTE_RE = /^\s*>/
const HEADING_RE = /^#{1,6}\s+(.+)$/
const LIST_RE = /^([-*+•]|\d+[.)])\s+(.+)$/

/** 显式结论标记：作者已替我们写出结论时优先采用。 */
const MARKER_RES = [
  /^(?:结论|总结|摘要|要点|TL;?DR|Summary|Result)\s*[:：]\s*(.+)$/i,
  /^#{1,6}\s*(?:结论|总结|摘要)\s*[:：]?\s*(.+)$/,
]
/** 中文序号章节前缀："一、"、"（2）"、"第 3 步"、"(3)"。 */
const ORDINAL_RE = /^(?:第?\s*[一二三四五六七八九十百]+\s*[、.．)）]|[(（]\s*\d+\s*[)）]|\d+\s*[、.．)）])\s*/
/** 叙述型开场：不是结论，而是「我接下来要做什么」。 */
const NARRATION_PREFIX_RE = /^(?:goal marked complete|now let me|let me\b|i'?ll\b|i will\b|next[, ]|continuing\b|我(?:来|先|接下来)|让(?:我|我们)|接下来(?:我|先)|先(?:看|说)|待我)/i
/** 纯填充语：整行只有这些词时不算结论。 */
const NARRATION_EXACT_RE = /^(?:已完成|完成|好的|好|收到|明白|ok|okay|done|goal marked complete)[。.!！,，]?$/i

function clip(text, max) {
  const t = String(text ?? '')
  return t.length > max ? t.slice(0, Math.max(0, max - 1)) + '…' : t
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

function cardBytes(card) {
  return byteLength(JSON.stringify(card))
}

function stripOrdinal(s) {
  return String(s ?? '').replace(ORDINAL_RE, '').trim()
}

/** 去掉行内 Markdown 装饰，保留人类可读文本。 */
function stripInline(s) {
  return String(s ?? '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*+•]\s+/, '')
    .trim()
}

function clean(s) {
  return stripInline(stripOrdinal(s))
}

function isNarration(s) {
  const t = String(s ?? '').trim()
  return NARRATION_PREFIX_RE.test(t) || NARRATION_EXACT_RE.test(t)
}

/** 取首句：中文以 。！？ 断句，英文以 ". " 断句，最长看 120 字。 */
function firstSentence(s) {
  const t = String(s ?? '')
  const limit = Math.min(t.length, 120)
  for (let i = 0; i < limit; i++) {
    const ch = t[i]
    if ('。！？'.includes(ch)) return t.slice(0, i + 1)
    if ((ch === '.' || ch === '!' || ch === '?') && (i + 1 >= t.length || t[i + 1] === ' ')) {
      return t.slice(0, i + 1)
    }
  }
  return t
}

/**
 * 把原文切成带类型标注的行；代码围栏内的内容单独标记，避免被当成标题/列表。
 * @returns {Array<{line: string, kind: 'fence'|'code'|'blank'|'quote'|'heading'|'list'|'para'}>}
 */
function scan(text) {
  const out = []
  let fence = false
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (FENCE_RE.test(line)) {
      fence = !fence
      out.push({ line: trimmed, kind: 'fence' })
      continue
    }
    if (fence) {
      out.push({ line: trimmed, kind: 'code' })
      continue
    }
    if (!trimmed) {
      out.push({ line: '', kind: 'blank' })
      continue
    }
    if (QUOTE_RE.test(line)) {
      out.push({ line: trimmed, kind: 'quote' })
      continue
    }
    if (HEADING_RE.test(trimmed)) {
      out.push({ line: trimmed, kind: 'heading' })
      continue
    }
    if (LIST_RE.test(trimmed)) {
      out.push({ line: trimmed, kind: 'list' })
      continue
    }
    out.push({ line: trimmed, kind: 'para' })
  }
  return out
}

/** L0：显式标记 → 首个标题 → 首个非叙述段落 → 兜底首行。 */
function pickHeadline(items) {
  const usable = items
    .slice(0, SCAN_LINES)
    .filter((i) => i.kind === 'para' || i.kind === 'heading' || i.kind === 'list')

  for (const item of usable) {
    for (const re of MARKER_RES) {
      const m = item.line.match(re)
      if (m) {
        const t = clean(m[1])
        if (t) return t
      }
    }
  }

  for (const item of usable) {
    if (item.kind !== 'heading') continue
    const m = item.line.match(HEADING_RE)
    const t = clean(m ? m[1] : item.line)
    if (t && !isNarration(t)) return t
  }

  for (const item of usable) {
    if (item.kind === 'list') continue
    const t = firstSentence(clean(item.line))
    if (t && !isNarration(t)) return t
  }

  // 兜底：整段都是叙述型开场时，仍给一行原文，绝不编造。
  for (const item of usable) {
    const t = firstSentence(clean(item.line))
    if (t) return t
  }
  return ''
}

/** L1：原文中第一个连续列表块；没有列表就留空（不编造要点）。 */
function pickBullets(items) {
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== 'list') continue
    const out = []
    for (let j = i; j < items.length && out.length < MAX_BULLETS; j++) {
      if (items[j].kind !== 'list') break
      const m = items[j].line.match(LIST_RE)
      const t = clean(m ? m[2] : items[j].line)
      if (t) out.push(t)
    }
    if (out.length > 0) return out
  }
  return []
}

/**
 * 抽取三层内容。
 * @param {string} text 原始 assistant 回复
 * @param {{maxDetailChars?: number, foldThresholdChars?: number}} [opts]
 * @returns {{headline: string, bullets: string[], detail: string, detailChars: number, folded: boolean, truncated: boolean}}
 */
export function extractLayers(text, opts = {}) {
  const {
    maxDetailChars = DEFAULT_MAX_DETAIL_CHARS,
    foldThresholdChars = DEFAULT_FOLD_THRESHOLD_CHARS,
  } = opts
  const raw = String(text ?? '')
  const items = scan(raw)
  const headline = clip(pickHeadline(items), HEADLINE_MAX_CHARS)
  const bullets = pickBullets(items).map((b) => clip(b, BULLET_MAX_CHARS))
  const detailFull = raw.trim()
  const truncated = detailFull.length > maxDetailChars
  return {
    headline,
    bullets,
    detail: truncated ? detailFull.slice(0, maxDetailChars) : detailFull,
    detailChars: detailFull.length,
    folded: detailFull.length > foldThresholdChars,
    truncated,
  }
}

/**
 * 组装飞书卡片（卡片 JSON 1.0：config / header / elements）。
 * collapsible_panel 默认折叠（expanded:false），展开在同一条消息内完成，
 * 不额外产生消息——这正是它优于「按需再发一条长文本」的地方。
 * 若整个卡片 JSON 超过字节预算，就收缩正文直到达标（折叠正文可安全截断）。
 */
export function buildNotificationCard({
  title = '',
  turn,
  cwd = '',
  layers,
  byteBudget = CARD_BYTE_BUDGET,
}) {
  const head = [title, turn != null && turn !== '' ? 'turn ' + turn : ''].filter(Boolean).join(' · ')

  const build = (detail, truncated) => {
    const elements = []
    // 折叠态（长回复）：结论行 + 要点常驻可见，正文收进折叠面板。
    // 非折叠态（短回复）：内容本身就一层，直接展示——不再重复一行结论，
    // 否则短消息里「结论行 + 正文」会把同一句话显示两遍。
    if (layers.folded) {
      if (layers.headline) {
        elements.push({ tag: 'markdown', content: '**' + layers.headline + '**' })
      }
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
    if (cwd) elements.push({ tag: 'markdown', content: 'cwd: ' + cwd })
    return {
      config: { wide_screen_mode: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: head || 'dsh' } },
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
    detail = detail.slice(0, nextLen)
    truncated = true
    card = build(detail, truncated)
  }
  return card
}

/** 卡片 JSON 是否超出预算（供调用方在发送前兜底判断）。 */
export function cardFitsBudget(card, byteBudget = CARD_BYTE_BUDGET) {
  return cardBytes(card) <= byteBudget
}
