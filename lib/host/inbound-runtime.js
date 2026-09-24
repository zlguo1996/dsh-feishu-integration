/**
 * 单 bot 入站运行时：唯一的飞书 WSClient 长连接 + 事件分拣 + 消息级路由。
 * 硬约束：一个 bot 只允许一个长连接（集群模式下多 client 会随机分流事件）。
 *
 * opts.larkSdk 仅测试用：注入假 SDK 以验证调用顺序，缺省用真实 @larksuiteoapi。
 */

import * as LarkDefault from '@larksuiteoapi/node-sdk'
import { findReplyMapping, formatRouteAcknowledgement } from '../shared/reply-routing.js'
import { extractText, splitText, clip } from '../shared/text.js'
import { createSessionGateway } from './session-gateway.js'

export async function startInboundForBot(opts) {
  const {
    origin, workspace, agentPreset, replyTimeoutMs, replyMaxChars,
    bot, appSecret, record, helpers, larkSdk, sessionController, workspaceRegistry,
    defaultSessionPolicy = 'fresh', defaultSessionIdleMinutes = 30,
  } = opts
  const Lark = larkSdk ?? LarkDefault
  const { log, debugLog = null, handleCardAction = null } = helpers
  // 会话策略收敛成受控枚举：拼错的配置项若被当成 fresh 静默生效，行为变化会很隐蔽。
  const sessionPolicy = ['fresh', 'fixed', 'idle'].includes(defaultSessionPolicy)
    ? defaultSessionPolicy
    : 'fresh'
  const idleMinutes = Math.max(1, Number(defaultSessionIdleMinutes) || 30)

  // 每个 bot runtime 独享一个无状态网关（配置相同、互不共享状态）
  const gateway = createSessionGateway({
    origin, workspace, agentPreset, replyTimeoutMs, log,
    sessionController, workspaceRegistry,
  })
  const { rpc, sessionExistsSafe, sessionRouteInfo, createFixedSession, ask } = gateway

  const sdkDomain = bot.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu
  const client = new Lark.Client({ appId: bot.appId, appSecret, domain: sdkDomain })

  const botState = helpers.readBotState(bot)
  const allowedSenders = new Set((bot.ownerOpenIds ?? []).filter(Boolean))
  const queues = new Map()   // routeKey -> Promise 串行化
  const inflight = new Set() // 处理中的 message_id（内存去重）

  function markSeen(messageId) {
    const list = botState.seenMessageIds
    list.push(messageId)
    while (list.length > 200) list.shift()
  }

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': (event) => {
      try { accept(event) } catch (err) { log('warn', 'accept 异常:', String(err)) }
      return {}
    },
    'im.message.reaction.created_v1': () => ({}),
    'im.message.reaction.deleted_v1': () => ({}),
    // 卡片回传交互（卡片上的按钮 / 输入框被点击、提交）→ 真实作答入口。
    //
    // 为什么必须**注册**这个 handler：没有 handler 时 Lark SDK 的 EventDispatcher 会
    // warn `no <type> handle`，并把这个字符串当作回调响应原样返回
    // （`no card.action.trigger event handle`）；平台无法解析成合法回调响应，客户端报
    // **200672**。所以「收到回调」与「注册了 handler」是两件事。
    //
    // 响应体（官方结构）：{ toast, card: { type: 'raw'|'template', data } }；
    // 只回 toast 或 `{}` 即「不更新卡片」。硬约束：**3 秒内**响应、**不可用 3xx**。
    // 状态机的推进在桥内异步进行（handleCardAction 立即返回乐观的已答态卡片），
    // 所以这里不会被会话往返拖到超时；失败时桥会自己 patch 回待答态。
    'card.action.trigger': (event) => {
      const action = event?.action ?? {}
      const value = action?.value ?? {}
      // 表单提交时用户在输入框填的内容在 form_value（{<input 的 name>: 文本}）；
      // 提交按钮自己的 behaviors.value 仍从 action.value 回来；单独输入框走 input_value。
      const formValue = action?.form_value
      const customText = formValue && typeof formValue === 'object'
        ? String(Object.values(formValue)[0] ?? '')
        : (typeof action?.input_value === 'string' ? action.input_value : '')
      const request = {
        rpcId: typeof value.rpcId === 'string' ? value.rpcId : null,
        questionId: typeof value.questionId === 'string' ? value.questionId : null,
        kind: typeof value.kind === 'string' ? value.kind : 'answer',
        option: typeof value.option === 'string' ? value.option : null,
        optionIndex: Number.isInteger(value.optionIndex) ? value.optionIndex : null,
        customText: customText.trim(),
        messageId: event?.context?.open_message_id ?? null,
        chatId: event?.context?.open_chat_id ?? null,
        operator: event?.operator?.open_id ?? null,
      }
      debugLog?.('card-action', JSON.stringify(request))
      if (typeof handleCardAction !== 'function') {
        return { toast: { type: 'warning', content: '提问桥未启用，无法在卡片上作答' } }
      }
      return Promise.resolve(handleCardAction(request))
        .then((result) => {
          const out = { toast: result?.toast ?? { type: 'info', content: '已收到' } }
          // 方式一：3 秒内立即更新卡片（raw = 完整卡片 JSON）
          if (result?.card) out.card = { type: 'raw', data: result.card }
          return out
        })
        .catch((err) => {
          log('warn', '卡片作答处理失败:', String(err))
          return { toast: { type: 'error', content: '处理失败，请改用文字回复作答' } }
        })
    },
  })

  const wsClient = new Lark.WSClient({
    appId: bot.appId,
    appSecret,
    domain: sdkDomain,
    loggerLevel: Lark.LoggerLevel.info,
    onReady: () => {
      if (record) { record.ready = true; record.feishuLongConnectionState = 'connected'; record.lastError = null }
      log('info', `飞书长连接已建立 bot=${bot.botName ?? bot.appId}`)
    },
    onError: (err) => {
      if (record) { record.ready = false; record.feishuLongConnectionState = 'failed'; record.lastError = err?.message ?? String(err) }
      log('warn', '飞书长连接错误:', err?.message ?? String(err))
    },
    onReconnecting: () => {
      if (record) { record.ready = false; record.feishuLongConnectionState = 'reconnecting' }
      log('info', '飞书长连接重连中…')
    },
    onReconnected: () => {
      if (record) { record.ready = true; record.feishuLongConnectionState = 'connected'; record.lastError = null }
      log('info', '飞书长连接已恢复')
    },
  })
  await wsClient.start({ eventDispatcher: dispatcher })
  const stopConnection = () => wsClient.close({ force: true })
  if (record) record.stop = stopConnection

  function accept(event) {
    const messageId = event?.message?.message_id
    if (!messageId) return
    if (event?.sender?.sender_type === 'bot') return
    if (event?.message?.message_type !== 'text') return
    if (allowedSenders.size > 0) {
      const senderOpenId = event?.sender?.sender_id?.open_id
      if (!senderOpenId || !allowedSenders.has(senderOpenId)) {
        log('warn', '拒绝白名单外发送者:', senderOpenId ?? '(空)')
        return
      }
    }
    if (inflight.has(messageId) || botState.seenMessageIds.includes(messageId)) return
    inflight.add(messageId)

    // 消息级路由：先查 parent_id；若 parent 是本插件回帖且未写入旧 map，再 fallback 到 root_id。
    // 排队前的任何异常都必须释放 inflight，否则该消息重投递会被永久去重。
    let task
    try {
      const mapped = findReplyMapping(event.message, helpers.lookupReplyMapping)
      const routeKey = mapped ? 'direct:' + mapped.sessionId : conversationKey(event)

      const prev = queues.get(routeKey) ?? Promise.resolve()
      task = prev
        .catch(() => undefined)
        .then(() => handle(event, mapped))
        // 入站处理链里的任何异常都必须在此落地：未捕获的 rejection 会让宿主进程
        // 直接 fatal 退出（实测 2026-09-18：reply-map 指向已删除会话时整机挂掉）。
        .catch((err) => { log('warn', '入站处理失败（已隔离，不影响宿主）:', String(err?.message ?? err)) })
        .finally(() => {
          inflight.delete(messageId)
          if (queues.get(routeKey) === task) queues.delete(routeKey)
        })
      queues.set(routeKey, task)
    } catch (err) {
      inflight.delete(messageId)
      log('warn', '入站分拣失败:', err?.message ?? String(err))
    }
  }

  async function handle(event, mapped) {
    const messageId = event.message.message_id
    markSeen(messageId)
    // 记住这条入站消息所在会话的 chat_id，供出站「主动发送」使用。
    // 为什么必须记：实测（2026-09-21，appId cli_aa3a1b034bb99ce9）同一应用以
    // open_id 主动发送会被飞书拒绝（code=230101 "Sending messages to users is
    // temporarily unavailable."，官方文档无此码），而以 chat_id 主动发送
    // （文本与 2.0 交互卡片）均成功。chat_id 是唯一无歧义的会话目标。
    // 出站侧见 summary-service 的 destinationFor()。
    const chatId = event?.message?.chat_id
    if (typeof chatId === 'string' && chatId) botState.lastChatId = chatId
    helpers.writeBotState(bot, botState)

    const text = extractText(event)
    if (!text) return
    if (text === '/status') {
      await sendChat(event.message.chat_id, '✅ dsh-feishu-integration 入站接管运行中。')
      return
    }
    if (text === '/help') {
      const defaultHint = sessionPolicy === 'fresh'
        ? '直接发消息 → 每次新建一个会话（不继承之前的上下文）；'
        : sessionPolicy === 'idle'
          ? `直接发消息 → 延续当前会话，空闲超过 ${idleMinutes} 分钟则新建一个；`
          : '直接发消息 → 进入固定的默认会话（上下文会一直累积）；'
      await sendChat(event.message.chat_id,
        defaultHint + '\n长按引用某条总结或机器人的回答回复 → 进入那一条对应的会话，可继续上文。')
      return
    }

    // 提问桥拦截：回帖若针对挂起的 ask_user_question，作为回答提交，不进入常规路由
    const parentMessageId = event.message.parent_id ?? null
    const rootMessageId = event.message.root_id ?? null
    if (
      (parentMessageId || rootMessageId)
      && await helpers.interceptReply?.({ parentMessageId, rootMessageId, messageId, text }) === true
    ) {
      log('info', `[提问回答] ${messageId} 已由提问桥消费`)
      return
    }

    // 解析目标会话
    let sessionId
    let viaRoute = false
    let reusedDefault = false
    if (mapped) {
      if (await sessionExistsSafe(mapped.sessionId)) {
        sessionId = mapped.sessionId
        viaRoute = true
      } else {
        await replyToMessage(messageId,
          '⚠️ 该总结对应的会话已不存在或不可访问，本次将新建一个会话。').catch(() => undefined)
      }
    }
    if (!sessionId) {
      const resolved = await resolveDefaultSession(event)
      sessionId = resolved.sessionId
      reusedDefault = resolved.reused
    }

    if (sessionId) {
      helpers.recordReplyMapping?.(messageId, {
        sessionId,
        turn: mapped?.turn ?? null,
        ts: Date.now(),
        source: 'feishu-inbound',
      })
    }

    log('info', `${viaRoute ? '[路由]' : reusedDefault ? '[默认·延续]' : '[默认·新建]'} ${messageId} → ${sessionId}`)
    const routeInfo = await sessionRouteInfo(sessionId)
    await replyToSession(
      messageId,
      formatRouteAcknowledgement({ ...routeInfo, sessionId }),
      sessionId,
      mapped?.turn,
    ).catch((err) => log('warn', '发送路由确认失败:', String(err)))
    const reaction = await addReactionSafe(messageId, 'OnIt')

    try {
      const answer = await ask(sessionId, text)
      await finishReaction(messageId, reaction, 'DONE')
      await replyToSession(messageId, answer || '（该回合结束但没有文本回复）', sessionId, mapped?.turn)
    } catch (err) {
      log('warn', '处理回复失败:', String(err))
      // 等待回答超时：转发回执已是送达确认，飞书侧保持静默（保留 OnIt，不追加错误反馈）
      if (err?.code === 'ask-timeout') return
      await finishReaction(messageId, reaction, 'ERROR')
      await replyToSession(messageId, '❌ 处理失败：' + clip(String(err?.message ?? err), 300), sessionId, mapped?.turn)
        .catch(() => undefined)
    }
  }

  // ── 飞书写操作 ──
  async function apiCall(op, fn) {
    const res = await fn()
    if (res?.code && res.code !== 0) throw new Error(`${op} failed: ${res.msg || res.code}`)
    return res
  }

  async function sendChat(chatId, text) {
    for (const chunk of splitText(text, replyMaxChars)) {
      await apiCall('im.message.create', () => client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: chunk }) },
      }))
    }
  }

  async function replyToMessage(messageId, text) {
    const replyIds = []
    for (const chunk of splitText(text, replyMaxChars)) {
      const response = await apiCall('im.message.reply', () => client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text: chunk }) },
      }))
      const replyId = response?.data?.message_id ?? response?.data?.message?.message_id
      if (replyId) replyIds.push(replyId)
    }
    return replyIds
  }

  async function replyToSession(messageId, text, sessionId, turn) {
    const replyIds = await replyToMessage(messageId, text)
    for (const replyId of replyIds) {
      helpers.recordReplyMapping?.(replyId, {
        sessionId,
        turn: turn ?? null,
        ts: Date.now(),
        source: 'feishu-outbound-reply',
      })
    }
    return replyIds
  }

  async function addReactionSafe(messageId, emojiType) {
    try {
      const res = await apiCall('reaction.create', () => client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      }))
      return res?.data?.reaction_id ?? null
    } catch (err) {
      log('warn', '添加表情失败:', String(err))
      return null
    }
  }

  async function finishReaction(messageId, reactionId, finalEmoji) {
    if (reactionId) {
      await apiCall('reaction.delete', () => client.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })).catch(() => undefined)
    }
    await addReactionSafe(messageId, finalEmoji)
  }

  // ── 工具 ──
  function conversationKey(event) {
    const chatType = event?.message?.chat_type
    if (chatType === 'p2p') {
      const senderId = event?.sender?.sender_id?.open_id || event?.sender?.sender_id?.user_id
      if (!senderId) throw new Error('p2p 事件缺少发送者 id')
      return 'p2p:' + senderId
    }
    const chatId = event?.message?.chat_id
    if (!chatId) throw new Error('群聊事件缺少 chat_id')
    return 'group:' + chatId
  }

  /**
   * 新建会话并记住它。
   *
   * `sessions[key]` 保留写：fixed/idle 依赖它，出问题时也能一眼看出「这个 chat 上一次
   * 落在哪个会话」；`sessionMeta[key]` 只给 idle 判空闲用。
   */
  async function rememberDefaultSession(key, existing = null) {
    const sessionId = existing ?? await createFixedSession(key)
    botState.sessions[key] = sessionId
    botState.sessionMeta ??= {}
    botState.sessionMeta[key] = { sessionId, lastUsedAt: Date.now() }
    helpers.writeBotState(bot, botState)
    return sessionId
  }

  /**
   * 未引用任何会话时的目标会话策略。
   *
   * 为什么默认 `fresh`：旧行为把每个 p2p/群聊钉在**一个永不更换的固定会话**上
   * （`botState.sessions[key]`）。那个会话的上下文只增不减 —— 聊得越久，每轮喂给
   * 模型的 token 越多，最终要么超上下文上限，要么让后续回答开始失焦（用户报障：
   * 「每次后面的回复都会有一些奇怪」）。用户明确要求：不引用会话时每次都开新会话。
   *
   * 连续性由**引用**承担，而不是由固定会话承担：出站总结卡与机器人的每条回答都会
   * 写 reply-map，用户在飞书里长按引用任意一条，就会路由回它属于的那个会话。
   *
   * - `fresh`（默认）：每条未引用的入站消息都新建会话；
   * - `fixed`：旧行为，复用 conversationKey 对应的固定会话（保留以兼容/回退）；
   * - `idle`：复用固定会话，但空闲超过 idleMinutes 就换一个新的。
   */
  async function resolveDefaultSession(event) {
    const key = conversationKey(event)
    if (sessionPolicy === 'fixed') {
      const cached = botState.sessions[key] ?? ''
      if (cached && await sessionExistsSafe(cached)) return { sessionId: cached, reused: true }
      return { sessionId: await rememberDefaultSession(key), reused: false }
    }
    if (sessionPolicy === 'idle') {
      const meta = botState.sessionMeta?.[key]
      const lastUsedAt = Number(meta?.lastUsedAt) || 0
      if (
        meta?.sessionId
        && Date.now() - lastUsedAt < idleMinutes * 60_000
        && await sessionExistsSafe(meta.sessionId)
      ) {
        return { sessionId: await rememberDefaultSession(key, meta.sessionId), reused: true }
      }
      return { sessionId: await rememberDefaultSession(key), reused: false }
    }
    return { sessionId: await rememberDefaultSession(key), reused: false }
  }
}
