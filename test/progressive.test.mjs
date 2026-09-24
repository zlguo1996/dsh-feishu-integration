import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildNotificationCardV2,
  buildNotificationText,
  buildThreadCardV2,
  splitReplyForCards,
  cardFitsBudget,
  clip,
  firstSentence,
  parseBlocks,
  stripInline,
  CARD_BYTE_BUDGET,
  DEFAULT_FOLD_THRESHOLD_CHARS,
  TITLE_FALLBACK_SENTINEL,
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

// ── 卡片 2.0 组装（话题根卡片：标题 + 摘要 + 要点 + 元信息，不含正文）──────

const LONG = ['# 打包：3114176 → success ✅', '', '- 要点一', '- 要点二', '', 'x'.repeat(800)].join('\n')

test('正常路径：标题是主题、摘要可见、元信息只有 turn 与 cwd，且**没有**折叠面板', () => {
  const card = buildNotificationCardV2({
    title: '打包 3114176', turn: 12, cwd: '/tmp/w',
    summary: '打包成功', bullets: ['要点一', '要点二'], detail: LONG,
  })
  assert.equal(card.schema, '2.0')
  assert.equal(card.config.update_multi, true)
  assert.equal(card.config.summary.content, '打包成功')
  assert.equal(card.header.title.content, '打包 3114176', '头部标题 = 回复主题，不再固定 chrome')
  assert.equal(panel(card), undefined, '完整回复交给话题线程，卡片里不得再有折叠面板')
  const md = markdowns(card)
  assert.equal(md[0], '打包成功', '摘要必须在卡片里可见，不能只放聊天列表预览')
  assert.equal(md[1], '• 要点一\n• 要点二')
  assert.equal(md[md.length - 1], 'turn 12 · cwd: /tmp/w', '元信息只留 turn 与 cwd，小写、· 分隔')
  assert.ok(!JSON.stringify(card).includes('打包：3114176'), '正文不得出现在卡片里')
})

test('元信息缺项：无 cwd 只留 turn；无 turn 只留 cwd；两者都没有则省略该元素', () => {
  assert.equal(markdowns(buildNotificationCardV2({ title: 't', turn: 3, summary: 's' })).pop(), 'turn 3')
  assert.equal(markdowns(buildNotificationCardV2({ title: 't', cwd: '/tmp/w', summary: 's' })).pop(), 'cwd: /tmp/w')
  const none = buildNotificationCardV2({ title: 't', summary: 's' })
  assert.equal(none.body.elements.length, 1)
  assert.equal(none.body.elements[0].content, 's')
})

test('空标题回退到结构哨兵（不是模型产出的主题）', () => {
  const card = buildNotificationCardV2({ title: '', summary: 's' })
  assert.equal(card.header.title.content, TITLE_FALLBACK_SENTINEL)
})

test('摘要为空时 config.summary.content 回退到标题，绝不发空预览', () => {
  const card = buildNotificationCardV2({ title: '打包 3114176', summary: '' })
  assert.equal(card.config.summary.content, '打包 3114176')
  assert.ok(!markdowns(card).includes(''), '不应出现空的 markdown 元素')
})

test('降级路径（线程不可用）：只有 allowDetailFallback 才允许折叠正文', () => {
  const card = buildNotificationCardV2({
    title: 't', turn: 4, cwd: '/tmp/w', summary: 's',
    detail: LONG, allowDetailFallback: true,
  })
  const p = panel(card)
  assert.ok(p, '显式降级时应有 collapsible_panel')
  assert.equal(p.expanded, false)
  assert.equal(p.header.icon_expanded_angle, -180)
  assert.ok(p.elements[0].content.includes('# 打包：3114176'))
  assert.equal(markdowns(card)[0], 's', '摘要仍然可见')
  assert.equal(markdowns(card).pop(), 'turn 4 · cwd: /tmp/w')
})

test('降级路径：短正文直接展示，不折叠', () => {
  const card = buildNotificationCardV2({ title: 't', summary: 's', detail: '结论：已修复。', allowDetailFallback: true })
  assert.equal(panel(card), undefined)
  assert.ok(markdowns(card).some((m) => m === '结论：已修复。'))
})

test('降级路径的折叠阈值可配', () => {
  const short = 'x'.repeat(300)
  assert.equal(panel(buildNotificationCardV2({ title: 't', detail: short, allowDetailFallback: true })), undefined,
    '300 < 默认 400 不折叠')
  assert.ok(panel(buildNotificationCardV2({ title: 't', detail: short, foldThresholdChars: 100, allowDetailFallback: true })),
    '阈值降到 100 就折叠')
  assert.equal(DEFAULT_FOLD_THRESHOLD_CHARS, 400)
})

test('降级路径的超大正文仍被压到字节预算内', () => {
  const card = buildNotificationCardV2({
    title: 't', turn: 99, cwd: '/tmp/w', summary: 's', detail: '中'.repeat(20000), allowDetailFallback: true,
  })
  const bytes = Buffer.byteLength(JSON.stringify(card), 'utf8')
  assert.ok(bytes <= CARD_BYTE_BUDGET, `card=${bytes} 超过 ${CARD_BYTE_BUDGET}`)
  assert.equal(cardFitsBudget(card), true)
  assert.ok(panel(card).header.title.content.includes('已截断'))
})

test('正常路径的卡片体积极小：去掉正文后与预算无关（无需截断顺序）', () => {
  const card = buildNotificationCardV2({
    title: '出站通知卡片改成话题线程承接', turn: 12, cwd: '/' + 'a/'.repeat(150),
    summary: '把出站总结卡片改为飞书原生话题的根消息，完整回复作为线程回复承接。',
    bullets: ['要点一', '要点二', '要点三'],
  })
  assert.ok(Buffer.byteLength(JSON.stringify(card), 'utf8') < 1500, '无正文时应远低于 24KiB 预算')
  assert.equal(panel(card), undefined)
})

test('空正文不抛错；纯文本形态与卡片同信息架构', () => {
  const card = buildNotificationCardV2({ title: 't', detail: '' })
  assert.equal(panel(card), undefined)
  assert.equal(
    buildNotificationText({ title: '打包 3114176', turn: 3, summary: '打包成功', bullets: ['要点一'], cwd: '/tmp/w' }),
    ['打包 3114176', '打包成功', '• 要点一', '', 'turn 3 · cwd: /tmp/w'].join('\n'),
  )
})

// ── 线程回复卡片：完整回复必须由卡片渲染 Markdown ────────────────────────
// 为什么是卡片：飞书**纯文本消息不渲染 Markdown**，`**加粗**` 会原样显示成星号；
// 只有卡片的 markdown 组件会渲染加粗/标题/列表/表格（2026-09-24 实测对照）。

test('线程卡片：markdown 组件原样承载正文，语法符号一个不剥', () => {
  const md = '**加粗** 与普通文字'
  const card = buildThreadCardV2({ content: md })
  assert.equal(card.schema, '2.0')
  assert.deepEqual(card.body.elements, [{ tag: 'markdown', content: md }], '正文逐字放进 markdown 组件')
  assert.equal(card.header, undefined, '单分段不加任何 chrome')
  // 聊天列表预览是纯文本（渲染不了 Markdown），所以要剥掉语法符号
  assert.equal(card.config.summary.content, '加粗 与普通文字')
})

test('线程卡片：多分段才加索引头（plain_text，避免与正文混淆）', () => {
  const card = buildThreadCardV2({ content: 'x', index: 2, total: 3 })
  assert.equal(card.header.title.content, '完整回复 2/3')
  assert.equal(card.header.title.tag, 'plain_text')
})

test('线程卡片：空正文也有非空预览，绝不发空 preview', () => {
  assert.equal(buildThreadCardV2({ content: '' }).config.summary.content, '完整回复')
})

test('splitReplyForCards：逐字不丢、每段都在字节预算内（含索引头）、优先在换行处切', () => {
  const text = ['# 标题', '', ...Array.from({ length: 60 }, (_, i) => `- 第 ${i + 1} 行中文内容`), '', '尾段。'].join('\n')
  const chunks = splitReplyForCards(text, { byteBudget: 700 })
  assert.ok(chunks.length > 1, '应当切成多段')
  assert.equal(chunks.join(''), text, '只切分、不改写：拼接必须与原文逐字相同')
  for (const c of chunks) {
    assert.ok(
      cardFitsBudget(buildThreadCardV2({ content: c, index: 1, total: 2 }), 700),
      '每段卡片都要装得下（含索引头的开销）',
    )
  }
  for (const c of chunks.slice(0, -1)) {
    assert.ok(c.endsWith('\n'), `应在换行处切，实际尾部：${JSON.stringify(c.slice(-12))}`)
  }
})

test('splitReplyForCards：空输入 → 空数组；短文本 → 单段原样', () => {
  assert.deepEqual(splitReplyForCards(''), [])
  assert.deepEqual(splitReplyForCards('短'), ['短'])
})
