/**
 * 发送层 LLM formatter：把「一条 assistant 回复」压成 {summary, bullets}。
 *
 * 边界（Codex 第 5 轮 FINAL，用户已确认）：
 * - **不注入会话上下文**：直接调 `ctx.llm.stream`，不产生会话回合、不消耗 Agent 轮次；
 * - **模型独立配置**：不复用主 Agent 模型。provider/model 优先取 profile 的
 *   `notificationFormatter` 配置，未配置时取 DSH 设置页的 agent 默认模型；两者都
 *   取不到才回退确定性兜底。**不写死任何 provider**。
 * - **有硬 deadline**（默认 1.5s，上限 10s）：超时/异常/输出不合契约一律回退到
 *   确定性兜底，绝不阻塞通知投递；
 * - **只做受约束压缩**：不得新增事实、不得升级事实强度。
 *
 * 不依赖任何 DSH 内部包：user message 的形状就是 `createUserMessage` 的产物
 * （`{...input, role:'user', id}` 冻结对象），响应流按 `StreamChunk` 累积
 * `text-delta`。这样避免声明 `@deepseek-ai/dsh-llm` 装进第二份不匹配的副本
 * （本机装的是 0.1.5-rc.2，npm 上最新发布只有 0.0.1-rc.1）。
 */

import { randomUUID } from 'node:crypto'

import {
  fallbackDigest,
  parseDigestJson,
  summarizeForLlm,
  validateDigest,
  SUMMARY_MAX_CHARS,
  BULLET_MAX_CHARS,
  MAX_BULLETS,
} from '../shared/notification-digest.js'

export const DEFAULT_TIMEOUT_MS = 1500
/**
 * 配置 deadline 的上限（第 73 行 `Math.min(..., MAX_TIMEOUT_MS)` 用它夹取）。
 *
 * ⚠️ 2026-09-24 由 2000 提到 10000。原因：上限只有 2s 时，profile 里配的
 * `notificationFormatter.timeoutMs: 6000` 会被**静默夹成 2000**，于是「配了 6 秒
 * 实际只有 2 秒」。而沙箱 A/B 实测（deepseek-flash-latest 这类推理模型）单次
 * formatter 调用耗时 986–5474ms，2s 会丢掉大量**合法**输出、照样回退确定性兜底。
 * 提高上限只是放开天花板，默认值仍是 1500 —— 零配置行为不变。
 */
export const MAX_TIMEOUT_MS = 10000
export const DEFAULT_MAX_OUTPUT_TOKENS = 400

/** 输出契约。措辞刻意围绕「允许不知道」，而不只是「不要幻觉」。 */
export const SYSTEM_PROMPT = [
  '你把一段「AI 编码助手刚给出的回复」压缩成 JSON，供飞书通知卡片使用。',
  '',
  '只输出一个 JSON 对象，形如：',
  '{"summary": "一句话摘要", "bullets": ["要点一", "要点二"]}',
  '',
  '硬性要求：',
  `1. summary 是一句话，不超过 ${SUMMARY_MAX_CHARS} 个字符；bullets 为 0 到 ${MAX_BULLETS} 条，每条不超过 ${BULLET_MAX_CHARS} 个字符。`,
  '2. 全部使用纯文本：不要 Markdown（不要 #、**、>、代码围栏）、不要 HTML、不要卡片 JSON。',
  '3. **只做压缩**：可以删除、合并、改变措辞以更短，但**不得新增原文没有的事实**。',
  '4. 不得出现原文里没有的数字、URL、文件名、版本号、错误码或状态词。',
  '5. **保持事实强度**：「已完成 / 发现 / 怀疑 / 可能 / 建议 / 计划 / 尝试」这些确定性等级不得提高；',
  '   原文说「怀疑 X 可能是原因」，就不能写成「已修复 X」。不确定就保留不确定。',
  '6. 你的任务不是判断这件事做得好不好，只是把已经写在原文里的信息说得更短。',
  '7. 若原文没有可总结的内容，返回 {"summary": "", "bullets": []}。',
  '8. 不要输出 JSON 以外的任何字符，不要解释，不要代码块。',
].join('\n')

/**
 * @param {object} deps
 * @param {object} deps.ctx                插件 ctx（需可访问 ctx.llm.stream）
 * @param {object} [deps.config]           {enabled, provider, model, timeoutMs, maxTokens}
 * @param {Function} [deps.log]
 */
export function createNotificationFormatter({ ctx, config = {}, log } = {}) {
  const {
    enabled = true,
    provider = '',
    model = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  } = config

  // 用 ctx.get('llm') 而不是 ctx.llm：llm 不是硬依赖 —— 拿不到就退回确定性兜底，
  // 这样插件在没有 llm 服务的组合里也能正常加载。
  const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
  const canCall = enabled !== false && typeof llm?.stream === 'function'
  const limitMs = Math.min(Math.max(200, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)

  /**
   * 模型路由：显式配置优先；否则用 DSH 的 agent 默认模型，于是零配置即可工作且
   * **不写死任何 provider**。每次调用时解析，设置页改了默认模型立即生效。两者都
   * 拿不到 → 不做 LLM，直接用确定性兜底。
   *
   * 必须经 `ctx.get('agentDefaultModel')` 读取。`agentDefaultModel` 不在本插件的
   * `inject` 列表里，而 Cordis 的属性代理对未声明的服务会**抛错**
   * （`cannot get property "agentDefaultModel" without inject`）；早前这里用
   * `ctx.agentDefaultModel` 读、异常又被静默吞掉，结果是每次都走确定性兜底、
   * LLM 从未被真正调用。读取失败改为 warn 级日志，不再隐身。
   */
  function resolveRoute() {
    if (provider && model) return { provider, model }
    try {
      const sel = ctx?.get?.('agentDefaultModel')?.currentSelection?.()
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
      log?.('warn', '[formatter] agent 默认模型未给出 provider/model，回退确定性兜底')
    } catch (err) {
      log?.('warn', '[formatter] 读取 agentDefaultModel 失败，回退确定性兜底:', String(err?.message ?? err))
    }
    return null
  }

  /**
   * 累积 text-delta；reasoning/tool-call 一律忽略。
   *
   * 同时**记录流里实际出现了哪些 chunk 类型、finish 原因以及 provider 的失败详情**。
   * 为什么要记：provider 失败**不一定抛异常** —— `FinishReasonMap` 里
   * `error`/`aborted` 是一等公民，adapter 会用一个 `finish` chunk 收尾并带上
   * `failure: {code, message, status}`，正文一个 text-delta 都没有。实测
   * （2026-09-24，隔离实例直连一个没起来的本地代理）拿到的就是
   * `chunks=usage|finish, finish=error`：`llm.stream` 正常结束、不抛错。
   * 旧代码此时只回一个 `unparsable-output`，看起来像「模型输出格式不对」，
   * 而真相是**请求根本没成功**，两种原因的处置完全不同。
   */
  async function collect(reply, sessionId, signal, route) {
    const message = Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: summarizeForLlm(reply) }],
      source: { kind: 'plugin', plugin: 'dsh-feishu-integration' },
    })
    let text = ''
    const chunkTypes = new Set()
    let finishReason = null
    let failure = null
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [message],
      system: SYSTEM_PROMPT,
      maxTokens,
      sessionId,
      purpose: 'notification-formatter',
      signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') { text += chunk.text; continue }
      if (typeof chunk?.type === 'string') chunkTypes.add(chunk.type)
      if (chunk?.type === 'finish') {
        const reason = chunk.reason
        finishReason = typeof reason === 'string' ? reason : (reason?.kind ?? reason?.type ?? null)
        // error / aborted 携带 LlmFailure：把它带出去，日志里才有真正的失败原因。
        if (reason && typeof reason === 'object' && reason.failure) failure = reason.failure
      }
    }
    return { text, chunkTypes: [...chunkTypes], finishReason, failure }
  }

  /** 把 LlmFailure 压成一行可读文本：code + HTTP status + provider 原文。 */
  function describeFailure(failure, finishReason) {
    if (!failure) return String(finishReason ?? 'unknown')
    const bits = [
      failure.code ?? finishReason ?? 'unknown',
      Number.isFinite(failure.status) ? `HTTP ${failure.status}` : null,
      typeof failure.message === 'string' && failure.message ? failure.message.slice(0, 200) : null,
    ].filter(Boolean)
    return bits.join(' / ')
  }

  /**
   * @param {string} reply 原始 assistant 回复
   * @param {{sessionId?: string}} [opts]
   * @returns {Promise<{summary: string, bullets: string[], via: 'llm'|'fallback', reason?: string}>}
   */
  async function format(reply, opts = {}) {
    const fallback = fallbackDigest(reply)
    if (!canCall) return { ...fallback, via: 'fallback', reason: 'llm-unavailable' }
    const route = resolveRoute()
    if (!route) return { ...fallback, via: 'fallback', reason: 'no-model-route' }

    const controller = new AbortController()
    let timer = null
    try {
      // 双保险：abort 通知 provider 停止；race 保证即使 provider 忽略 signal 也不会挂住通知。
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`formatter deadline ${limitMs}ms exceeded`))
        }, limitMs)
      })
      const { text, chunkTypes, finishReason, failure } = await Promise.race([
        collect(reply, opts.sessionId, controller.signal, route), deadline,
      ])
      if (failure) {
        const reason = `stream-error(${describeFailure(failure, finishReason)})`
        log?.('warn', '[formatter] LLM 请求失败，回退确定性兜底:', reason,
          `route=${route.provider}/${route.model}`)
        return { ...fallback, via: 'fallback', reason }
      }
      const parsed = parseDigestJson(text)
      if (!parsed) {
        // 空输出 ≠ 格式不对：把 chunk 轨迹带上，排障时一眼区分「没调通」和「输出不合契约」。
        const reason = text
          ? 'unparsable-output'
          : `empty-output(chunks=${chunkTypes.join('|') || 'none'}${finishReason ? `,finish=${finishReason}` : ''})`
        log?.('warn', '[formatter] LLM 未给出可解析摘要，回退确定性兜底:', reason,
          `route=${route.provider}/${route.model}`)
        return { ...fallback, via: 'fallback', reason }
      }
      const verdict = validateDigest(parsed, reply)
      if (!verdict.ok) {
        log?.('warn', '[formatter] 输出未通过契约校验，回退确定性兜底:', verdict.reason,
          verdict.violations ? JSON.stringify(verdict.violations) : '')
        return { ...fallback, via: 'fallback', reason: verdict.reason }
      }
      return { ...verdict.digest, via: 'llm' }
    } catch (err) {
      log?.('warn', '[formatter] LLM 调用失败，回退确定性兜底:', String(err?.message ?? err),
        `route=${route.provider}/${route.model}`)
      return { ...fallback, via: 'fallback', reason: String(err?.message ?? err) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return { format, canCall, resolveRoute, provider, model, timeoutMs: limitMs }
}
