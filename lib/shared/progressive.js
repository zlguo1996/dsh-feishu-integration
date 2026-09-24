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
/** 所有来源都拿不到可用标题时的结构哨兵（不是模型产出，也不冒充主题）。 */
export const TITLE_FALLBACK_SENTINEL = '本回合回复'
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
 * 纯文本形态的根消息（`notificationFormat:'text'`，以及卡片不可发送时的回退）。
 *
 * 与卡片**同一信息架构**：标题 / 摘要 / 要点 / 极简元信息；**不含完整回复**——
 * 完整回复由线程回复承接，不在根消息里重复。
 */
export function buildNotificationText({ title = '', turn, summary = '', bullets = [], cwd = '' } = {}) {
  const head = title || TITLE_FALLBACK_SENTINEL
  const meta = [
    turn != null && turn !== '' ? 'turn ' + turn : '',
    cwd ? 'cwd: ' + cwd : '',
  ].filter(Boolean).join(' · ')
  const lines = [head]
  if (summary) lines.push(summary)
  for (const b of bullets) lines.push('• ' + b)
  if (meta) { lines.push(''); lines.push(meta) }
  return lines.join('\n')
}

/**
 * 完整回复的**线程回复卡片**（JSON 2.0）。
 *
 * 为什么必须是卡片而不是纯文本：飞书**纯文本消息不渲染 Markdown**——`**加粗**`
 * 会原样显示成星号。只有卡片（`msg_type: 'interactive'`）的 `markdown` 组件会渲染
 * 加粗/标题/列表/表格/引用/代码块。完整回复几乎总是 Markdown，所以线程里必须发卡片。
 * （2026-09-24 实测对照：同一线程内卡片回复渲染加粗，纯文本回复显示星号。）
 *
 * 与根卡片的分工：根卡片承载「一眼看懂」的标题/摘要/要点；线程卡片只承载**原文**，
 * 正文**逐字不改**（不剥语法、不转换、不摘要），由 2.0 原生渲染。
 * 多分段时才加一个索引头（`完整回复 i/N`），否则不加任何 chrome。
 *
 * @param {object} o
 * @param {string} o.content 该分段的 Markdown 原文
 * @param {number} [o.index] 分段序号（从 1 起）
 * @param {number} [o.total] 分段总数
 */
export function buildThreadCardV2({ content = '', index = 1, total = 1 } = {}) {
  const body = String(content ?? '')
  const firstLine = body.split('\n').find((l) => l.trim()) ?? ''
  const card = {
    schema: '2.0',
    config: {
      update_multi: true,
      // 聊天列表预览用：取首个非空行并剥掉语法符号（预览是纯文本，渲染不了 Markdown）。
      summary: { content: clip(stripInline(firstLine), 80) || '完整回复' },
    },
    body: { elements: [{ tag: 'markdown', content: body }] },
  }
  if (total > 1) {
    card.header = {
      template: 'grey',
      title: { tag: 'plain_text', content: `完整回复 ${index}/${total}` },
    }
  }
  return card
}

/**
 * 把完整回复切成「每张线程卡片都不超预算」的分段。
 *
 * 为什么不能直接用 splitText（按字符数切）：卡片有 **30KB 硬上限**（错误码 230025），
 * 而 JSON 转义 + 中文 3 字节/字符会让字节数远大于字符数——按字符切无法保证体积。
 * 这里对**真实卡片 JSON** 做二分，按字节定长切，并优先落在换行处，避免把一段话
 * 从中间劈开。只切分，不改写任何字符。
 *
 * @param {string} text Markdown 原文
 * @param {{byteBudget?: number, maxChunks?: number}} [opts]
 * @returns {string[]}
 */
export function splitReplyForCards(text, { byteBudget = CARD_BYTE_BUDGET, maxChunks = 40 } = {}) {
  const all = String(text ?? '')
  if (!all) return []
  const fits = (s) => cardBytes(buildThreadCardV2({ content: s, index: 1, total: 2 })) <= byteBudget
  const chunks = []
  let rest = all
  while (rest && chunks.length < maxChunks) {
    if (fits(rest)) { chunks.push(rest); rest = ''; break }
    // 二分出「最长的、装得下」的前缀（按 UTF-16 码元计，用 sliceSafe 保证不切开代理对）。
    let lo = 1
    let hi = rest.length
    let best = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (fits(sliceSafe(rest, mid))) { best = mid; lo = mid + 1 } else hi = mid - 1
    }
    if (best <= 0) best = 1  // 极端：单字符就超预算（此时也只能前进，避免死循环）
    let cut = best
    const nl = rest.lastIndexOf('\n', cut)
    if (nl > Math.floor(cut * 0.6)) cut = nl + 1   // 优先在换行处切
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) chunks.push(rest)  // maxChunks 兜底：宁可最后一段超一点，也不能丢内容
  return chunks
}

/**
 * 组装飞书卡片（JSON 2.0）。
 *
 * ── 信息架构（Codex FINAL，2026-09-24 修订）────────────────────────────
 * 卡片本身只管「一眼看懂」：主题标题 + 针对本回合问题的摘要 + 0~3 条要点 +
 * 极简元信息。**完整回复不再放进卡片**，它由飞书原生话题（线程）承接：卡片是
 * 话题根消息，完整回复是它下面的线程回复，读者点卡片上的「N 条回复」进入。
 *
 * 唯一的例外是显式降级：当线程投递能力不可用时（`allowDetailFallback: true`），
 * 才允许把正文折回 `collapsible_panel`。正常路径**必须**保持 false。
 *
 * 为什么用 2.0（官方文档核对）：
 * - 1.0 的 markdown 组件**不支持标题 / 引用 / 表格**；2.0 支持「除 HTMLBlock 外
 *   所有标准 Markdown 语法」。真实语料里 79.2% 的正文含标题/表格/引用，所以
 *   1.0 下「展开后不按 md 渲染」是必然结果；2.0 下不需要任何降级转换代码。
 * - 2.0 有官方字段 `config.summary.content`，正是「聊天列表预览文案」的落点。
 * - 代价：需客户端 ≥7.20（低于则卡片内容显示升级提示）。本通道读者唯一。
 *
 * 约束（官方）：必须显式声明 schema 2.0；update_multi 仅支持 true；单卡最多
 * 200 个元素；消息体仍受 30KB 限制（错误码 230025）。
 *
 * @param {object} o
 * @param {string} o.title        主题标题（≤20 字，由语义层/兜底给出）→ header.title
 * @param {number|string} [o.turn] 回合号 → 元信息
 * @param {string} o.summary      针对本回合问题的摘要 → config.summary.content + 正文可见
 * @param {string[]} o.bullets    要点（0~3 条）
 * @param {string} [o.cwd]        工作目录 → 元信息
 * @param {string} [o.detail]     完整回复；**仅**在 allowDetailFallback 时有意义
 * @param {boolean} [o.allowDetailFallback=false] 线程投递不可用时的显式降级开关
 */
export function buildNotificationCardV2({
  title = '',
  turn,
  summary = '',
  bullets = [],
  detail = '',
  allowDetailFallback = false,
  cwd = '',
  foldThresholdChars = DEFAULT_FOLD_THRESHOLD_CHARS,
  byteBudget = CARD_BYTE_BUDGET,
}) {
  // 元信息只保留 turn 与 cwd：不带标题、不带任何固定文案。
  const meta = [
    turn != null && turn !== '' ? 'turn ' + turn : '',
    cwd ? 'cwd: ' + cwd : '',
  ].filter(Boolean).join(' · ')
  const detailChars = String(detail ?? '').length
  const folded = detailChars > foldThresholdChars
  const head = title || TITLE_FALLBACK_SENTINEL

  const build = (body, truncated) => {
    const elements = []
    // 摘要必须**在卡片里可见**：只放 config.summary.content 只是聊天列表预览，
    // 满足不了「一眼看懂」。
    if (summary) elements.push({ tag: 'markdown', content: summary })
    if (bullets.length > 0) {
      elements.push({ tag: 'markdown', content: bullets.map((b) => '• ' + b).join('\n') })
    }
    if (allowDetailFallback && body && folded) {
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
    } else if (allowDetailFallback && body) {
      elements.push({ tag: 'markdown', content: body })
    }
    if (meta) elements.push({ tag: 'markdown', content: meta })
    return {
      schema: '2.0',
      config: { update_multi: true, summary: { content: summary || head } },
      header: { template: 'blue', title: { tag: 'plain_text', content: head } },
      body: { elements },
    }
  }

  // 正常路径没有正文：卡片只有几百字节。预算收缩循环只为降级路径服务。
  if (!allowDetailFallback) return build('', false)

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
