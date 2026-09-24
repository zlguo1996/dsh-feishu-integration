/**
 * 发送层 LLM formatter 的**模型路由**与失败诊断回归。
 *
 * 背景（本文件锁住的正是这个缺陷）：formatter 曾经用 `ctx.agentDefaultModel` 读模型
 * 路由。`agentDefaultModel` 不在插件的 `inject` 列表里，而 Cordis 的属性代理对未声明
 * 的服务会**抛错**（`cannot get property "agentDefaultModel" without inject`）；
 * 该异常又被 formatter 自己的 catch 吞掉 → `resolveRoute()` 返回 null →
 * 每一回合都静默回退确定性兜底，**LLM 从未被真正调用**，且磁盘上没有任何日志。
 *
 * 修复：改用 `ctx.get('agentDefaultModel')`（Cordis 的可选服务读取方式）。
 * 这些用例用「像 Cordis 一样」的 ctx 把两种读法分开，确保修复不会被改回去。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createNotificationFormatter } from '../lib/host/notification-formatter.js'

const REPLY = '最终定位：连接池耗尽，建议把 maxPool 从 10 提到 20。'
const GOOD_DIGEST = { summary: '连接池耗尽', bullets: ['建议把 maxPool 从 10 提到 20'] }

/**
 * 伪造 Cordis 风格的 ctx：
 * - `ctx.get(name)` 永远可用（可选服务读取方式）；
 * - 未在 `injected` 里声明的服务，**属性访问会抛错**（复现真实属性代理行为）。
 */
function makeCordisLikeCtx({ services = {}, injected = [] } = {}) {
  const target = {}
  for (const name of injected) target[name] = services[name]
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol') return t[prop]
      if (Object.prototype.hasOwnProperty.call(t, prop)) return t[prop]
      if (prop === 'get') return (name) => services[name]
      if (Object.prototype.hasOwnProperty.call(services, prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return undefined
    },
    has: (t, prop) => Object.prototype.hasOwnProperty.call(t, prop) || prop === 'get',
  })
}

/** 可编排的假 llm 服务：按 chunks 依序产出，或用 throwWith 抛错。 */
function makeLlm({ chunks = [], throwWith = null, onCall } = {}) {
  return {
    stream(options) {
      onCall?.(options)
      return (async function* generate() {
        if (throwWith) throw throwWith
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

const textChunks = (s) => [{ type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: s },
  { type: 'finish', reason: { kind: 'stop' } }]

test('零配置即可解析出模型路由 —— 经 ctx.get 读取 agent 默认模型（本次修复的核心）', async () => {
  // agentDefaultModel 刻意**不在** injected 里：属性访问会抛，只有 ctx.get 能拿到
  const ctx = makeCordisLikeCtx({
    services: {
      llm: makeLlm({}),
      agentDefaultModel: { currentSelection: () => ({ provider: 'raven-cc', model: 'deepseek-flash-latest' }) },
    },
    injected: [],
  })
  const formatter = createNotificationFormatter({ ctx, config: {} })

  assert.deepEqual(formatter.resolveRoute(), { provider: 'raven-cc', model: 'deepseek-flash-latest' })
  assert.equal(formatter.canCall, true)
})

test('旧读法 ctx.agentDefaultModel 在未声明 inject 时抛错 —— 复现原缺陷的成因', () => {
  const ctx = makeCordisLikeCtx({
    services: { agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } },
    injected: [],
  })
  assert.throws(() => ctx.agentDefaultModel, /without inject/,
    '属性访问抛错，正是老代码「每次都被 catch 吞掉→静默兜底」的根因')
  // 同一份 ctx 用 get 就能读到：修复点就在这一字之差
  assert.equal(ctx.get('agentDefaultModel').currentSelection().provider, 'p')
})

test('LLM 返回合法 JSON 时走 via:llm，并带上解析出的摘要', async () => {
  let seen = null
  const ctx = makeCordisLikeCtx({
    services: {
      llm: makeLlm({ chunks: textChunks(JSON.stringify(GOOD_DIGEST)), onCall: (o) => { seen = o } }),
      agentDefaultModel: { currentSelection: () => ({ provider: 'raven-cc', model: 'deepseek-flash-latest' }) },
    },
  })
  const formatter = createNotificationFormatter({ ctx, config: {} })
  const digest = await formatter.format(REPLY, { sessionId: 'session-1' })

  assert.equal(digest.via, 'llm')
  assert.equal(digest.reason, undefined)
  assert.equal(digest.summary, '连接池耗尽')
  assert.deepEqual(digest.bullets, ['建议把 maxPool 从 10 提到 20'])
  // 路由与调用参数确实是按契约传下去的
  assert.equal(seen.provider, 'raven-cc')
  assert.equal(seen.model, 'deepseek-flash-latest')
  assert.equal(seen.sessionId, 'session-1')
  assert.equal(seen.purpose, 'notification-formatter')
})

test('显式 provider/model 优先于 agent 默认模型', () => {
  const ctx = makeCordisLikeCtx({
    services: {
      llm: makeLlm({}),
      agentDefaultModel: { currentSelection: () => ({ provider: 'raven-cc', model: 'deepseek-flash-latest' }) },
    },
  })
  const formatter = createNotificationFormatter({ ctx, config: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  assert.deepEqual(formatter.resolveRoute(), { provider: 'deepseek-official', model: 'deepseek-flash' })
})

test('只给一半显式配置时忽略它，回落 agent 默认模型（README 承诺的行为）', () => {
  const ctx = makeCordisLikeCtx({
    services: {
      llm: makeLlm({}),
      agentDefaultModel: { currentSelection: () => ({ provider: 'raven-cc', model: 'deepseek-flash-latest' }) },
    },
  })
  const formatter = createNotificationFormatter({ ctx, config: { provider: 'deepseek-official' } })
  assert.deepEqual(formatter.resolveRoute(), { provider: 'raven-cc', model: 'deepseek-flash-latest' })
})

test('拿不到默认模型时回退确定性兜底，reason=no-model-route', async () => {
  const ctx = makeCordisLikeCtx({ services: { llm: makeLlm({}) } })
  const formatter = createNotificationFormatter({ ctx, config: {} })
  const digest = await formatter.format(REPLY)

  assert.equal(digest.via, 'fallback')
  assert.equal(digest.reason, 'no-model-route')
  assert.equal(digest.summary, '最终定位：连接池耗尽，建议把 maxPool 从 10 提到 20。')
})

test('没有 llm 服务时 reason=llm-unavailable（插件仍能正常加载）', async () => {
  const ctx = makeCordisLikeCtx({ services: {} })
  const formatter = createNotificationFormatter({ ctx, config: {} })
  const digest = await formatter.format(REPLY)

  assert.equal(formatter.canCall, false)
  assert.equal(digest.via, 'fallback')
  assert.equal(digest.reason, 'llm-unavailable')
})

test('流一个 text-delta 都没产出时，reason 必须区分「没调通」而不是「输出格式不对」', async () => {
  const ctx = makeCordisLikeCtx({
    services: {
      // 只有 finish、没有正文：本地代理没起/凭据失效时的真实形态
      llm: makeLlm({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] }),
      agentDefaultModel: { currentSelection: () => ({ provider: 'codemaker', model: 'deepseek-flash' }) },
    },
  })
  const formatter = createNotificationFormatter({ ctx, config: {} })
  const digest = await formatter.format(REPLY)

  assert.equal(digest.via, 'fallback')
  assert.match(digest.reason, /^empty-output\(chunks=finish,finish=stop\)$/)
  assert.ok(!/unparsable/.test(digest.reason), '不得退化成含糊的 unparsable-output')
})

test('finish=error 携带 LlmFailure 时，reason 必须带出 provider 的真实失败原因', async () => {
  // 这是 2026-09-24 在隔离实例上实测到的真实形态：路由解析成功、请求发出去了，
  // adapter 用 finish(error) 收尾且一个 text-delta 都没有 —— llm.stream 不抛错。
  const ctx = makeCordisLikeCtx({
    services: {
      llm: makeLlm({
        chunks: [
          { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
          {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { code: 'TRANSPORT', status: 502, message: 'DeepSeek API stream from http://127.0.0.1:15721/v1 failed' },
            },
          },
        ],
      }),
      agentDefaultModel: { currentSelection: () => ({ provider: 'codemaker', model: 'deepseek-flash' }) },
    },
  })
  const digest = await createNotificationFormatter({ ctx, config: {} }).format(REPLY)

  assert.equal(digest.via, 'fallback')
  assert.match(digest.reason, /^stream-error\(TRANSPORT \/ HTTP 502 \/ /)
  assert.match(digest.reason, /127\.0\.0\.1:15721/, 'provider 原文要带出来')
  assert.ok(!/unparsable|empty-output/.test(digest.reason))
})

test('aborted finish 同样按失败处理（deadline 之外的主动取消）', async () => {
  const ctx = makeCordisLikeCtx({
    services: {
      llm: makeLlm({
        chunks: [{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'request aborted' } } }],
      }),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    },
  })
  const digest = await createNotificationFormatter({ ctx, config: {} }).format(REPLY)
  assert.match(digest.reason, /^stream-error\(ABORTED/)
})

test('流产出非 JSON 文本时 reason=unparsable-output', async () => {
  const ctx = makeCordisLikeCtx({
    services: {
      llm: makeLlm({ chunks: textChunks('这不是 JSON') }),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    },
  })
  const digest = await createNotificationFormatter({ ctx, config: {} }).format(REPLY)
  assert.equal(digest.reason, 'unparsable-output')
})

test('provider 抛错时把错误信息带进 reason，而不是静默兜底', async () => {
  const ctx = makeCordisLikeCtx({
    services: {
      llm: makeLlm({ throwWith: new Error('connect ECONNREFUSED 127.0.0.1:15721') }),
      agentDefaultModel: { currentSelection: () => ({ provider: 'codemaker', model: 'deepseek-flash' }) },
    },
  })
  const digest = await createNotificationFormatter({ ctx, config: {} }).format(REPLY)
  assert.equal(digest.via, 'fallback')
  assert.match(digest.reason, /ECONNREFUSED 127\.0\.0\.1:15721/)
})

test('输出引入原文没有的数字会被契约打回，并给出 source-coverage', async () => {
  const ctx = makeCordisLikeCtx({
    services: {
      llm: makeLlm({ chunks: textChunks(JSON.stringify({ summary: '连接池耗尽', bullets: ['建议把 maxPool 提到 999'] })) }),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    },
  })
  const digest = await createNotificationFormatter({ ctx, config: {} }).format(REPLY)
  assert.equal(digest.via, 'fallback')
  assert.equal(digest.reason, 'source-coverage')
})

test('enabled:false 时完全不调 LLM', async () => {
  let called = false
  const ctx = makeCordisLikeCtx({
    services: {
      llm: makeLlm({ chunks: textChunks(JSON.stringify(GOOD_DIGEST)), onCall: () => { called = true } }),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    },
  })
  const formatter = createNotificationFormatter({ ctx, config: { enabled: false } })
  const digest = await formatter.format(REPLY)

  assert.equal(formatter.canCall, false)
  assert.equal(called, false)
  assert.equal(digest.reason, 'llm-unavailable')
})
