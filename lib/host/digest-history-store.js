/**
 * digest-history 持久化：`{sessionId, turn} → 该回合真正产出过的摘要文本`。
 *
 * 为什么需要它：出站 formatter 现在要把「最近 5 条历史项（用户输入 + 回复总结）」
 * 作为背景喂给模型，而**总结文本此前完全不存在于任何持久化状态里**——它只在发送
 * 那一刻被算出来用于建卡（`bridge-debug.log` 里也只记了 `summaryChars` 这个数字）。
 * 用户输入可以从 session 事件日志重建，总结不行，所以单独存一份。
 *
 * 边界（Codex FINAL 修订版）：
 * - 只存**最终被采纳的摘要字符串**（LLM 通过校验的，或确定性兜底产出的）；
 * - **不存回复全文**（那是 reply-map / 线程投递的事）；
 * - 不塞进 reply-map.json：那份存储是按飞书 message_id 索引的**路由**记录，线程分段
 *   会让同一回合的摘要重复多份；而且摘要历史必须**在飞书投递失败时依然存在**。
 *
 * 形态与 reply-map 同构（原子替换、有界、TTL、按 session 反查、损坏即空）。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function createDigestHistoryStore({
  historyPath,
  maxTurnsPerSession = 20,
  ttlDays = 7,
  log,
} = {}) {
  let cache = null

  function load() {
    if (cache) return cache
    try {
      const parsed = JSON.parse(readFileSync(historyPath, 'utf8'))
      if (!parsed?.sessions || typeof parsed.sessions !== 'object') throw new Error('bad shape')
      cache = parsed
    } catch {
      // 损坏/缺失都退化为空历史：历史只影响总结质量，绝不允许它打断出站。
      cache = { version: 1, sessions: {} }
    }
    return cache
  }

  function save() {
    try {
      mkdirSync(dirname(historyPath), { recursive: true })
      const tmp = historyPath + '.tmp'
      writeFileSync(tmp, JSON.stringify(cache, null, 2))
      renameSync(tmp, historyPath)
    } catch (err) {
      log?.('warn', '写 digest-history 失败:', String(err))
    }
  }

  const fresh = (row) => Date.now() - (row?.ts ?? 0) <= ttlDays * 24 * 3600 * 1000

  /** 立刻落盘（FINAL 要求：校验/兜底完成后、飞书投递之前）。 */
  function record({ sessionId, turn, summary, ts = Date.now() }) {
    if (!sessionId || turn == null) return
    if (typeof summary !== 'string' || !summary) return
    const map = load()
    const rows = (map.sessions[sessionId] ?? []).filter((r) => r?.turn !== turn)
    rows.push({ turn, summary, ts })
    rows.sort((a, b) => a.turn - b.turn)
    // 有界：每 session 只留最新 N 个回合；顺带清掉过期行。
    map.sessions[sessionId] = rows.filter(fresh).slice(-Math.max(1, maxTurnsPerSession))
    save()
  }

  /** 按 session 取历史（回合升序，已过滤 TTL；损坏/缺失返回空数组）。 */
  function getForSession(sessionId) {
    if (!sessionId) return []
    const rows = load().sessions[sessionId]
    if (!Array.isArray(rows)) return []
    return rows.filter(fresh).slice().sort((a, b) => a.turn - b.turn)
  }

  return { record, getForSession }
}
