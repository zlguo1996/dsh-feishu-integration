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

test('兜底 = 首段首句 + 首个列表块前 3 条，且每条都是原文引用', () => {
  const d = fallbackDigest(REPLY)
  assert.equal(d.summary, '本轮把出站通知改成渐进披露卡片：')
  assert.equal(d.bullets.length, 3)
  assert.ok(d.bullets.every((b) => isQuoteOf(b, REPLY)))
})

test('isQuoteOf：容忍截断标记、容忍软换行被拼成空格，但不容忍新增字符', () => {
  assert.equal(isQuoteOf('本轮把出站通知改成…', REPLY), true)
  assert.equal(isQuoteOf('本轮把出站通知改成渐进披露卡片：', REPLY), true)
  assert.ok(isQuoteOf('本轮把出站通知改成渐进披露卡片：', REPLY.replace('改成渐进', '改成\n渐进')))
  assert.equal(isQuoteOf('本轮把出站通知改成 LLM 卡片：', REPLY), false)
})

test('空回复不抛错，产出空摘要', () => {
  const d = fallbackDigest('')
  assert.equal(d.summary, '')
  assert.deepEqual(d.bullets, [])
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
  assert.equal(parseDigestJson('{"summary":"S","bullets":["a"]}').summary, 'S')
  assert.equal(parseDigestJson('好的：\n```json\n{"summary":"S2","bullets":[]}\n```').summary, 'S2')
  assert.equal(parseDigestJson('前言 {"summary":"S3"} 后记').summary, 'S3')
  assert.equal(parseDigestJson('没有 JSON'), null)
  assert.equal(parseDigestJson(''), null)
})

// ── 契约校验：只用于 LLM 产出 ────────────────────────────────────────────

test('合法输出通过（含中英混排的状态词等价，如原文 success → 摘要「成功」）', () => {
  const v = validateDigest({ summary: '打包 3114176 成功', bullets: ['结论行与要点常驻可见'] }, REPLY)
  assert.equal(v.ok, true)
})

test('编造数字 / 升级事实强度 一律拒绝', () => {
  assert.equal(validateDigest({ summary: '修复了 999 个问题', bullets: [] }, REPLY).reason, 'source-coverage')
  const upgraded = validateDigest({ summary: '已修复全部问题', bullets: [] }, REPLY)
  assert.equal(upgraded.reason, 'source-coverage')
  assert.ok(upgraded.violations.includes('修复'))
})

test('Markdown / HTML / 代码围栏 / 控制字符 一律拒绝', () => {
  assert.equal(validateDigest({ summary: '**加粗**摘要', bullets: [] }, REPLY).reason, 'contains-bold')
  assert.equal(validateDigest({ summary: '# 标题摘要', bullets: [] }, REPLY).reason, 'contains-heading')
  assert.equal(validateDigest({ summary: '见 ```code```', bullets: [] }, REPLY).reason, 'contains-fenced-code')
  assert.equal(validateDigest({ summary: '<div>摘要</div>', bullets: [] }, REPLY).reason, 'contains-html')
  assert.equal(validateDigest({ summary: '带\u0000控制符', bullets: [] }, REPLY).reason, 'control-chars')
})

test('形状与长度上限', () => {
  assert.equal(validateDigest({ summary: '', bullets: [] }, REPLY).reason, 'summary-empty')
  assert.equal(validateDigest({ summary: 'x'.repeat(SUMMARY_MAX_CHARS + 1), bullets: [] }, REPLY).reason,
    `summary-too-long:${SUMMARY_MAX_CHARS + 1}`)
  assert.equal(validateDigest({ summary: 'S', bullets: Array(MAX_BULLETS + 1).fill('要点') }, REPLY).reason,
    `too-many-bullets:${MAX_BULLETS + 1}`)
  assert.equal(validateDigest({ summary: 'S', bullets: [''] }, REPLY).reason, 'bullet-empty')
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
  return {
    calls,
    ctx: {
      // 插件用 ctx.get('llm') 取服务（llm 不是硬依赖），mock 必须提供 get。
      get: (name) => (name === 'llm' ? { stream } : services[name]),
      llm: { stream },
    },
  }
}

const VALID_JSON = JSON.stringify({ summary: '打包 3114176 成功', bullets: ['结论行与要点常驻可见'] })

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
  assert.equal(r.summary, '打包 3114176 成功')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'deepseek-official')
  assert.equal(calls[0].model, 'deepseek-flash')
  assert.equal(calls[0].purpose, 'notification-formatter')
  assert.equal(calls[0].sessionId, 'session-x')
  assert.equal(calls[0].system, SYSTEM_PROMPT)
  assert.equal(calls[0].messages[0].role, 'user')
  assert.ok(calls[0].signal, '必须传 signal 以便超时取消')
})

test('输出不可解析 / 不合契约 → 回退确定性兜底（带上原因）', async () => {
  for (const [payload, reason] of [
    ['我不是 JSON', 'unparsable-output'],
    [JSON.stringify({ summary: '修了 999 个 bug', bullets: [] }), 'source-coverage'],
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
  const { ctx } = mockCtx([])
  ctx.agentDefaultModel = { currentSelection: () => ({ provider: 'agent-prov', model: 'agent-model' }) }
  const f = createNotificationFormatter({ ctx, config: { provider: 'cfg-prov', model: 'cfg-model' } })
  assert.deepEqual(f.resolveRoute(), { provider: 'cfg-prov', model: 'cfg-model' })
})

test('路由解析：未显式配置时用 agent 默认模型', () => {
  const { ctx } = mockCtx([])
  ctx.agentDefaultModel = { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
  const f = createNotificationFormatter({ ctx, config: {} })
  assert.deepEqual(f.resolveRoute(), { provider: 'deepseek-official', model: 'deepseek-flash' })
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
