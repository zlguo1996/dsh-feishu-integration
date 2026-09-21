/**
 * 发送层 LLM formatter：把「一条 assistant 回复」压成 {summary, bullets}。
 *
 * 边界（Codex 第 5 轮 FINAL，用户已确认）：
 * - **不注入会话上下文**：直接调 `ctx.llm.stream`，不产生会话回合、不消耗 Agent 轮次；
 * - **模型独立配置**：不复用主 Agent 模型（默认走 DSH 自带的辅助路由
 *   `deepseek-official/deepseek-flash`），可被 profile 配置覆盖；
 * - **有硬 deadline**（默认 1.5s，上限 2s）：超时/异常/输出不合契约一律回退到
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
export const MAX_TIMEOUT_MS = 2000
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

  const llm = ctx?.llm
  const canCall = enabled !== false && typeof llm?.stream === 'function' && !!provider && !!model
  const limitMs = Math.min(Math.max(200, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)

  /** 累积 text-delta；reasoning/tool-call 一律忽略。 */
  async function collect(reply, sessionId, signal) {
    const message = Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: summarizeForLlm(reply) }],
      source: { kind: 'plugin', plugin: 'dsh-feishu-integration' },
    })
    let text = ''
    const stream = llm.stream({
      provider,
      model,
      messages: [message],
      system: SYSTEM_PROMPT,
      maxTokens,
      sessionId,
      purpose: 'notification-formatter',
      signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
    return text
  }

  /**
   * @param {string} reply 原始 assistant 回复
   * @param {{sessionId?: string}} [opts]
   * @returns {Promise<{summary: string, bullets: string[], via: 'llm'|'fallback', reason?: string}>}
   */
  async function format(reply, opts = {}) {
    const fallback = fallbackDigest(reply)
    if (!canCall) return { ...fallback, via: 'fallback', reason: 'llm-unavailable' }

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
      const raw = await Promise.race([collect(reply, opts.sessionId, controller.signal), deadline])
      const parsed = parseDigestJson(raw)
      if (!parsed) return { ...fallback, via: 'fallback', reason: 'unparsable-output' }
      const verdict = validateDigest(parsed, reply)
      if (!verdict.ok) {
        log?.('warn', '[formatter] 输出未通过契约校验，回退确定性兜底:', verdict.reason,
          verdict.violations ? JSON.stringify(verdict.violations) : '')
        return { ...fallback, via: 'fallback', reason: verdict.reason }
      }
      return { ...verdict.digest, via: 'llm' }
    } catch (err) {
      return { ...fallback, via: 'fallback', reason: String(err?.message ?? err) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return { format, canCall, provider, model, timeoutMs: limitMs }
}
