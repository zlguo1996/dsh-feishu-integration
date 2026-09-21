import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildNotificationCardV2,
  cardFitsBudget,
  clip,
  firstSentence,
  parseBlocks,
  stripInline,
  CARD_BYTE_BUDGET,
  DEFAULT_FOLD_THRESHOLD_CHARS,
} from '../lib/shared/progressive.js'

/**
 * 本文件只覆盖**结构层**（progressive.js）：Markdown 结构解析 + 卡片 2.0 渲染。
 * 语义层（哪句话是摘要）在 notification-digest.js，其测试见 notification-summary.test.mjs。
 *
 * 曾经这里还有一大组 `describeReply` 的头部/要点启发式测试（标题优先、短标题补句、
 * 序号保留…）。那些规则已在第三批删除——它们用不可靠的文本匹配伪造可靠性，
 * 实测会改写作者原文。语义现在交给发送层 LLM，兜底只做逐字引用。
 */

const panel = (card) => card.body.elements.find((e) => e.tag === 'collapsible_panel')
const markdowns = (card) => card.body.elements.filter((e) => e.tag === 'markdown').map((e) => e.content)

// ── 不变量：绝不改写正文 ────────────────────────────────────────────────
// 这组用例来自真实语料里被旧实现改坏的样本。旧实现用 marker / 序号正则「清洗」
// 文本，实际是在改写作者原文。现在唯一允许的加工就是这里验的「只剥语法符号」。

test('stripInline 保留多级编号（旧实现把 "1.1" 吃成 "1"）', () => {
  assert.equal(stripInline('1.1 一个比喻先立起来：数字人 = 一家私人助理事务所'),
    '1.1 一个比喻先立起来：数字人 = 一家私人助理事务所')
})

test('stripInline 不把「摘要」当标记而截掉前半段（旧实现改坏过）', () => {
  assert.equal(stripInline('摘要已交付：/tmp/s76_摘要.md'), '摘要已交付：/tmp/s76_摘要.md')
})

test('stripInline 保留「结论：」这类前缀，也不动中文序号「一、」', () => {
  assert.equal(stripInline('结论：不允许。但它有两道闸'), '结论：不允许。但它有两道闸')
  assert.equal(stripInline('一、验收结果与相关背景说明'), '一、验收结果与相关背景说明')
})

test('stripInline 只剥 Markdown 语法符号', () => {
  assert.equal(stripInline('**加粗** 与 `code` 与 [链接](https://x/y)'), '加粗 与 code 与 链接')
})

test('parseBlocks 不把围栏内的 # 与 - 当结构', () => {
  const text = ['```', '# not a heading', '- not a list', '```', '', '真实段落。'].join('\n')
  const blocks = parseBlocks(text)
  assert.deepEqual(blocks.map((b) => b.type), ['code', 'paragraph'])
  assert.equal(blocks[1].text, '真实段落。')
})

test('parseBlocks 把结构块切干净', () => {
  const blocks = parseBlocks(['# 标题', '', '- 一', '- 二', '', '段落。', '', '```', 'code', '```'].join('\n'))
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'list', 'paragraph', 'code'])
  assert.deepEqual(blocks[1].items, ['一', '二'])
})

test('parseBlocks：引用块是独立类型，不会被并进段落', () => {
  assert.deepEqual(parseBlocks('> 引用\n\n真段落。').map((b) => b.type), ['quote', 'paragraph'])
})

test('parseBlocks 空输入不抛错', () => {
  assert.deepEqual(parseBlocks(''), [])
  assert.deepEqual(parseBlocks(null), [])
})

test('firstSentence 是位置规则，不判断语义', () => {
  assert.equal(firstSentence('分支已包含最新主干，落后 0 个提交。后面还有别的。'), '分支已包含最新主干，落后 0 个提交。')
  assert.equal(firstSentence('没有结束符的一整段'), '没有结束符的一整段')
})

test('clip 截断加省略号；不切开 emoji（代理对切一半会显示成替换字符）', () => {
  assert.equal(clip('abcdef', 4), 'abc…')
  assert.equal(clip('abc', 10), 'abc')
  const clipped = clip('🎯'.repeat(60), 21)
  const stripped = clipped.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
  assert.ok(!/[\uD800-\uDFFF]/.test(stripped), '存在被切开的代理对')
})

// ── 卡片 2.0 组装 ───────────────────────────────────────────────────────

const LONG = ['# 打包：3114176 → success ✅', '', '- 要点一', '- 要点二', '', 'x'.repeat(800)].join('\n')

test('长回复：要点常驻，正文进默认折叠面板，摘要在 config.summary.content', () => {
  const card = buildNotificationCardV2({
    title: 'dsh 回复总结', turn: 12, cwd: '/tmp/w',
    summary: '打包成功', bullets: ['要点一', '要点二'], detail: LONG,
  })
  assert.equal(card.schema, '2.0')
  assert.equal(card.config.update_multi, true)
  assert.equal(card.config.summary.content, '打包成功')
  assert.equal(card.header.title.content, 'dsh 回复总结')
  const p = panel(card)
  assert.ok(p, '应有 collapsible_panel')
  assert.equal(p.expanded, false)
  assert.equal(p.header.icon_expanded_angle, -180)
  assert.equal(markdowns(card)[0], '• 要点一\n• 要点二')
  assert.ok(markdowns(card).some((m) => m.includes('dsh 回复总结') && m.includes('turn 12') && m.includes('cwd: /tmp/w')))
  // 正文在折叠面板内部（嵌套），所以断言要看 panel.elements[0]
  assert.ok(p.elements[0].content.includes('# 打包：3114176'))
})

test('短回复：直接展示正文，不产出折叠面板', () => {
  const card = buildNotificationCardV2({ title: 't', turn: 3, summary: 's', detail: '结论：已修复。' })
  assert.equal(panel(card), undefined)
  assert.ok(markdowns(card).some((m) => m === '结论：已修复。'))
})

test('折叠阈值可配：超过阈值才折叠', () => {
  const short = 'x'.repeat(300)
  assert.equal(panel(buildNotificationCardV2({ title: 't', detail: short })), undefined, '300 < 默认 400 不折叠')
  assert.ok(panel(buildNotificationCardV2({ title: 't', detail: short, foldThresholdChars: 100 })), '阈值降到 100 就折叠')
  assert.equal(DEFAULT_FOLD_THRESHOLD_CHARS, 400)
})

test('摘要在 config.summary.content：不再被塞进 80 字卡片头部截断', () => {
  const longSummary = '这是一条刻意写得很长的摘要，用来证明它被完整放在 config.summary.content 而不是被裁进卡片头部。'.repeat(3)
  const card = buildNotificationCardV2({ title: 't', summary: longSummary, detail: '短正文' })
  assert.equal(card.config.summary.content, longSummary)
  assert.equal(card.header.title.content, 't', '头部只放固定标题，承担的是卡片标题而不是摘要')
})

test('摘要为空时 config.summary.content 回退到标题，绝不发空预览', () => {
  const card = buildNotificationCardV2({ title: 'dsh 回复总结', summary: '', detail: 'x' })
  assert.equal(card.config.summary.content, 'dsh 回复总结')
})

test('超大正文被压到字节预算内（卡片硬上限 30KB，安全线 24KB）', () => {
  const card = buildNotificationCardV2({ title: 'dsh 回复总结', turn: 99, cwd: '/tmp/w', summary: 's', detail: '中'.repeat(20000) })
  const bytes = Buffer.byteLength(JSON.stringify(card), 'utf8')
  assert.ok(bytes <= CARD_BYTE_BUDGET, `card=${bytes} 超过 ${CARD_BYTE_BUDGET}`)
  assert.equal(cardFitsBudget(card), true)
  assert.ok(panel(card).header.title.content.includes('已截断'))
})

test('预算收缩有界收敛：极端输入也不会死循环', () => {
  const card = buildNotificationCardV2({ title: 't', turn: 1, summary: 's', detail: '中'.repeat(60000), byteBudget: 2000 })
  assert.ok(Buffer.byteLength(JSON.stringify(card), 'utf8') <= 2000 * 4)
  assert.ok(panel(card).elements[0].content.length > 0)
})

test('空正文不抛错', () => {
  const card = buildNotificationCardV2({ title: 't', detail: '' })
  assert.equal(panel(card), undefined)
})
