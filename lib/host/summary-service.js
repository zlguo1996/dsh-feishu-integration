/**
 * 出站总结推送：session turn/end → 飞书通知 + reply-map 记账。
 *
 * ── 信息架构（Codex FINAL，2026-09-24 修订）──────────────────────────────
 * - **根消息**（卡片，或卡片不可用时的纯文本）= 飞书「话题」的根：主题标题 +
 *   针对本回合提问的摘要 + 0~3 条要点 + 极简元信息（`turn N · cwd: X`）；
 * - **完整回复**以线程回复挂在根消息下：首条必须带 `reply_in_thread: true` 才会
 *   真正创建原生话题（实测 2026-09-24 金丝雀）；读者点卡片上的「N 条回复 / 话题」
 *   进入阅读，而不是在卡片里展开；
 * - 摘要来源：发送层的 LLM formatter（输入 = 最近 5 条历史项 + 本回合提问 + 本回合
 *   回复，见 shared/formatter-input.js），超时/失败/不合契约时自动回退确定性兜底；
 * - 每个回合产出的摘要**先落 digest-history、再投递**：后续回合要拿它当历史背景；
 * - **投递归属**：由飞书发起的回合（rpcId 前缀 fsum-）**不在这里投递** —— 入站路径
 *   （inbound-runtime）会 await `deliverTurnNotification` 拿结果，失败时回退纯文本回帖。
 *   这样同一个回合只投递一次，且入站那条通道也能拿到「卡片 + 话题线程」的形态。
 *
 * ── 降级（按 FINAL 的顺序）──────────────────────────────────────────────
 * 1. LLM 不可用/超时/不合契约 → 引用式兜底，根消息与线程照常投递；
 * 2. 提问缺失 → 只用回复做兜底（不拿历史或注入上下文顶替）；
 * 3. 卡片确定不可发送（230099/200621/200861/230054/230025）→ 紧凑纯文本作根，再建线程；
 * 4. 根消息成功但没回 message_id → 线程无法创建：保留根、落线程死信，**不重发根**；
 * 5. 线程分段重试耗尽 → 保留根与其 reply-map 记账，剩余分段 + 根 id 落死信，**不重发根**；
 * 6. 线程能力不可用（配置关闭或缺 reply 实现）→ 唯一的例外：完整回复折回卡片面板
 *    或直接附在纯文本里，并明确记日志；
 * 7. 飞书发起的回合另有一层入站兜底：`deliverTurnNotification` 返回 delivered=false
 *    （根失败 / 全文没上去 / 没有正文）时，入站改回纯文本回帖 —— 宁可重复，不丢正文。
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { PROMPT_RPC_PREFIX } from '../shared/constants.js'
import { lastAssistantText, clip, collectTurnPrompts } from '../shared/text.js'
import {
  buildNotificationCardV2, buildNotificationText, buildThreadCardV2, splitReplyForCards,
  DEFAULT_FOLD_THRESHOLD_CHARS, CARD_BYTE_BUDGET,
} from '../shared/progressive.js'
import { fallbackDigest } from '../shared/notification-digest.js'
import { selectPriorItems } from '../shared/formatter-input.js'
import { createResilientSender } from './resilient-send.js'

/** 未注入 formatter 时的默认摘要：纯确定性兜底，绝不发起 LLM 调用。 */
async function defaultFormatDigest(reply, opts = {}) {
  return { ...fallbackDigest(reply, opts.question), via: 'fallback', reason: 'no-formatter' }
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
 * @param deps.loadBots()                 bot 列表（已过滤 deletionPending）
 * @param deps.resolveSecret(bot)         → secret 字符串 | null
 * @param deps.sendTextMessage(...)       feishu-api 纯文本直发（也是卡片失败的回退）
 * @param deps.sendCardMessage(...)       feishu-api 卡片直发
 * @param deps.replyCardMessage(...)      feishu-api 线程回帖**卡片**（完整回复走它：
 *                                        纯文本不渲染 Markdown，只有卡片会渲染）
 * @param deps.replyTextMessage(...)      feishu-api 线程回帖纯文本（老客户端降级用）
 * @param deps.notificationFormat         'card'（默认）| 'text'
 * @param deps.threadDelivery?            false = 不建线程，完整回复折回卡片/文本（降级）
 * @param deps.recordDigest?              digest-history 写入（校验/兜底后、投递前）
 * @param deps.readDigestHistory?(sid)    digest-history 读取（历史背景用）
 * @param deps.recordReplyMapping         reply-map 记账
 * @param deps.readBotState?(bot)         → bot state（读入站学到的 lastChatId）
 * @param deps.deadLetterPath?            重试放弃后的死信落盘路径（jsonl）
 */
export function installSummaryPush(ctx, deps) {
  const {
    maxText, includeReasons, botSelection,
    openId = '', chatId = '',
    notificationFormat = 'card',
    foldThresholdChars = DEFAULT_FOLD_THRESHOLD_CHARS,
    threadDelivery = true,
    loadBots, resolveSecret, sendTextMessage, sendCardMessage,
    replyTextMessage = null, replyCardMessage = null,
    recordReplyMapping, log,
    readBotState = null,
    formatDigest = defaultFormatDigest,
    recordDigest = null,
    readDigestHistory = () => [],
    deadLetterPath = null,
    debugLog = null,
    // 线程卡片的字节预算（平台硬上限 30KB，留安全线）；测试可注入更小的值来逼出多分段。
    threadByteBudget = CARD_BYTE_BUDGET,
    // 测试缝：注入假的重试发送器（真实实现是 10 次、1s 起指数退避，失败路径用例
    // 否则要跑几分钟）。
    resilientSender = null,
  } = deps

  const resilient = resilientSender ?? createResilientSender({ log })
  // 线程投递是否可用：既要配置允许，也要真有某种 reply 实现。不可用时走 FINAL 的
  // 第 6 条降级（唯一允许恢复折叠面板的路径）。
  // 优先用**卡片**回复：飞书纯文本消息不渲染 Markdown（`**加粗**` 会显示成星号），
  // 只有卡片的 markdown 组件会渲染——完整回复几乎总是 Markdown。
  const canReplyCard = typeof replyCardMessage === 'function'
  const canReplyText = typeof replyTextMessage === 'function'
  const canThread = threadDelivery !== false && (canReplyCard || canReplyText)

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
   * 把完整回复作为线程回复挂到根消息下。
   *
   * 三条硬约束（都来自实测）：
   * 1. 首条**必须** `replyInThread: true`：不带它只得到 root_id/parent_id、没有
   *    thread_id，客户端不会出现「N 条回复」入口；
   * 2. 每段发**卡片**（interactive）而不是纯文本：飞书纯文本消息不渲染 Markdown，
   *    `**加粗**` 会显示成星号；只有卡片的 markdown 组件会渲染。
   *    卡片不可用时（老客户端）退化为纯文本，并明确记日志——这是渲染降级，不是投递失败；
   * 3. 分段长度按**卡片字节预算**切（`splitReplyForCards`），不是按字符数：卡片有
   *    30KB 硬上限，中文 + JSON 转义会让字节数远大于字符数。
   * 每个分段各用自己的幂等 uuid（独立 deliveryUuid + 分段序号），绝不复用根消息的 uuid。
   *
   * @returns {Promise<boolean>} 所有分段是否都送达（无正文可投时视为成功）。
   *   入站路径靠它判断「全文有没有真的上去」，不完整时回退纯文本回帖。
   */
  async function deliverThread({ bot, appSecret, dest, rootId, detail, sessionId, turn }) {
    const creds = {
      appId: bot.appId, appSecret,
      receiveId: dest.receiveId, receiveType: dest.receiveType,
    }
    const chunks = splitReplyForCards(String(detail ?? ''), { byteBudget: threadByteBudget })
    // 入口就落一行：否则「线程到底有没有被尝试」在磁盘上不可观测（下面的异常路径同理）。
    debugLog?.('thread-enter', JSON.stringify({
      sessionId, turn, rootId, detailChars: String(detail ?? '').length,
      chunks: chunks.length, asCard: canReplyCard, byteBudget: threadByteBudget,
    }))
    if (chunks.length === 0) return true
    const deliveryUuid = randomUUID()
    let threadId = null
    for (let i = 0; i < chunks.length; i++) {
      const out = {}
      const result = await resilient.sendWithRetry(async () => {
        // ⚠️ feishu-api 的签名是 `replyToMessage({appId, appSecret, **messageId**}, text, opts)`：
        // **messageId 在第一个参数里**，不是第二个。错写成 (creds, rootId, text, opts) 会让
        // messageId=undefined → 飞书 400 `Invalid ids: [undefined]`（2026-09-24 实测于验证
        // 实例：根卡片在、线程永远不出现，重试 10 次后落死信才暴露真实原因）。
        const target = { ...creds, messageId: rootId }
        const opts = { uuid: `${deliveryUuid}-c${i}`, replyInThread: true, out }
        if (!canReplyCard) return replyTextMessage(target, chunks[i], opts)
        try {
          return await replyCardMessage(target, buildThreadCardV2({
            content: chunks[i], index: i + 1, total: chunks.length,
          }), opts)
        } catch (err) {
          // 卡片确定发不出去（老客户端/会话不支持卡片）：退化为纯文本，至少内容送达。
          if (!isCardUnsupported(err) || !canReplyText) throw err
          debugLog?.('thread-text-fallback', JSON.stringify({
            sessionId, turn, chunkIndex: i, error: String(err?.message ?? err),
          }))
          log('warn', '[总结] 线程卡片不可发送，该分段退化为纯文本（Markdown 不会渲染）:', String(err?.message ?? err))
          return replyTextMessage(target, chunks[i], opts)
        }
      }, `总结(线程 ${i + 1}/${chunks.length})→飞书`)
      if (!result.ok || !result.value) {
        writeDeadLetter({
          kind: 'thread-chunk',
          ts: new Date().toISOString(), sessionId, turn,
          appId: bot.appId, receiveId: dest.receiveId, receiveType: dest.receiveType,
          rootMessageId: rootId, threadId,
          chunkIndex: i, chunkCount: chunks.length,
          remaining: chunks.slice(i),
          error: String(result.error?.message ?? result.error ?? 'missing-message-id'),
        })
        debugLog?.('thread', JSON.stringify({
          sessionId, turn, rootId, chunks: chunks.length, delivered: i, failedAt: i,
        }))
        return false
      }
      if (out.threadId) threadId = out.threadId
      // 每个分段都写 reply-map：嵌套回复（父是某条分段）也能路由回同一会话。
      recordReplyMapping(result.value, { sessionId, turn, ts: Date.now() })
    }
    debugLog?.('thread', JSON.stringify({
      sessionId, turn, rootId, threadId, chunks: chunks.length, delivered: chunks.length, asCard: canReplyCard,
    }))
    return true
  }

  /**
   * @param {{text: string, card: object|null, detail: string, threadEnabled: boolean}} payload
   *        有 card 时优先发卡片；detail 是完整回复，仅在 threadEnabled 时走线程。
   * @returns {Promise<{delivered: boolean, reason: string, rootId: string|null}>}
   *        `delivered` 表示「用户**完整**拿到了内容」：根消息送达，且（不需要线程 或
   *        线程所有分段都送达）。入站路径用它决定要不要回退纯文本回帖。
   */
  async function sendSummary(payload, sessionId, turn) {
    const targets = await targetsWithCredentials()
    if (targets.length === 0) {
      log('warn', '没有可用飞书机器人或凭据，跳过总结发送')
      return { delivered: false, reason: 'no-target', rootId: null }
    }
    // 每个 target 返回自己的结局，最后聚合：只要**有一个** bot 让用户完整拿到内容就算
    // 送达（多 bot 场景下避免重复回退成纯文本）。
    const outcomes = await Promise.all(targets.map(async ({ bot, appSecret }) => {
      const dest = destinationFor(bot)
      if (!dest) {
        log('warn', 'bot 无可用接收目标，跳过:', bot.appId)
        return { delivered: false, reason: 'no-destination', rootId: null }
      }
      // 同一逻辑消息共用一个幂等 uuid：重试（含响应丢失场景）不会重复投递；
      // 卡片→纯文本的回退也复用同一 uuid，由服务端据此去重。
      const uuid = randomUUID()
      const creds = {
        appId: bot.appId, appSecret,
        receiveId: dest.receiveId, receiveType: dest.receiveType,
      }
      const useCard = !!payload.card && notificationFormat === 'card' && !!sendCardMessage
      const deliverRoot = async () => {
        if (!useCard) return sendTextMessage(creds, payload.text, { uuid })
        try {
          return await sendCardMessage(creds, payload.card, { uuid })
        } catch (err) {
          if (!isCardUnsupported(err)) throw err
          log('warn', '卡片不可发送，回退纯文本:', String(err?.message ?? err))
          return sendTextMessage(creds, payload.text, { uuid })
        }
      }
      const result = await resilient.sendWithRetry(deliverRoot, useCard ? '总结(卡片)→飞书' : '总结→飞书')
      if (!result.ok) {
        writeDeadLetter({
          kind: 'root',
          ts: new Date().toISOString(), sessionId, turn, appId: bot.appId,
          receiveId: dest.receiveId, receiveType: dest.receiveType,
          text: payload.text, card: useCard,
          error: String(result.error?.message ?? result.error),
        })
        return { delivered: false, reason: 'root-failed', rootId: null }
      }
      const rootId = result.value
      if (!rootId) {
        // 已受理但没回 message_id：只告警、不换格式重发——重发会让同一条通知投递两次。
        // 同时线程也无法创建（没有根 id），把完整回复落死信待查。
        log('error', '[总结] 发送成功但未返回 message_id，跳过 reply-map 记账:', dest.receiveId)
        if (payload.threadEnabled && payload.detail) {
          writeDeadLetter({
            kind: 'thread-no-root',
            ts: new Date().toISOString(), sessionId, turn, appId: bot.appId,
            receiveId: dest.receiveId, receiveType: dest.receiveType,
            detail: payload.detail,
            error: 'missing-message-id',
          })
        }
        return { delivered: false, reason: 'root-no-message-id', rootId: null }
      }
      // 先把根消息记进 reply-map：用户直接回复根卡片就能路由回本会话。
      recordReplyMapping(rootId, { sessionId, turn, ts: Date.now() })
      if (payload.threadEnabled && payload.detail) {
        try {
          const threadOk = await deliverThread({ bot, appSecret, dest, rootId, detail: payload.detail, sessionId, turn })
          // 根卡片在、但全文没上去 ⇒ 用户只看到摘要、拿不到正文，算**未完整送达**；
          // 让入站路径回退纯文本把正文补上（宁可重复，也不要内容丢失）。
          if (!threadOk) return { delivered: false, reason: 'thread-incomplete', rootId }
        } catch (err) {
          // ⚠️ 必须自己落盘：ctx.logger 只进 GUI 控制台、不落盘，所以「线程投递抛异常」
          // 在磁盘上原本完全不可观测 —— 现象只是「根卡片在、线程不在」，无从判断原因。
          // （本插件已经因为同一个原因在 formatter 上踩过一次坑。）
          debugLog?.('thread-error', JSON.stringify({
            sessionId, turn, rootId, error: String(err?.stack ?? err),
          }))
          log('warn', '[总结] 线程投递异常:', String(err))
          // 异常也必须保住完整回复：落死信，别让正文只存在于内存里。
          writeDeadLetter({
            kind: 'thread-error',
            ts: new Date().toISOString(), sessionId, turn,
            appId: bot.appId, receiveId: dest.receiveId, receiveType: dest.receiveType,
            rootMessageId: rootId,
            detail: payload.detail,
            error: String(err?.message ?? err),
          })
          return { delivered: false, reason: 'thread-error', rootId }
        }
      }
      return { delivered: true, reason: 'ok', rootId }
    }))
    // 有一个 target 完整送达就算送达；都不行时把第一个失败原因报上去（供日志与回退判断）。
    const reached = outcomes.find((o) => o?.delivered)
    return reached ?? outcomes[0] ?? { delivered: false, reason: 'no-target', rootId: null }
  }

  const openTurnBySession = new Map()    // sessionId -> 最近 turn/start 的 turn 号
  const feishuTurnsBySession = new Map() // sessionId -> Set<turn>（由飞书回复触发的回合）
  // sessionId -> 最近一次看到的 session 句柄。飞书回合的投递由**入站路径**手动触发，
  // 那时手里只有 sessionId，取 cwd 与历史提问都得靠这份缓存；有界以免长期运行无限增长。
  const lastSessionById = new Map()
  const SESSION_CACHE_MAX = 200

  /**
   * 为一个回合构建并投递「总结卡 + 话题线程」。
   *
   * 为什么抽成可 await 的函数：有两个调用者，语义不同 ——
   * - `session/event` 监听：Web/其他通道发起的回合，fire-and-forget；
   * - **入站路径**（飞书发起的回合，见 inbound-runtime）：它必须先知道投递有没有完整
   *   成功，失败时回退成纯文本回帖。所以这里返回结果，而不是静默 void。
   *
   * `delivered` 的语义是「用户拿到了完整内容」：根消息送达 **且**（不需要线程 或 线程
   * 所有分段都送达）。只送到根卡片、全文没上去也算未完整送达 —— 否则用户只看到摘要
   * 而拿不到正文。
   *
   * @returns {Promise<{delivered: boolean, reason: string, rootId: string|null}>}
   */
  async function deliverTurnNotification({
    sessionId, turn, session = null, replyOverride = null, questionOverride = null,
  }) {
    const sess = session ?? lastSessionById.get(sessionId) ?? null
    const reply = replyOverride ?? (sess ? lastAssistantText(sess, turn) : '')
    if (!reply) return { delivered: false, reason: 'empty-reply', rootId: null }
    const cwd = sess?.header?.cwd ?? ''
    // 本回合的直接人类提问：来自 session 事件日志（source.kind==='user'），
    // 不含 system-reminder / 工具注入 / goal 续跑。入站路径直接把自己那句话传进来。
    const prompts = sess ? collectTurnPrompts(sess) : []
    const question = questionOverride ?? prompts.find((p) => p.turn === turn)?.text ?? ''
    // 历史背景 = 最近 5 条（用户输入 + 当时真正产出过的总结），总结缺失就不补造。
    const priorItems = selectPriorItems({
      prompts,
      summaries: readDigestHistory(sessionId),
      currentTurn: turn,
    })
    const startedAt = Date.now()
    const digest = await formatDigest(reply, { sessionId, question, priorItems })
    // 摘要先落盘再投递：后续回合要拿它当历史背景，而且投递失败也必须留下。
    try {
      recordDigest?.({ sessionId, turn, summary: digest.summary })
    } catch (err) {
      log('warn', '[总结] digest-history 写入失败（不影响本次投递）:', String(err))
    }
    // ⚠️ 必须**另写**一份到 debugLog（落盘）：`log` 走的是 ctx.logger，而 DSH 的
    // ctx 日志只进 GUI 控制台、**不落盘** —— 所以「摘要走没走 LLM」在磁盘上原本
    // 完全不可观测：成功路径本来就没有日志，失败只进控制台，结果「没问题」与
    // 「根本没跑」长得一模一样（我曾据此误判过一次）。
    // 因此这里成功/失败都记一行（每次出站一行，量很小），一条 grep 即可自查：
    //   grep '"via":"fallback"' ~/.dsh/integrations/dsh-feishu/bridge-debug.log
    debugLog?.('summary', JSON.stringify({
      sessionId,
      turn,
      via: digest.via,
      reason: digest.reason ?? null,
      title: digest.title ?? null,
      questionChars: question.length,
      priorItems: priorItems.length,
      priorUsed: digest.inputStats?.priorUsed ?? null,
      priorDropped: digest.inputStats?.priorDropped ?? null,
      inputBytes: digest.inputStats?.inputBytes ?? null,
      elapsedMs: Date.now() - startedAt,
      summaryChars: String(digest.summary ?? '').length,
      bullets: (digest.bullets ?? []).length,
    }))
    // 控制台侧仍保留 warn：兜底属异常路径，warn 语义正确且能在 GUI 里直接看到。
    if (digest.via !== 'llm') {
      log('warn', '[总结] 摘要走确定性兜底:', String(digest.reason ?? 'unknown'))
    }
    const title = digest.title ?? ''
    const summary = digest.summary ?? ''
    const bullets = digest.bullets ?? []
    // 完整回复是否走线程：线程可用时卡片**不含**正文（点卡片进话题阅读）；
    // 线程不可用时才回到「折叠面板 / 文本附带全文」这条唯一例外。
    const threadEnabled = canThread
    const card = notificationFormat === 'card'
      ? buildNotificationCardV2({
          title, turn, cwd, summary, bullets,
          detail: threadEnabled ? '' : reply,
          allowDetailFallback: !threadEnabled,
          foldThresholdChars,
        })
      : null
    const text = threadEnabled
      ? buildNotificationText({ title, turn, summary, bullets, cwd })
      : buildNotificationText({ title, turn, summary, bullets, cwd }) + '\n\n' + clip(reply, maxText)
    return await sendSummary({ text, card, detail: reply, threadEnabled }, sessionId, turn)
  }

  ctx.on('session/event', (session, event) => {
    const sid = session?.id
    if (!sid || !event?.type) return
    // 重新插入以刷新 LRU 顺序，超上限时淘汰最旧的一条。
    lastSessionById.delete(sid)
    lastSessionById.set(sid, session)
    if (lastSessionById.size > SESSION_CACHE_MAX) {
      lastSessionById.delete(lastSessionById.keys().next().value)
    }

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

      // 飞书发起的回合：投递**不在这里**做 —— 入站路径要先拿到投递结果，才能决定是否
      // 回退纯文本回帖（它 await deliverTurnNotification）。这里再发一次就会让同一个
      // 回合投递两遍。注意这与「防乒乓」是两件事：去重靠的是入站路径的二选一。
      if (fromFeishu) return
      const reason = event.data?.reason
      if (!reason || !includeReasons.includes(reason.kind)) return

      // 摘要是异步的（LLM formatter 有硬 deadline，失败自动回退确定性兜底），
      // 因此推送不阻塞 session 事件分发。
      void deliverTurnNotification({ sessionId: sid, turn, session })
        .catch((err) => log('warn', '飞书总结发送失败:', String(err)))
    }
  })

  // 入站接管启动复用同一份凭据筛选（与原实现单一来源一致）
  return { targetsWithCredentials, destinationFor, deliverTurnNotification }
}
