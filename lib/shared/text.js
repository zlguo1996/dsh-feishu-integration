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

/**
 * 描述某回合**用户可见输出**的形态，供「空正文」路径说清原因。
 *
 * 为什么需要它：`turn/end` 的最后一步可能只有 `reasoning` 块 —— 模型把回答写进了推理
 * 通道，正文一个 `text` 块都没有。此时 `lastAssistantText` 返回 ''，投递层若据此静默
 * 跳过，用户在飞书侧看到的就是「表情翻了 DONE、却什么都没收到」（2026-09-25 实测）。
 * 本函数只做统计，**不返回推理正文**（要取正文请用 `turnReplyBody`）。
 *
 * @returns {{steps: number, reasoningChars: number, textChars: number, lastStepTypes: string[]}}
 */
export function describeTurnOutput(session, turn) {
  const events = typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : (session?.events ?? [])
  let steps = 0
  let reasoningChars = 0
  let textChars = 0
  let lastStepTypes = []
  for (const e of events) {
    if (e?.type !== 'assistant/message' || e.data?.turn !== turn) continue
    const content = e.data.message?.content ?? []
    steps += 1
    lastStepTypes = content.map((b) => b?.type).filter(Boolean)
    for (const b of content) {
      if (b?.type === 'reasoning') reasoningChars += String(b.text ?? '').length
      else if (b?.type === 'text') textChars += String(b.text ?? '').length
    }
  }
  return { steps, reasoningChars, textChars, lastStepTypes }
}

/**
 * 取某回合**可投递的正文**；末步没有 `text` 时回退到模型的推理内容。
 *
 * 为什么要有这条回退（用户 2026-09-25 拍板）：线上出现过「回合正常结束，但末步只输出
 * `reasoning`、正文为空」——投递层拿不到正文，用户侧就是「只标记 done、没有回我消息」。
 * 那种情况下**推理通道里通常就写着事实上的回答**（实测 turn 6/7 的 reasoning 结尾
 * 正是给用户的结论与提问），把它当正文交给**同一条 LLM 摘要链路**，远比只发一张
 * 「本回合没有正文」的说明卡有用。
 *
 * 分级取用（越靠前越贴近「回答」）：
 *   1. `text`           —— 正常形态，末步有正文；
 *   2. `reasoning-last` —— 末步自己的推理（turn 6/7 的线上形态）；
 *   3. `reasoning-turn` —— 末步连推理都没有时，退回本回合全部推理（顺序拼接）；
 *   4. `none`           —— 真的什么都没有（此时由调用方发说明卡兜底）。
 *
 * ⚠️ 返回的是**原文**。调用方必须标注「这段正文取自推理通道」：推理里混着计划、
 * 自我纠偏与未验证猜测，不标注就是误导。
 *
 * @returns {{text: string, from: 'text'|'reasoning-last'|'reasoning-turn'|'none', reasoningChars: number}}
 */
export function turnReplyBody(session, turn) {
  const events = typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : (session?.events ?? [])
  const messages = events.filter((e) => e?.type === 'assistant/message' && e.data?.turn === turn)
  const joinOf = (content, type) => (content ?? [])
    .filter((b) => b?.type === type)
    .map((b) => String(b.text ?? ''))
    .join('\n')
  const last = messages.length > 0 ? messages[messages.length - 1] : null
  const content = last?.data?.message?.content
  // 1. 正常形态：末步有正文（语义与 lastAssistantText 一致）
  const normal = last ? joinOf(content, 'text') : ''
  if (normal) return { text: normal, from: 'text', reasoningChars: 0 }
  // 2. 末步的推理
  const lastReasoning = last ? joinOf(content, 'reasoning') : ''
  if (lastReasoning) {
    return { text: lastReasoning, from: 'reasoning-last', reasoningChars: lastReasoning.length }
  }
  // 3. 本回合全部推理
  const all = messages
    .map((m) => joinOf(m?.data?.message?.content, 'reasoning'))
    .filter(Boolean)
    .join('\n\n')
  if (all) return { text: all, from: 'reasoning-turn', reasoningChars: all.length }
  return { text: '', from: 'none', reasoningChars: 0 }
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
