import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractLayers,
  buildNotificationCard,
  cardFitsBudget,
  CARD_BYTE_BUDGET,
  DEFAULT_MAX_DETAIL_CHARS,
} from '../lib/shared/progressive.js'

/** 卡片里是否含折叠面板。 */
const panel = (card) => card.elements.find((e) => e.tag === 'collapsible_panel')
const markdowns = (card) => card.elements.filter((e) => e.tag === 'markdown').map((e) => e.content)

// ── L0 结论行：优先级与清洗 ──────────────────────────────────────────────

test('显式「结论：」标记优先于更早出现的标题', () => {
  const text = ['## 打包：3114176 → success ✅', '', '结论：本次打包成功，二维码已更新。', '', '- 详情 A'].join('\n')
  assert.equal(extractLayers(text).headline, '本次打包成功，二维码已更新。')
})

test('没有标记时取首个标题，并去掉 # 与行内装饰', () => {
  const text = ['## 打包结果 ✅', '', '- 二维码已更新'].join('\n')
  assert.equal(extractLayers(text).headline, '打包结果 ✅')
})

test('剥掉中文序号章节前缀（真实载荷 turn 1 的失败形态）', () => {
  const text = [
    '### 一、朱烨今天发你的消息（POPO，`zhuye05@corp.netease.com`）',
    '',
    '- `:60:41` property `guideStyle` not found',
  ].join('\n')
  assert.equal(extractLayers(text).headline, '朱烨今天发你的消息（POPO，zhuye05@corp.netease.com）')
})

test('跳过叙述型开场（真实载荷 turn 27 的失败形态：英文 meta 残留）', () => {
  const text = [
    "Goal marked complete. Now let me write the final report answering the user's questions.",
    '',
    '分支已包含最新主干，落后 0 个提交。',
  ].join('\n')
  assert.equal(extractLayers(text).headline, '分支已包含最新主干，落后 0 个提交。')
})

test('纯填充语不算结论，继续往下找', () => {
  const text = ['已完成', '', '本轮把出站通知改成卡片折叠。'].join('\n')
  assert.equal(extractLayers(text).headline, '本轮把出站通知改成卡片折叠。')
})

test('代码围栏内的 # 标题与列表不参与抽取', () => {
  const text = ['```', '# not a heading', '- not a bullet', '```', '', '真实结论在这里。'].join('\n')
  const layers = extractLayers(text)
  assert.equal(layers.headline, '真实结论在这里。')
  assert.deepEqual(layers.bullets, [])
})

test('引用块不参与抽取', () => {
  const text = ['> 引用：这不是结论', '', '真结论。'].join('\n')
  assert.equal(extractLayers(text).headline, '真结论。')
})

test('只有代码没有正文时给出空结论而不抛错', () => {
  const layers = extractLayers('```\nconsole.log(1)\n```')
  assert.equal(layers.headline, '')
  assert.deepEqual(layers.bullets, [])
})

test('空输入不抛错', () => {
  const layers = extractLayers('')
  assert.equal(layers.headline, '')
  assert.deepEqual(layers.bullets, [])
  assert.equal(layers.detail, '')
  assert.equal(layers.folded, false)
  assert.equal(layers.truncated, false)
})

test('超长标题被裁剪到 80 字以内', () => {
  const layers = extractLayers('一、' + '很长的标题'.repeat(40))
  assert.ok(layers.headline.length <= 80, `headline=${layers.headline.length}`)
})

// ── L1 要点 ──────────────────────────────────────────────────────────────

test('要点取第一个连续列表块，最多 5 条', () => {
  const text = ['- 第一点内容', '- 第二点内容', '- 第三点', '- 第四点', '- 第五点', '- 第六点', '- 第七点'].join('\n')
  const layers = extractLayers(text)
  assert.equal(layers.bullets.length, 5)
  assert.equal(layers.bullets[0], '第一点内容')
})

test('没有列表就不编造要点', () => {
  const layers = extractLayers('这是一段普通正文，没有任何列表。')
  assert.deepEqual(layers.bullets, [])
})

test('要点单条被裁剪到 60 字以内', () => {
  const layers = extractLayers('- ' + 'x'.repeat(200))
  assert.ok(layers.bullets[0].length <= 60, `len=${layers.bullets[0].length}`)
})

test('要点会去掉行内 Markdown 装饰', () => {
  const layers = extractLayers('- **加粗** 与 `code` 混排')
  assert.equal(layers.bullets[0], '加粗 与 code 混排')
})

// ── L2 折叠与自适应 ────────────────────────────────────────────────────

test('短回复不折叠', () => {
  const layers = extractLayers('好的，已完成。')
  assert.equal(layers.folded, false)
})

test('长回复折叠，且正文按 maxDetailChars 截断', () => {
  const layers = extractLayers('x'.repeat(7000))
  assert.equal(layers.folded, true)
  assert.equal(layers.truncated, true)
  assert.equal(layers.detail.length, DEFAULT_MAX_DETAIL_CHARS)
  assert.equal(layers.detailChars, 7000)
})

// ── 卡片组装 ────────────────────────────────────────────────────────────

test('长回复产出默认折叠的折叠面板', () => {
  const layers = extractLayers(['结论：做完了。', '', '- 要点一', '', 'x'.repeat(800)].join('\n'))
  const card = buildNotificationCard({ title: 'dsh 回复总结', turn: 12, cwd: '/tmp/w', layers })
  const p = panel(card)
  assert.ok(p, '应有 collapsible_panel')
  assert.equal(p.expanded, false)
  assert.equal(p.header.icon_position, 'right')
  assert.equal(p.header.icon_expanded_angle, -180)
  assert.ok(p.elements[0].content.includes('x'.repeat(50)))
  // 折叠态才有常驻可见的结论行与要点
  assert.equal(markdowns(card)[0], '**做完了。**')
  assert.equal(markdowns(card)[1], '• 要点一')
})

test('短回复不产出折叠面板，且只展示正文（不重复一行结论）', () => {
  const layers = extractLayers('结论：已修复。')
  const card = buildNotificationCard({ title: 'dsh 回复总结', turn: 3, layers })
  assert.equal(panel(card), undefined)
  // 短消息本身就是一层：正文原样展示，不额外加一行加粗结论（否则同一句话显示两遍）
  assert.deepEqual(markdowns(card), ['结论：已修复。'])
})

test('卡片头部含标题与 turn，正文尾部带 cwd', () => {
  const layers = extractLayers('结论：好了。')
  const card = buildNotificationCard({ title: 'dsh 回复总结', turn: 7, cwd: '/Users/guo/work', layers })
  assert.equal(card.header.title.content, 'dsh 回复总结 · turn 7')
  assert.ok(markdowns(card).includes('cwd: /Users/guo/work'))
})

test('超大正文被压缩到字节预算内（卡片硬上限 30KB，安全线 24KB）', () => {
  // 20000 个中文字 ≈ 60KB，必须靠收缩正文压回安全线
  const layers = extractLayers('中'.repeat(20000), { maxDetailChars: 20000 })
  const card = buildNotificationCard({ title: 'dsh 回复总结', turn: 99, cwd: '/tmp/w', layers })
  const bytes = Buffer.byteLength(JSON.stringify(card), 'utf8')
  assert.ok(bytes <= CARD_BYTE_BUDGET, `card=${bytes} bytes 超过预算 ${CARD_BYTE_BUDGET}`)
  assert.equal(cardFitsBudget(card), true)
  assert.ok(panel(card).header.title.content.includes('已截断'))
})

test('预算收缩是有界的：极端输入也不会无限循环且仍留可读正文', () => {
  const layers = extractLayers('中'.repeat(60000), { maxDetailChars: 60000 })
  const card = buildNotificationCard({ title: 't', turn: 1, layers, byteBudget: 2000 })
  assert.ok(Buffer.byteLength(JSON.stringify(card), 'utf8') <= 2000 * 4, '应在有限轮次内收敛')
  assert.ok(panel(card).elements[0].content.length > 0)
})
