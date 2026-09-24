/**
 * dsh-feishu-integration — 飞书与 DeepSeek Harness 双向集成（组装根）
 *
 * 出站：任意会话 turn/end(completed) 后向飞书发送通知（默认渐进披露卡片：
 *   结论行 + 要点常驻可见、正文折叠；卡片不可用时回退纯文本）；发送后记录
 *   飞书 message_id → DSH sessionId 映射（reply-map.json），供回复路由使用。
 *   由飞书回复触发的回合（rpcId 前缀 fsum-）不产生新总结，防乒乓。
 *
 * 入站（takeoverInbound=true）：WSClient 长连接接收 im.message.receive_v1，
 *   parent_id/root_id 命中 reply-map → 直投对应 DSH 会话并把最终回答回帖；
 *   未命中 → p2p/group 固定会话延续。设置页 UI 走 /feishu connection RPC。
 *
 * 提问桥（answerFromFeishu=true 且 takeoverInbound）：DSH 会话挂起
 *   ask_user_question 时，问题转发到该会话的飞书线程；用户在飞书回复编号/
 *   选项文字/自定义文本即提交作答，会话继续执行。经 /api/events.mux SSE +
 *   /api/respond 实现，与飞书长连接数无关。
 *
 * 模块布局（本文件只做组装，不含业务细节）：
 *   lib/shared/  纯函数与常量（测试缝）
 *   lib/host/    bot 存储 / reply-map / 飞书 API / 总结推送 /
 *                session 网关 / 单 bot 入站运行时 / 设置页 RPC
 *   client-src/  浏览器设置页源码 → scripts/build-client.mjs → lib/client.js
 */

import { homedir } from 'node:os'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { createBotStore } from './host/bot-store.js'
import { createReplyMapStore } from './host/reply-map-store.js'
import { createFeishuApi } from './host/feishu-api.js'
import { installSummaryPush } from './host/summary-service.js'
import { createNotificationFormatter } from './host/notification-formatter.js'
import { startInboundForBot } from './host/inbound-runtime.js'
import { installConnectionRpc } from './host/connection-rpc.js'
import { createQuestionBridge } from './host/question-bridge.js'
import { installHostQuestionSeam } from './host/host-question-seam.js'

export const name = 'dsh-feishu-integration'
// 入站路由直接使用宿主服务，不能经 /api 回环：当前 DSH 的 API 要求浏览器
// 会话鉴权，而插件进程本身没有也不应持有浏览器凭据。
export const inject = ['connection', 'credentials', 'webServer', 'sessionController', 'workspaceRegistry']

/** 公开纯函数测试缝（test/reply-chain.test.mjs 从这里导入）。 */
export { findReplyMapping, formatRouteAcknowledgement } from './shared/reply-routing.js'

function harnessBaseSafe(u) {
  try { return new URL(u).origin } catch { return u }
}

function requireWebServerPort(ctx) {
  const port = ctx.webServer?.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('dsh-feishu-integration 需要 ctx.webServer.port 或配置 harnessBaseUrl')
  }
  return port
}

export function apply(ctx, config = {}) {
  const {
    title = 'dsh 回复总结',
    maxText = 1500,                 // 纯文本形态（含卡片失败时的回退）正文上限
    notificationFormat = 'card',    // 'card'=渐进披露卡片（2.0：摘要+要点+折叠正文）| 'text'=旧纯文本
    foldThresholdChars = 400,       // 短于此长度不折叠，避免为一条短消息增加一次点击
    notificationFormatter = {},     // 摘要用的发送层 LLM：{enabled, provider, model, timeoutMs, maxTokens}
    includeReasons = ['completed'],
    openId = '',
    chatId = '',
    botSelection = 'all',
    takeoverInbound = false,        // true=启动长连接接管入站（须先禁用其他飞书长连接插件！）
    harnessBaseUrl = '',            // 缺省用 ctx.webServer.port 自动推导
    workspace = process.cwd(),      // 创建新固定会话时的工作区路径
    agentPreset = 'standard',
    replyMapMax = 500,              // reply-map LRU 上限
    replyMapTtlDays = 7,            // 映射有效期
    replyTimeoutMs = 600000,        // 等待目标会话回答的超时
    replyMaxChars = 9000,           // 单条回帖分片上限
    answerFromFeishu = true,        // 提问桥：DSH 挂起提问转发飞书并支持在飞书作答（需 takeoverInbound）
  } = config

  const log = (level, ...args) => {
    const logger = ctx.logger ?? console
    const fn = logger[level] ?? logger.log ?? console.log
    try { fn.call(logger, '[' + name + ']', ...args) } catch { /* ignore */ }
  }

  // ── 共享基础设施 ──
  const dshHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
  const feishuDir = join(dshHome, 'integrations', 'dsh-feishu')
  const replyMapPath = config.replyMapPath ?? join(feishuDir, 'reply-map.json')

  const botStore = createBotStore({ feishuDir, log })
  const replyMapStore = createReplyMapStore({ replyMapPath, replyMapMax, replyMapTtlDays, log })
  const feishuApi = createFeishuApi()
  // 发送层 LLM formatter：不写入会话、独立模型路由（缺省用 agent 默认模型）、
  // 有硬 deadline；失败/超时/不合契约时内部自动回退确定性兜底。
  const formatter = createNotificationFormatter({ ctx, config: notificationFormatter, log })

  // ── 出站：总结推送 + 记账 + 防回环 ──
  const summary = installSummaryPush(ctx, {
    title, maxText, includeReasons, botSelection, openId, chatId,
    notificationFormat, foldThresholdChars,
    formatDigest: formatter.format,
    loadBots: botStore.loadFeishuBots,
    resolveSecret: (bot) => ctx.credentials.resolve(bot.secretRef),
    sendTextMessage: feishuApi.sendTextMessage,
    sendCardMessage: feishuApi.sendCardMessage,
    readBotState: botStore.readBotState,
    recordReplyMapping: replyMapStore.record,
    deadLetterPath: join(dshHome, 'integrations', 'dsh-feishu', 'pending-summaries.jsonl'),
    log,
  })

  // ── 入站接管：长连接 + 分拣路由 ──
  const origin = harnessBaseUrl
    ? new URL(harnessBaseSafe(harnessBaseUrl))
    : new URL('http://127.0.0.1:' + requireWebServerPort(ctx))

  // 运行时注册表：botId → {botId, stop, ready, feishuLongConnectionState, lastError}
  const runtimes = new Map()
  const botErrors = new Map()

  // ── 提问桥：DSH 挂起的 ask_user_question ↔ 飞书线程双向转接 ──
  // 单条 mux SSE 连接（本机 DSH 事件流，与飞书长连接数无关）；
  // 发帖身份用第一个有凭据的 bot；有线程则回帖，无线程落总结同款目的地。
  let questionBridge = null
  let questionSeam = null
  // ctx 日志不落文件（只在 GUI 控制台），提问桥与卡片作答排障需要持久痕迹。
  // 提到外层作用域：launchBot（下面）要把同一个 debugLog 交给入站运行时。
  let bridgeDebug = null
  if (takeoverInbound && answerFromFeishu !== false) {
    const bridgeDebugPath = join(dshHome, 'integrations', 'dsh-feishu', 'bridge-debug.log')
    bridgeDebug = (...args) => {
      try {
        mkdirSync(dirname(bridgeDebugPath), { recursive: true })
        appendFileSync(bridgeDebugPath, `[${new Date().toISOString()}] ${args.join(' ')}\n`)
      } catch { /* 调试日志失败不影响主流程 */ }
    }
    questionBridge = createQuestionBridge({
      origin: origin.origin,
      log,
      debugLog: bridgeDebug,
      latestThreadLookup: replyMapStore.findLatestThreadFor,
      recordReplyMapping: replyMapStore.record,
      postToSession: async (text, sessionId, parentMessageId, meta = {}) => {
        void sessionId
        const targets = await summary.targetsWithCredentials()
        const target = targets[0]
        if (!target) throw new Error('没有可用飞书机器人')
        if (parentMessageId) {
          const messageId = await feishuApi.replyToMessage({
            appId: target.bot.appId, appSecret: target.appSecret, messageId: parentMessageId,
          }, text, { out: meta })
          return { messageId }
        }
        const dest = summary.destinationFor(target.bot)
        if (!dest) throw new Error('bot 无可用接收目标')
        const messageId = await feishuApi.sendTextMessage({
          appId: target.bot.appId, appSecret: target.appSecret,
          receiveId: dest.receiveId, receiveType: dest.receiveType,
        }, text, { out: meta })
        return { messageId }
      },
      // 提问优先发交互卡片；发不出去时由桥内部回退纯文本，这里只负责投递，
      // 且与纯文本走**同一线程/同一目的地**（首题接最近线程，后续题接上一题）。
      postCardToSession: async (card, sessionId, parentMessageId, meta = {}) => {
        void sessionId
        const targets = await summary.targetsWithCredentials()
        const target = targets[0]
        if (!target) throw new Error('没有可用飞书机器人')
        if (parentMessageId) {
          const messageId = await feishuApi.replyCardMessage({
            appId: target.bot.appId, appSecret: target.appSecret, messageId: parentMessageId,
          }, card, { out: meta })
          return { messageId }
        }
        const dest = summary.destinationFor(target.bot)
        if (!dest) throw new Error('bot 无可用接收目标')
        const messageId = await feishuApi.sendCardMessage({
          appId: target.bot.appId, appSecret: target.appSecret,
          receiveId: dest.receiveId, receiveType: dest.receiveType,
        }, card, { out: meta })
        return { messageId }
      },
      // 网页端先答时把已发出的提问卡原地刷成已答态（im.message.patch，共享卡片 14 天内可改）
      patchCard: async (messageId, card) => {
        const targets = await summary.targetsWithCredentials()
        const target = targets[0]
        if (!target) throw new Error('没有可用飞书机器人')
        return feishuApi.patchCardMessage({
          appId: target.bot.appId, appSecret: target.appSecret, messageId,
        }, card)
      },
    })
    void questionBridge.done
    // DSH ≥0.1.5-rc.2：/api 需要浏览器鉴权 → 提问桥改走宿主 waterfall 接缝
    questionSeam = installHostQuestionSeam(ctx, questionBridge, { log, debug: bridgeDebug })
  }

  function launchBot(bot, appSecret) {
    if (runtimes.has(bot.id)) {
      const prev = runtimes.get(bot.id)
      // 启动中去重：缓存 in-flight Promise，避免 reconnect 撞上启动时双开 WSClient
      if (prev.starting) return prev.starting
      return Promise.resolve(prev)
    }
    const record = {
      botId: bot.id, ready: false, feishuLongConnectionState: 'connecting',
      harnessReachable: true, lastError: null, stop: null, starting: null,
    }
    record.starting = startInboundForBot({
      origin, workspace, agentPreset, replyTimeoutMs, replyMaxChars,
      bot, appSecret, record,
      sessionController: ctx.sessionController,
      workspaceRegistry: ctx.workspaceRegistry,
      helpers: {
        log,
        debugLog: bridgeDebug,
        lookupReplyMapping: replyMapStore.lookup,
        recordReplyMapping: replyMapStore.record,
        readBotState: botStore.readBotState,
        writeBotState: botStore.writeBotState,
        interceptReply: questionBridge?.interceptReply,
        // 卡片作答入口：card.action.trigger 命中提问卡时由它推进状态机
        handleCardAction: questionBridge?.handleCardAction,
      },
    }).then((res) => {
      record.starting = null
      return res
    }).catch((err) => {
      runtimes.delete(bot.id)
      throw err
    })
    runtimes.set(bot.id, record)
    return record.starting
  }

  async function stopBot(botId) {
    const rec = runtimes.get(botId)
    if (!rec) return
    try { await rec.starting } catch { /* 启动失败也算已停止 */ }
    try { await rec.stop?.() } catch { /* ignore */ }
    runtimes.delete(botId)
  }

  async function resolveBotSecret(bot) {
    const secret = await ctx.credentials.resolve(bot.secretRef)
    return secret?.value ?? null
  }

  async function startAllBots() {
    const targets = await summary.targetsWithCredentials()
    if (targets.length === 0) {
      log('warn', 'takeoverInbound=true 但没有可用 bot/凭据，入站未启动')
      return
    }
    for (const { bot, appSecret } of targets) {
      launchBot(bot, appSecret).catch((err) => log('warn', '入站接管启动失败:', String(err)))
    }
  }

  if (takeoverInbound) {
    void startAllBots().catch((err) => log('warn', '入站接管初始化失败:', String(err)))
  } else {
    log('info', 'takeoverInbound=false：仅出站总结模式')
  }

  // ── 设置页 UI 通道（与旧 @xmanrui/dsh-feishu 客户端契约兼容）──
  let rpcDisposer = null
  ctx.inject(['connection', 'webServer'], (rpcCtx) => {
    rpcDisposer = installConnectionRpc(rpcCtx, {
      config2Dest: () => ({ chatId, openId }),
      runtimes, botErrors,
      loadFeishuBots: botStore.loadFeishuBots,
      saveBots: botStore.saveFeishuBots,
      credentials: rpcCtx.credentials,
      registerAppFn: config.provisionRegisterApp ?? null,
      launchBot, stopBot, resolveBotSecret,
      dshHome,
    })
  })

  // ── 卸载清理：不注册的话，热重载/禁用插件后飞书长连接、mux WS、RPC
  // 处理器全部存活，出现同 bot 双长连接分流事件、双总结、提问重复发帖。──
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        for (const rec of runtimes.values()) {
          try { rec.stop?.() } catch { /* ignore */ }
        }
        runtimes.clear()
        try { questionBridge?.close() } catch { /* ignore */ }
        try { questionSeam?.dispose?.() } catch { /* ignore */ }
        try { rpcDisposer?.() } catch { /* ignore */ }
        log('info', '插件卸载：已停止全部长连接与提问桥')
      }, name + ':teardown')
    } catch (err) {
      log('warn', '注册卸载清理失败（不影响运行）：', String(err))
    }
  }
}
