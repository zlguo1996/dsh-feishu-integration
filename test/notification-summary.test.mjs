import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fallbackDigest,
  summarizeForLlm,
  parseDigestJson,
  validateDigest,
  coverageViolations,
  isQuoteOf,
  SUMMARY_MAX_CHARS,
  TITLE_MAX_CHARS,
  TITLE_FALLBACK_SENTINEL,
  MAX_BULLETS,
} from '../lib/shared/notification-digest.js'
import { createNotificationFormatter, SYSTEM_PROMPT } from '../lib/host/notification-formatter.js'

const REPLY = [
  '## 打包：3114176 → success ✅',
  '',
  '本轮把出站通知改成渐进披露卡片：',
  '',
  '- 结论行与要点常驻可见',
  '- 正文收进折叠面板，展开不新增消息',
  '- 卡片不可用时回退纯文本',
  '',
  '```bash',
  'pnpm test  # 40 passed',
  '```',
  '',
  '详细说明见文档。',
].join('\n')

// ── 兜底路径：只删不改、只截不造 ─────────────────────────────────────────

test('兜底 = 引用式标题 + 首段首句 + 首个列表块前 3 条，且每条都是原文引用', () => {
  const d = fallbackDigest(REPLY)
  assert.equal(d.summary, '本轮把出站通知改成渐进披露卡片：')
  assert.equal(d.bullets.length, 3)
  assert.ok(d.bullets.every((b) => isQuoteOf(b, REPLY)))
  // 标题只按位置引用回复的首个标题（不猜主题），且受 20 字上限约束——截断而非改写。
  assert.ok(d.title.length <= TITLE_MAX_CHARS, `title=${d.title}`)
  assert.ok(d.title.endsWith('…'), `应被截断：${d.title}`)
  assert.ok(isQuoteOf(d.title, REPLY))
  assert.ok(REPLY.includes(d.title.slice(0, -1)), '截断标记之前必须是原文连续片段')
})

test('标题兜底优先级：提问首个标题 → 提问首句 → 回复首个标题 → 回复首句 → 结构哨兵', () => {
  assert.equal(fallbackDigest(REPLY, '## 代理连不上\n\n补充说明。').title, '代理连不上')
  assert.equal(fallbackDigest(REPLY, '代理为什么连不上？').title, '代理为什么连不上？')
  assert.ok(fallbackDigest(REPLY, '').title.endsWith('…'), '提问缺失时退化为回复的首个标题（超 20 字即截断）')
  assert.equal(fallbackDigest('普通正文，没有标题。', '').title, '普通正文，没有标题。')
  assert.equal(fallbackDigest('', '').title, TITLE_FALLBACK_SENTINEL)
})

test('isQuoteOf：容忍截断标记、容忍软换行被拼成空格，但不容忍新增字符', () => {
  assert.equal(isQuoteOf('本轮把出站通知改成…', REPLY), true)
  assert.equal(isQuoteOf('本轮把出站通知改成渐进披露卡片：', REPLY), true)
  assert.ok(isQuoteOf('本轮把出站通知改成渐进披露卡片：', REPLY.replace('改成渐进', '改成\n渐进')))
  assert.equal(isQuoteOf('本轮把出站通知改成 LLM 卡片：', REPLY), false)
})

test('空回复不抛错，产出空摘要 + 结构哨兵标题', () => {
  const d = fallbackDigest('')
  assert.equal(d.summary, '')
  assert.deepEqual(d.bullets, [])
  assert.equal(d.title, TITLE_FALLBACK_SENTINEL)
})

// ── 送给模型的输入：结构预处理 ───────────────────────────────────────────

test('代码块被替换为省略标记，标题与列表保留', () => {
  const input = summarizeForLlm(REPLY)
  assert.ok(input.includes('[代码块已省略 1 行]'))
  assert.ok(!input.includes('pnpm test'))
  assert.ok(input.includes('打包：3114176 → success ✅'))
  assert.ok(input.includes('- 结论行与要点常驻可见'))
})

// ── 输出解析 ────────────────────────────────────────────────────────────

test('parseDigestJson：整段 JSON / 围栏 / 散文包裹都能取；取不到返回 null', () => {
  assert.equal(parseDigestJson('{"title":"T","summary":"S","bullets":["a"]}').summary, 'S')
  assert.equal(parseDigestJson('{"title":"T","summary":"S","bullets":["a"]}').title, 'T')
  assert.equal(parseDigestJson('好的：\n```json\n{"title":"T2","summary":"S2","bullets":[]}\n```').summary, 'S2')
  assert.equal(parseDigestJson('前言 {"title":"T3","summary":"S3"} 后记').summary, 'S3')
  assert.equal(parseDigestJson('没有 JSON'), null)
  assert.equal(parseDigestJson(''), null)
  // 缺 title 不在这里判失败：交给 validateDigest 给出精确原因
  assert.equal(parseDigestJson('{"summary":"S"}').title, null)
})

// ── 契约校验：只用于 LLM 产出 ────────────────────────────────────────────

test('合法输出通过（含中英混排的状态词等价，如原文 success → 摘要「成功」）', () => {
  const v = validateDigest({ title: '打包 3114176', summary: '打包 3114176 成功', bullets: ['结论行与要点常驻可见'] }, REPLY)
  assert.equal(v.ok, true)
  assert.equal(v.digest.title, '打包 3114176')
})

test('编造数字 / 升级事实强度 一律拒绝', () => {
  assert.equal(validateDigest({ title: '打包 3114176', summary: '修复了 999 个问题', bullets: [] }, REPLY).reason, 'source-coverage')
  const upgraded = validateDigest({ title: '打包 3114176', summary: '已修复全部问题', bullets: [] }, REPLY)
  assert.equal(upgraded.reason, 'source-coverage')
  assert.ok(upgraded.violations.includes('修复'))
})

test('Markdown / HTML / 代码围栏 / 控制字符 一律拒绝（标题同样受限）', () => {
  assert.equal(validateDigest({ title: '打包 3114176', summary: '**加粗**摘要', bullets: [] }, REPLY).reason, 'contains-bold')
  assert.equal(validateDigest({ title: '打包 3114176', summary: '# 标题摘要', bullets: [] }, REPLY).reason, 'contains-heading')
  assert.equal(validateDigest({ title: '打包 3114176', summary: '见 ```code```', bullets: [] }, REPLY).reason, 'contains-fenced-code')
  assert.equal(validateDigest({ title: '打包 3114176', summary: '<div>摘要</div>', bullets: [] }, REPLY).reason, 'contains-html')
  assert.equal(validateDigest({ title: '打包 3114176', summary: '带\u0000控制符', bullets: [] }, REPLY).reason, 'control-chars')
  assert.equal(validateDigest({ title: '**打包**', summary: '打包 3114176 成功', bullets: [] }, REPLY).reason, 'contains-bold')
})

test('标题的形状与长度：必填、非空、≤20 字（恰好 20 字通过）', () => {
  assert.equal(validateDigest({ summary: '打包 3114176 成功', bullets: [] }, REPLY).reason, 'title-not-string')
  assert.equal(validateDigest({ title: '   ', summary: '打包 3114176 成功', bullets: [] }, REPLY).reason, 'title-empty')
  assert.equal(
    validateDigest({ title: '一'.repeat(TITLE_MAX_CHARS + 1), summary: '打包 3114176 成功', bullets: [] }, REPLY).reason,
    `title-too-long:${TITLE_MAX_CHARS + 1}`,
  )
  assert.equal(
    validateDigest({ title: '一'.repeat(TITLE_MAX_CHARS), summary: '打包 3114176 成功', bullets: [] }, REPLY).ok,
    true,
  )
})

test('按字段的来源权威：title 查提问，summary/bullets 查回复', () => {
  const question = 'maxPool 20 是不是太小了'
  assert.equal(
    validateDigest({ title: 'maxPool 20', summary: '打包 3114176 成功', bullets: [] }, REPLY, question).ok,
    true,
    '标题里的 20 在提问里 → 通过',
  )
  assert.equal(
    validateDigest({ title: '3114176', summary: '打包 3114176 成功', bullets: [] }, REPLY, question).reason,
    'title-source-coverage',
    '标题只能由提问授权：3114176 只在回复里 → 打回',
  )
  assert.equal(
    validateDigest({ title: 'maxPool 20', summary: '修复了 999 个问题', bullets: [] }, REPLY, question).reason,
    'source-coverage',
    '提问里的 token 也不能给摘要授权',
  )
})

test('形状与长度上限', () => {
  assert.equal(validateDigest({ title: '打包 3114176', summary: '', bullets: [] }, REPLY).reason, 'summary-empty')
  assert.equal(validateDigest({ title: '打包 3114176', summary: 'x'.repeat(SUMMARY_MAX_CHARS + 1), bullets: [] }, REPLY).reason,
    `summary-too-long:${SUMMARY_MAX_CHARS + 1}`)
  assert.equal(validateDigest({ title: '打包 3114176', summary: 'S', bullets: Array(MAX_BULLETS + 1).fill('要点') }, REPLY).reason,
    `too-many-bullets:${MAX_BULLETS + 1}`)
  assert.equal(validateDigest({ title: '打包 3114176', summary: 'S', bullets: [''] }, REPLY).reason, 'bullet-empty')
})

test('coverageViolations 允许同组状态词（原文 success 支持摘要「成功」）', () => {
  assert.deepEqual(coverageViolations('打包 3114176 成功', REPLY), [])
  assert.ok(coverageViolations('打包 3114176 已完成', REPLY).includes('完成'))
})

// ── formatter：调用 / deadline / 回退 ────────────────────────────────────

function mockCtx(chunks, services = {}) {
  const calls = []
  const stream = (options) => {
    calls.push(options)
    return (async function* () {
      for (const c of chunks) yield c
    })()
  }
  const store = { llm: { stream }, ...services }
  // Cordis 语义：`ctx.<service>` 属性代理只对 inject 里声明过的服务可用，读未声明的
  // 服务会抛 `cannot get property "X" without inject`，而不是返回 undefined。
  // mock 必须照做，否则「用属性代理读未注入服务」这类真实缺陷会被测试掩盖。
  const ctx = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'get') return (name) => store[name]
      if (prop in store) throw new Error(`cannot get property "${String(prop)}" without inject`)
      return undefined
    },
  })
  return { calls, ctx }
}

const VALID_JSON = JSON.stringify({ title: '打包 3114176', summary: '打包 3114176 成功', bullets: ['结论行与要点常驻可见'] })

test('未配置模型时不调用：直接回退', async () => {
  const f = createNotificationFormatter({ ctx: {}, config: {} })
  assert.equal(f.canCall, false)
  const r = await f.format(REPLY)
  assert.equal(r.via, 'fallback')
  assert.equal(r.reason, 'llm-unavailable')
  assert.equal(r.summary, fallbackDigest(REPLY).summary)
})

test('调用成功：累积 text-delta、忽略 reasoning-delta，并传对路由与 purpose', async () => {
  const { ctx, calls } = mockCtx([
    { type: 'reasoning-delta', index: 0, text: '这是思考，应当被忽略' },
    { type: 'text-delta', index: 1, text: VALID_JSON },
  ])
  const f = createNotificationFormatter({
    ctx, config: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  const r = await f.format(REPLY, { sessionId: 'session-x' })
  assert.equal(r.via, 'llm')
  assert.equal(r.title, '打包 3114176')
  assert.equal(r.summary, '打包 3114176 成功')
  assert.equal(r.inputStats.priorUsed, 0, '没有历史项时应报告 0（可观测性）')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'deepseek-official')
  assert.equal(calls[0].model, 'deepseek-flash')
  assert.equal(calls[0].purpose, 'notification-formatter')
  assert.equal(calls[0].sessionId, 'session-x')
  assert.equal(calls[0].system, SYSTEM_PROMPT)
  assert.equal(calls[0].messages[0].role, 'user')
  assert.ok(calls[0].messages[0].content[0].text.includes('CURRENT_ASSISTANT_REPLY:'))
  assert.ok(calls[0].signal, '必须传 signal 以便超时取消')
})

test('输出不可解析 / 不合契约 → 回退确定性兜底（带上原因）', async () => {
  for (const [payload, reason] of [
    ['我不是 JSON', 'unparsable-output'],
    [JSON.stringify({ title: '打包 3114176', summary: '修了 999 个 bug', bullets: [] }), 'source-coverage'],
  ]) {
    const { ctx } = mockCtx([{ type: 'text-delta', index: 0, text: payload }])
    const f = createNotificationFormatter({ ctx, config: { provider: 'p', model: 'm' } })
    const r = await f.format(REPLY)
    assert.equal(r.via, 'fallback')
    assert.equal(r.reason, reason)
    assert.equal(r.summary, fallbackDigest(REPLY).summary)
  }
})

test('超过 deadline 立即回退（不等模型），且不阻塞通知', async () => {
  const stream = (options) => (async function* () {
    // 模拟 provider 忽略 signal：永不 yield
    await new Promise((resolve) => {
      if (options.signal?.aborted) return resolve()
      options.signal?.addEventListener('abort', resolve, { once: true })
    })
  })()
  const ctx = { get: (name) => (name === 'llm' ? { stream } : undefined) }
  const f = createNotificationFormatter({ ctx, config: { provider: 'p', model: 'm', timeoutMs: 200 } })
  const started = Date.now()
  const r = await f.format(REPLY)
  const elapsed = Date.now() - started
  assert.equal(r.via, 'fallback')
  assert.ok(r.reason.includes('deadline'), `reason=${r.reason}`)
  assert.ok(elapsed < 1500, `应当及时回退，实际 ${elapsed}ms`)
})

test('provider 抛错 → 回退，不冒泡', async () => {
  const ctx = { get: (name) => (name === 'llm' ? { stream: () => { throw new Error('provider exploded') } } : undefined) }
  const f = createNotificationFormatter({ ctx, config: { provider: 'p', model: 'm' } })
  const r = await f.format(REPLY)
  assert.equal(r.via, 'fallback')
  assert.ok(r.reason.includes('provider exploded'))
})

// ── 路由解析：零配置可用，且不写死任何 provider ─────────────────────────

test('路由解析：显式配置优先于 agent 默认模型', () => {
  const { ctx } = mockCtx([], {
    agentDefaultModel: { currentSelection: () => ({ provider: 'agent-prov', model: 'agent-model' }) },
  })
  const f = createNotificationFormatter({ ctx, config: { provider: 'cfg-prov', model: 'cfg-model' } })
  assert.deepEqual(f.resolveRoute(), { provider: 'cfg-prov', model: 'cfg-model' })
})

test('路由解析：未显式配置时用 agent 默认模型（经 ctx.get 读取）', () => {
  const { ctx } = mockCtx([], {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
  })
  const f = createNotificationFormatter({ ctx, config: {} })
  assert.deepEqual(f.resolveRoute(), { provider: 'deepseek-official', model: 'deepseek-flash' })
})

test('回归：未注入的服务读属性会抛错，但路由不得因此丢失', () => {
  // 线上真实形态：agentDefaultModel 不在插件 inject 列表里，Cordis 的属性代理读它会抛
  // `cannot get property … without inject`。早前实现正是用属性代理读、异常又被静默
  // 吞掉，于是每次都退回确定性兜底，LLM 从未被真正调用。
  const { ctx } = mockCtx([], {
    agentDefaultModel: { currentSelection: () => ({ provider: 'raven-cc', model: 'deepseek-flash-latest' }) },
  })
  assert.throws(() => ctx.agentDefaultModel, /without inject/, 'mock 必须复现 Cordis 的 inject 门禁')
  const f = createNotificationFormatter({ ctx, config: {} })
  assert.deepEqual(f.resolveRoute(), { provider: 'raven-cc', model: 'deepseek-flash-latest' })
})

test('两条路由都拿不到 → 不调模型，直接确定性兜底', async () => {
  const { ctx, calls } = mockCtx([])
  const f = createNotificationFormatter({ ctx, config: {} })
  assert.equal(f.resolveRoute(), null)
  const r = await f.format(REPLY)
  assert.equal(r.via, 'fallback')
  assert.equal(r.reason, 'no-model-route')
  assert.equal(calls.length, 0, '不应发起任何模型调用')
})
