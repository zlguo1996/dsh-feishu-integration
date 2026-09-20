import test from 'node:test'
import assert from 'node:assert/strict'

import {
  describeReply,
  buildNotificationCard,
  cardFitsBudget,
  parseBlocks,
  CARD_BYTE_BUDGET,
  DEFAULT_MAX_DETAIL_CHARS,
  HEADER_COMPOSE_BELOW,
} from '../lib/shared/progressive.js'

const panel = (card) => card.elements.find((e) => e.tag === 'collapsible_panel')
const markdowns = (card) => card.elements.filter((e) => e.tag === 'markdown').map((e) => e.content)

// ── 不变量 1：绝不改写正文 ────────────────────────────────────────────────
// 这组用例全部来自真实语料里被旧实现改坏的样本。旧实现用 marker / 序号正则
// 「清洗」标题，实际是在改写作者原文。

test('不改写多级编号标题（旧实现把 "1.1" 吃成 "1"）', () => {
  const text = '## 1.1 一个比喻先立起来：数字人 = 一家私人助理事务所\n\n后续说明。'
  assert.equal(describeReply(text).header, '1.1 一个比喻先立起来：数字人 = 一家私人助理事务所')
})

test('不把「摘要」当标记而截掉标题前半段（旧实现改坏过）', () => {
  const text = '## 摘要已交付：/tmp/s76_摘要.md\n\n说明文字。'
  assert.equal(describeReply(text).header, '摘要已交付：/tmp/s76_摘要.md')
})

test('不动「结论：」这类前缀，刻意去掉它也属于改写（旧实现会去掉）', () => {
  const text = '## 结论：不允许。但它有两道闸，两道都会漏\n\n说明。'
  assert.equal(describeReply(text).header, '结论：不允许。但它有两道闸，两道都会漏')
})

test('保留中文序号前缀「一、」——剥掉它属于改写原文', () => {
  // 标题足够长：原样保留
  assert.equal(
    describeReply('## 一、验收结果与相关背景说明\n\n后面还有正文。').header,
    '一、验收结果与相关背景说明',
  )
  // 标题过短触发组合时，序号同样保留（组合只做追加，不做删除）
  assert.ok(describeReply('## 一、验收结果\n\n后面还有正文。').header.startsWith('一、验收结果'))
})

// ── 不变量 2：只说结构，不猜语义 ──────────────────────────────────────────

test('代码围栏内的 # 与 - 不是结构', () => {
  const text = ['```', '# not a heading', '- not a list', '```', '', '真实段落。'].join('\n')
  const layers = describeReply(text)
  assert.equal(layers.header, '真实段落。')
  assert.deepEqual(layers.bullets, [])
})

test('引用块不作为标题或要点', () => {
  const text = ['> 引用不是结论', '', '真段落。'].join('\n')
  assert.equal(describeReply(text).header, '真段落。')
})

test('parseBlocks 把结构块切干净，且段落不吞掉水平线以外的结构', () => {
  const blocks = parseBlocks(['# 标题', '', '- 一', '- 二', '', '段落。', '', '```', 'code', '```'].join('\n'))
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'list', 'paragraph', 'code'])
})

test('首个非空行是水平线的情况在真实语料中为 0，因此不特判（记录了该决定）', () => {
  // 语料 2462 条中 0 条以水平线开头；加 hr 规则属于无收益的复杂化。
  const layers = describeReply('---')
  assert.equal(typeof layers.header, 'string')
})

// ── 唯一的数值启发式：标题过短则补后文首句（T=12 来自拐点测量）────────────

test('默认阈值就是 12（拐点：再往上只增长度、不降空洞）', () => {
  assert.equal(HEADER_COMPOSE_BELOW, 12)
})

test('标题过短时与后文首句组合，避免头部只剩空洞标签', () => {
  const text = '## 核心发现\n\n这段是 4 个 turn，全部正常收尾。补充说明。'
  assert.equal(describeReply(text).header, '核心发现：这段是 4 个 turn，全部正常收尾。')
  assert.equal(describeReply(text).headerSource, 'composed')
})

test('标题足够长时不组合，保持原文', () => {
  const text = '## 这是一条信息量足够的标题\n\n后面一段。'
  const layers = describeReply(text)
  assert.equal(layers.header, '这是一条信息量足够的标题')
  assert.equal(layers.headerSource, 'heading')
})

test('标题过短但后面没有内容时，只有标题，不编造', () => {
  const layers = describeReply('## 交付物')
  assert.equal(layers.header, '交付物')
  assert.equal(layers.headerSource, 'heading')
})

test('后面只有列表时，组合取列表首项', () => {
  const text = '## 产出\n\n- report/verdicts/group-07.jsonl — 58 条判定\n- 另一条\n'
  assert.equal(describeReply(text).header, '产出：report/verdicts/group-07.jsonl — 58 条判定')
})

test('composeBelow=0 可关闭组合（阈值可配、可关）', () => {
  const text = '## 核心发现\n\n这段是 4 个 turn。'
  assert.equal(describeReply(text, { composeBelow: 0 }).header, '核心发现')
})

test('无标题时退回首个段落的首句', () => {
  const text = '分支已包含最新主干，落后 0 个提交。后面还有别的。'
  const layers = describeReply(text)
  assert.equal(layers.header, '分支已包含最新主干，落后 0 个提交。')
  assert.equal(layers.headerSource, 'paragraph')
})

test('组合头部逐段回传 base/tail/separator（审计据此校验，不必猜拼接点）', () => {
  // 真实语料里的形态：标题本身含全角冒号、去装饰后不足 12 字 → 触发组合。
  // 旧审计按「首个冒号」切分，在这种输入上切错，误报为「改写了原文」。
  const text = '## 一、权限：**结论要推翻**\n\n我上一条说「权限已加好」，这是错的。'
  const l = describeReply(text)
  assert.equal(l.headerSource, 'composed')
  assert.equal(l.headerBase, '一、权限：结论要推翻')
  assert.equal(l.headerTail, '我上一条说「权限已加好」，这是错的。')
  assert.equal(l.header, l.headerBase + l.headerSeparator + l.headerTail)
})

test('标题本身以冒号结尾时不再重复插入分隔符', () => {
  const l = describeReply('## 问题1：\n\n这个问题的答案是另一个。')
  assert.equal(l.headerBase, '问题1：')
  assert.equal(l.headerSeparator, '')
  assert.ok(!l.header.includes('：：'))
})

test('裁剪不切开 emoji（代理对切一半会在客户端显示成替换字符）', () => {
  const layers = describeReply('# ' + '🎯'.repeat(60) + ' 标题正文')
  // 去掉成对代理项后不应残留孤立代理项
  const stripped = layers.header.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
  assert.ok(!/[\uD800-\uDFFF]/.test(stripped), '存在被切开的代理对')
})

// ── 要点：第一个列表块，没有就不编造 ────────────────────────────────────

test('要点取第一个连续列表块，最多 5 条并去 Markdown 装饰', () => {
  const text = ['# 标题足够长不需要组合', '', '- **加粗** 一条', '- `code` 二条', '- 三条', '- 四条', '- 五条', '- 六条'].join('\n')
  const layers = describeReply(text)
  assert.equal(layers.bullets.length, 5)
  assert.equal(layers.bullets[0], '加粗 一条')
  assert.equal(layers.bullets[1], 'code 二条')
})

test('没有列表就没有要点', () => {
  assert.deepEqual(describeReply('一段没有列表的普通正文，足够长到超过组合阈值。').bullets, [])
})

test('要点单条被裁剪到 60 字以内', () => {
  const layers = describeReply('# 标题\n\n- ' + 'x'.repeat(200))
  assert.ok(layers.bullets[0].length <= 60)
})

// ── 折叠与截断阈值 ──────────────────────────────────────────────────────

test('短回复不折叠', () => {
  assert.equal(describeReply('好的，已完成。').folded, false)
})

test('长回复折叠，超过 maxDetailChars 才截断', () => {
  const many = describeReply('x'.repeat(7000))
  assert.equal(many.folded, true)
  assert.equal(many.truncated, true)
  assert.equal(many.detail.length, DEFAULT_MAX_DETAIL_CHARS)
  assert.equal(many.detailChars, 7000)

  const mid = describeReply('y'.repeat(4000))
  assert.equal(mid.folded, true)
  assert.equal(mid.truncated, false)
})

test('空输入不抛错', () => {
  const layers = describeReply('')
  assert.equal(layers.header, '')
  assert.deepEqual(layers.bullets, [])
  assert.equal(layers.detail, '')
  assert.equal(layers.folded, false)
})

// ── 卡片组装 ────────────────────────────────────────────────────────────

test('长回复：头部=抽取行，要点常驻，正文进默认折叠面板', () => {
  const layers = describeReply(['## 核心发现', '', '- 要点一', '', 'x'.repeat(800)].join('\n'))
  const card = buildNotificationCard({ title: 'dsh 回复总结', turn: 12, cwd: '/tmp/w', layers })
  assert.equal(card.header.title.content, '核心发现：要点一')
  const p = panel(card)
  assert.ok(p, '应有 collapsible_panel')
  assert.equal(p.expanded, false)
  assert.equal(p.header.icon_expanded_angle, -180)
  assert.equal(markdowns(card)[0], '• 要点一')
  assert.ok(markdowns(card).some((m) => m.includes('dsh 回复总结') && m.includes('turn 12') && m.includes('cwd: /tmp/w')))
})

test('短回复：正文直接可见，不产出折叠面板', () => {
  const layers = describeReply('结论：已修复。')
  const card = buildNotificationCard({ title: 'dsh 回复总结', turn: 3, layers })
  assert.equal(panel(card), undefined)
  assert.ok(markdowns(card).some((m) => m === '结论：已修复。'))
})

test('抽取不到头部时回退到「标题 · turn」', () => {
  const layers = describeReply('```\ncode only\n```')
  const card = buildNotificationCard({ title: 'dsh 回复总结', turn: 7, layers })
  assert.equal(card.header.title.content, 'dsh 回复总结 · turn 7')
})

test('超大正文被压到字节预算内（卡片硬上限 30KB，安全线 24KB）', () => {
  const layers = describeReply('中'.repeat(20000), { maxDetailChars: 20000 })
  const card = buildNotificationCard({ title: 'dsh 回复总结', turn: 99, cwd: '/tmp/w', layers })
  const bytes = Buffer.byteLength(JSON.stringify(card), 'utf8')
  assert.ok(bytes <= CARD_BYTE_BUDGET, `card=${bytes} 超过 ${CARD_BYTE_BUDGET}`)
  assert.equal(cardFitsBudget(card), true)
  assert.ok(panel(card).header.title.content.includes('已截断'))
})

test('预算收缩有界收敛：极端输入也不会死循环', () => {
  const layers = describeReply('中'.repeat(60000), { maxDetailChars: 60000 })
  const card = buildNotificationCard({ title: 't', turn: 1, layers, byteBudget: 2000 })
  assert.ok(Buffer.byteLength(JSON.stringify(card), 'utf8') <= 2000 * 4)
  assert.ok(panel(card).elements[0].content.length > 0)
})
