/** 纯文本工具：无副作用，host 侧各模块共用。 */

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/** 取某回合最后一条 assistant 消息的纯文本。 */
export function lastAssistantText(session, turn) {
  // DSH ≥0.1.5-rc.2 的 Session 不再暴露 events，只提供 snapshotEvents()；
  // 老版本回退到 session.events，两边都能取到事件列表。
  const events = typeof session.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : (session.events ?? [])
  for (const e of [...events].reverse()) {
    if (e.type === 'assistant/message' && e.data?.turn === turn) {
      return (e.data.message?.content ?? [])
        .filter((b) => b.type === 'text').map((b) => b.text).join('')
    }
  }
  return ''
}

export function extractText(event) {
  if (event?.message?.message_type !== 'text') return null
  let parsed
  try { parsed = JSON.parse(event.message.content) } catch { return null }
  let text = typeof parsed.text === 'string' ? parsed.text : ''
  for (const mention of event.message.mentions ?? []) {
    if (typeof mention.key === 'string' && mention.key) text = text.replaceAll(mention.key, '')
  }
  return text.trim() || null
}

/**
 * 从 session 事件日志重建「每个回合的**直接人类提问**」。
 *
 * 只接受 `source.kind === 'user'` 的 `user/message`：`user/message` 这条模型可见
 * 表面上混着三类东西——真人 prompt、`agent.inject()` 注入的上下文（文件变更通知、
 * 子目录 AGENTS.md、skill 内容、cron 通知…）、以及 goal 续跑回合。它们靠 `source`
 * 区分，只有 `kind === 'user'` 是真人输入。
 *
 * 注意：`user/message` 的载荷是 UserMessage 本身，**不带 `turn` 字段**，因此必须靠
 * 顺序消费 `turn/start` 来跟踪当前回合。
 *
 * @returns {Array<{turn: number, text: string}>} 按回合升序
 */
export function collectTurnPrompts(session) {
  const events = typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : (session?.events ?? [])
  const byTurn = new Map()
  let currentTurn = null
  for (const e of events) {
    if (!e?.type) continue
    if (e.type === 'turn/start') { currentTurn = e.data?.turn ?? null; continue }
    if (e.type !== 'user/message') continue
    if (e.data?.source?.kind !== 'user') continue
    if (currentTurn == null) continue
    // user/message 的 data 就是 message；兼容老形态 data.message。
    const msg = e.data?.message ?? e.data
    const text = (msg?.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('')
    if (!text) continue
    const prev = byTurn.get(currentTurn)
    byTurn.set(currentTurn, prev ? prev + '\n' + text : text)
  }
  return [...byTurn.entries()]
    .map(([turn, text]) => ({ turn, text }))
    .sort((a, b) => a.turn - b.turn)
}

/** 取某回合的直接人类提问（没有则空串）。 */
export function userPromptForTurn(session, turn) {
  return collectTurnPrompts(session).find((p) => p.turn === turn)?.text ?? ''
}

export function splitText(text, maxChars = 9000) {
  const t = String(text ?? '')
  if (t.length <= maxChars) return [t]
  const chunks = []
  let rest = t
  while (rest.length > maxChars) {
    let at = rest.lastIndexOf('\n', maxChars)
    if (at < Math.floor(maxChars * 0.6)) at = maxChars
    chunks.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

export function clip(text, max) {
  return String(text).length > max ? String(text).slice(0, max) + '\n…' : String(text)
}
