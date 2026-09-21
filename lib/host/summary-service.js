/**
 * 出站总结推送：session turn/end → 飞书通知 + reply-map 记账。
 *
 * 摘要来源：发送层的 LLM formatter（受约束压缩，见 notification-formatter.js）；
 * 超时/失败/不合契约时自动回退到确定性兜底（notification-digest.js）。
 * 渲染：卡片 JSON 2.0 —— 摘要在 config.summary.content（聊天列表预览），
 * 正文走 collapsible_panel 并由 2.0 原生渲染 Markdown。
 * 防回环：由飞书回复触发的回合（rpcId 前缀 fsum-）不产生新总结。
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { PROMPT_RPC_PREFIX } from '../shared/constants.js'
import { lastAssistantText, clip } from '../shared/text.js'
import { buildNotificationCardV2, DEFAULT_FOLD_THRESHOLD_CHARS } from '../shared/progressive.js'
import { fallbackDigest } from '../shared/notification-digest.js'
import { createResilientSender } from './resilient-send.js'

/** 未注入 formatter 时的默认摘要：纯确定性兜底，绝不发起 LLM 调用。 */
async function defaultFormatDigest(reply) {
  return { ...fallbackDigest(reply), via: 'fallback', reason: 'no-formatter' }
}

/**
 * 确定性「卡片发不出去」的飞书错误码：命中即回退纯文本。
 * 其它错误（超时/限流/网络）一律交给重试层同格式重试，不换格式重发，
 * 否则会把「一次瞬时失败」放大成两条通知。
 */
const CARD_UNSUPPORTED_CODES = new Set([
  230099, // Failed to create card content
  200621, // parse card json err
  200861, // schema V2 不再支持该 tag
  230054, // 该类型会话不支持卡片消息
  230025, // 消息体超长（卡片 30KB / 纯文本 150KB）
])

function isCardUnsupported(err) {
  const code = err?.feishuCode
  return typeof code === 'number' && CARD_UNSUPPORTED_CODES.has(code)
}

/**
 * @param deps.loadBots()            bot 列表（已过滤 deletionPending）
 * @param deps.resolveSecret(bot)    → secret 字符串 | null
 * @param deps.sendTextMessage(...)  feishu-api 纯文本直发（也是卡片失败的回退）
 * @param deps.sendCardMessage(...)  feishu-api 卡片直发
 * @param deps.notificationFormat    'card'（默认）| 'text'
 * @param deps.recordReplyMapping    reply-map 记账
 * @param deps.readBotState?(bot)    → bot state（读入站学到的 lastChatId）
 * @param deps.deadLetterPath?       重试放弃后的死信落盘路径（jsonl）
 */
export function installSummaryPush(ctx, deps) {
  const {
    title, maxText, includeReasons, botSelection,
    openId = '', chatId = '',
    notificationFormat = 'card',
    foldThresholdChars = DEFAULT_FOLD_THRESHOLD_CHARS,
    loadBots, resolveSecret, sendTextMessage, sendCardMessage, recordReplyMapping, log,
    readBotState = null,
    formatDigest = defaultFormatDigest,
    deadLetterPath = null,
  } = deps

  const resilient = createResilientSender({ log })

  /** 最终失败兜底：落盘待查（不自动补发，避免重复投递语义复杂化）。 */
  function writeDeadLetter(entry) {
    if (!deadLetterPath) return
    try {
      mkdirSync(dirname(deadLetterPath), { recursive: true })
      appendFileSync(deadLetterPath, JSON.stringify(entry) + '\n')
      log('error', '[总结] 重试全部失败，已写入死信:', deadLetterPath)
    } catch (err) {
      log('error', '[总结] 死信写入失败:', String(err))
    }
  }

  /**
   * 目的地优先级：config.chatId > 入站学到的 lastChatId > config.openId > bot.ownerOpenIds[0]。
   *
   * 为什么把 chat_id 排在 open_id 前面：实测（2026-09-21，appId cli_aa3a1b034bb99ce9）
   * 同一应用、同一用户，以 open_id 主动发送会被飞书拒绝（code=230101
   * "Sending messages to users is temporarily unavailable."，官方文档无此码），
   * 而以 chat_id 主动发送成功（文本与 2.0 交互卡片均已验证投递到客户端）。
   * lastChatId 由 inbound-runtime 在收到任意入站消息时写入 bot state，
   * 因此「只要用户与机器人说过话，之后就能主动推给他」。open_id 仅作兜底。
   */
  function destinationFor(bot) {
    if (chatId) return { receiveId: chatId, receiveType: 'chat_id' }
    // 读取失败不能打断出站：宁可退回 open_id 试一次，也不要因为读状态失败而不发通知。
    let learned = null
    try { learned = readBotState?.(bot)?.lastChatId } catch { learned = null }
    if (typeof learned === 'string' && learned) return { receiveId: learned, receiveType: 'chat_id' }
    if (openId) return { receiveId: openId, receiveType: 'open_id' }
    if (bot.ownerOpenIds?.[0]) return { receiveId: bot.ownerOpenIds[0], receiveType: 'open_id' }
    return null
  }

  async function targetsWithCredentials() {
    const bots = loadBots()
    const selected = botSelection === 'first' ? bots.slice(0, 1) : bots
    const out = []
    for (const bot of selected) {
      const secret = await resolveSecret(bot)
      if (!secret?.value) {
        log('warn', '凭据缺失:', bot.secretRef)
        continue
      }
      out.push({ bot, appSecret: secret.value })
    }
    return out
  }

  /**
   * @param {{text: string, card: object|null}} payload 有 card 时优先发卡片
   */
  async function sendSummary(payload, sessionId, turn) {
    const targets = await targetsWithCredentials()
    if (targets.length === 0) {
      log('warn', '没有可用飞书机器人或凭据，跳过总结发送')
      return
    }
    await Promise.all(targets.map(async ({ bot, appSecret }) => {
      const dest = destinationFor(bot)
      if (!dest) {
        log('warn', 'bot 无可用接收目标，跳过:', bot.appId)
        return
      }
      // 同一逻辑消息共用一个幂等 uuid：重试（含响应丢失场景）不会重复投递；
      // 卡片→纯文本的回退也复用同一 uuid，由服务端据此去重。
      const uuid = randomUUID()
      const creds = {
        appId: bot.appId, appSecret,
        receiveId: dest.receiveId, receiveType: dest.receiveType,
      }
      const useCard = !!payload.card && notificationFormat === 'card' && !!sendCardMessage
      const deliver = async () => {
        if (!useCard) return sendTextMessage(creds, payload.text, { uuid })
        try {
          return await sendCardMessage(creds, payload.card, { uuid })
        } catch (err) {
          if (!isCardUnsupported(err)) throw err
          log('warn', '卡片不可发送，回退纯文本:', String(err?.message ?? err))
          return sendTextMessage(creds, payload.text, { uuid })
        }
      }
      const result = await resilient.sendWithRetry(deliver, useCard ? '总结(卡片)→飞书' : '总结→飞书')
      if (!result.ok) {
        writeDeadLetter({
          ts: new Date().toISOString(), sessionId, turn, appId: bot.appId,
          receiveId: dest.receiveId, receiveType: dest.receiveType,
          text: payload.text, card: useCard,
          error: String(result.error?.message ?? result.error),
        })
        return
      }
      if (!result.value) {
        // 已受理但没回 message_id：只告警、不换格式重发——重发会让同一条通知投递两次。
        log('error', '[总结] 发送成功但未返回 message_id，跳过 reply-map 记账:', dest.receiveId)
        return
      }
      recordReplyMapping(result.value, { sessionId, turn, ts: Date.now() })
    }))
  }

  const openTurnBySession = new Map()    // sessionId -> 最近 turn/start 的 turn 号
  const feishuTurnsBySession = new Map() // sessionId -> Set<turn>（由飞书回复触发的回合）

  ctx.on('session/event', (session, event) => {
    const sid = session?.id
    if (!sid || !event?.type) return

    if (event.type === 'turn/start') {
      openTurnBySession.set(sid, event.data?.turn ?? null)
      return
    }

    if (event.type === 'user/message') {
      const rpcId = event.data?.source?.rpcId
      if (typeof rpcId === 'string' && rpcId.startsWith(PROMPT_RPC_PREFIX)) {
        const turn = openTurnBySession.get(sid)
        if (turn != null) {
          const set = feishuTurnsBySession.get(sid) ?? new Set()
          set.add(turn)
          feishuTurnsBySession.set(sid, set)
        }
      }
      return
    }

    if (event.type === 'turn/end') {
      const turn = event.data?.turn
      const set = feishuTurnsBySession.get(sid)
      const fromFeishu = !!(set && set.has(turn))
      if (set) {
        set.delete(turn)
        if (set.size === 0) feishuTurnsBySession.delete(sid)
      }
      openTurnBySession.delete(sid)

      if (fromFeishu) return // 飞书回复引发的回合：绝不回发总结（防乒乓）
      const reason = event.data?.reason
      if (!reason || !includeReasons.includes(reason.kind)) return

      const reply = lastAssistantText(session, turn)
      if (!reply) return
      const cwd = session.header?.cwd ?? ''
      // 纯文本形态：既用于 notificationFormat:'text'，也作为卡片失败时的回退。
      const text = [
        title,
        cwd ? 'cwd: ' + cwd : '',
        'turn: ' + turn,
        clip(reply, maxText),
      ].filter(Boolean).join('\n')
      // 摘要是异步的（LLM formatter 有硬 deadline，失败自动回退确定性兜底），
      // 因此推送放进 IIFE，不阻塞 session 事件分发。
      void (async () => {
        const digest = await formatDigest(reply, { sessionId: sid })
        if (digest.via !== 'llm') {
          log('info', '[总结] 摘要走确定性兜底:', String(digest.reason ?? 'unknown'))
        }
        const card = notificationFormat === 'card'
          ? buildNotificationCardV2({
              title, turn, cwd,
              summary: digest.summary,
              bullets: digest.bullets,
              detail: reply,
              foldThresholdChars,
            })
          : null
        await sendSummary({ text, card }, sid, turn)
      })().catch((err) => log('warn', '飞书总结发送失败:', String(err)))
    }
  })

  // 入站接管启动复用同一份凭据筛选（与原实现单一来源一致）
  return { targetsWithCredentials, destinationFor }
}
