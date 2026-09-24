/**
 * 提问桥：DSH 挂起的 ask_user_question ↔ 飞书线程双向转接。
 *
 * question/requested → 逐题发到该会话的飞书线程并登记批次状态；
 *   优先发**交互卡片**（选项即按钮，见 shared/question-card），发卡失败（客户端过旧、
 *   权限或格式问题）自动回退原有纯文本——提问卡渲染不出来等于答不了，不能赌。
 * 作答有两个入口，共用同一套状态机（applyParsedAnswer），因此「谁先答谁生效」的去重一致：
 *   - 文本回帖：inbound-runtime 先经 interceptReply() 询问本桥；
 *   - 卡片点击：inbound-runtime 的 card.action.trigger → handleCardAction()。
 * 全部答完一次性 respond；question/resolved → 清算状态，网页端先答时把那张卡原地刷成已答态。
 *
 * 传输细节在 mux-client；文本格式化与解析是 shared/question-format 纯函数。
 */

import { createMuxClient } from './mux-client.js'
import {
  formatQuestionText,
  parseAnswerChoice,
  isCancelCommand,
  formatBatchConfirmation,
} from '../shared/question-format.js'
import { buildQuestionCard } from '../shared/question-card.js'

/**
 * @param deps.origin            DSH 本机 origin（http://127.0.0.1:port）
 * @param deps.log               logger
 * @param deps.debugLog?         (...args) → void  落盘调试日志（ctx 日志不落盘时用它排查）
 * @param deps.postToSession(text, sessionId, parentMessageId|null, metaBag)
 *               → {messageId}|null  发帖（metaBag 回填 rootId/parentId 线程信息）
 * @param deps.postCardToSession?(card, sessionId, parentMessageId|null, metaBag)
 *               → {messageId}|null  发卡片；缺省时提问一律走纯文本（保持既有行为/测试）
 * @param deps.patchCard?(messageId, card) → Promise  更新已发送的卡片（网页端先答时用）
 * @param deps.recordReplyMapping(messageId, meta)
 * @param deps.latestThreadLookup(sessionId) → feishuMessageId|null
 */
export function createQuestionBridge({
  origin, log, openSocket,
  postToSession, postCardToSession = null, patchCard = null,
  recordReplyMapping, latestThreadLookup,
  debugLog = null,
}) {

  /** feishuMsgId（含线程别名键）→ batchCtx {rpcId, sessionId, questions, cursor, answers, msgIds, keys} */
  const pendingByFeishuId = new Map()
  /** 活跃批次计数（一个批次可能注册多个键） */
  const activeBatches = new Set()
  /** rpcId → { msgIds:[], answeredByUs } —— 含已结算，防重连重放重复发帖 */
  const seenRpcIds = new Map()

  function clearBatch(batch) {
    for (const key of batch.keys) pendingByFeishuId.delete(key)
    activeBatches.delete(batch)
  }

  /**
   * 发送第 index 题（1-based）并登记命中键。
   * 关键：飞书话题线程里用户回帖事件带的 parent/root 可能是线程根而不是
   * 提问消息本身，所以把【提问消息 id + 发帖父消息 + 服务端返回的 root/parent】
   * 全部注册为命中键，任一键命中都能继续作答。
   *
   * 发卡优先；卡片发不出去（返回 null 或抛错）就回退纯文本。注意 `meta` 必须在
   * 每次尝试前清空——失败那次可能已经写进了 root/parent，混用会登记出错键。
   */
  async function postRound(batch, index) {
    const question = batch.questions[index - 1]
    // 首题优先落该会话最近使用的飞书线程；后续轮次直接跟在上一条后面
    const parent = index === 1
      ? (latestThreadLookup?.(batch.sessionId) ?? null)
      : batch.msgIds[batch.msgIds.length - 1] ?? null

    let posted = null
    const meta = {}
    const card = typeof postCardToSession === 'function'
      ? buildQuestionCard({ rpcId: batch.rpcId, question, index, total: batch.questions.length })
      : null

    if (card) {
      try {
        posted = await postCardToSession(card, batch.sessionId, parent, meta)
        if (posted?.messageId) {
          batch.cardRounds.add(index)
          debugLog?.('card-sent', JSON.stringify({ rpcId: batch.rpcId, round: index, messageId: posted.messageId }))
        } else {
          posted = null
        }
      } catch (err) {
        // 卡片发不出去是可预期的（客户端 <7.20、权限、格式）：静默回退纯文本，
        // 但要留痕——否则「为什么有时是卡片有时是文本」无从查起。
        log('warn', '提问卡片发送失败，回退纯文本:', String(err?.message ?? err))
        debugLog?.('card-send-failed', JSON.stringify({
          rpcId: batch.rpcId, round: index, code: err?.feishuCode ?? null, error: String(err?.message ?? err),
        }))
        posted = null
      }
    }

    if (!posted?.messageId) {
      for (const key of Object.keys(meta)) delete meta[key]
      const text = formatQuestionText([question], { index, total: batch.questions.length })
      try {
        posted = await postToSession(text, batch.sessionId, parent, meta)
      } catch (err) {
        log('warn', '提问转发到飞书失败:', String(err))
        throw err
      }
    }

    if (posted?.messageId) {
      batch.msgIds.push(posted.messageId)
      const keys = new Set(
        [posted.messageId, meta.rootId, meta.parentId, parent]
          .filter((k) => typeof k === 'string' && k),
      )
      for (const key of keys) pendingByFeishuId.set(key, batch)
      if (!batch.keys) batch.keys = new Set()
      for (const key of keys) batch.keys.add(key)
      debugLog?.('register', JSON.stringify({ rpcId: batch.rpcId, round: index, messageId: posted.messageId, parent, returnedRoot: meta.rootId ?? null, returnedParent: meta.parentId ?? null, keys: [...keys] }))
    }
    return posted?.messageId ?? null
  }

  async function handleQuestionRequested(rpcId, payload) {
    const { sessionId, questions } = payload ?? {}
    // sessionId 只用于「线程锚点 + 记账」；缺失时退化为发到默认目的地，不该整批丢弃
    if (!Array.isArray(questions) || questions.length === 0) return
    // 同步先占位：重连重放可能并发到达，await 发帖期间第二个帧也必须被去重
    if (seenRpcIds.has(rpcId)) return
    const batch = {
      rpcId, sessionId, questions, cursor: 0, answers: [], msgIds: [],
      keys: new Set(), cardRounds: new Set(),
    }
    // seen 与 batch 共享同一个 msgIds 数组：resolved 清算与作答清算看到同一份登记
    const seen = { msgIds: batch.msgIds, batch, answeredByUs: false }
    seenRpcIds.set(rpcId, seen)
    // 先登记为活跃批次：卡片一旦发出就可能被点击，而发帖是异步的。
    // （发帖失败/没拿到 messageId 时在下面撤回登记。）
    activeBatches.add(batch)
    while (seenRpcIds.size > 500) {
      seenRpcIds.delete(seenRpcIds.keys().next().value)
    }

    try {
      await postRound(batch, 1)
    } catch {
      seenRpcIds.delete(rpcId) // 发帖失败：允许下次重放重试
      activeBatches.delete(batch)
      return
    }
    if (batch.msgIds.length === 0) {
      seenRpcIds.delete(rpcId)
      activeBatches.delete(batch)
      return
    }
    recordReplyMapping?.(batch.msgIds[0], {
      sessionId, turn: null, ts: Date.now(), source: 'feishu-question',
    })
    log('info', `[提问] ${rpcId} ${questions.length} 题 → 飞书 (${sessionId})${batch.cardRounds.size > 0 ? ' [卡片]' : ' [文本]'}`)
  }

  /**
   * 把一题的作答应用到批次：推进游标 → 发下一题 → 或全部答完一次性提交。
   * 文本回帖与卡片点击共用本函数，所以两条入口的进度、回滚、去重语义完全一致。
   *
   * @param {object} hit 批次
   * @param {{selected:string[], custom?:string}} parsed 结构化作答
   * @param {object} [opts]
   * @param {string|null} [opts.messageId] 用户的回帖 id（文本路径用它做回执锚点）
   * @param {((text:string)=>Promise<void>)|null} [opts.notify] 文字回执；卡片路径传 null
   *        （卡片本身就是回执，再发文字只是噪音）
   * @param {boolean} [opts.record] 是否把 messageId 记进 reply-map（卡片不是回帖，不记）
   * @returns {Promise<{status:string, question:object, answer?:object, error?:unknown}>}
   */
  async function applyParsedAnswer(hit, parsed, { messageId = null, notify = null, record = false } = {}) {
    const question = hit.questions[hit.cursor]
    hit.answers[hit.cursor] = { question, parsed }
    hit.cursor += 1

    // ── 还有下一题：发出下一轮，等待继续作答 ──
    if (hit.cursor < hit.questions.length) {
      try {
        await postRound(hit, hit.cursor + 1)
        return { status: 'advanced', question }
      } catch (err) {
        // 发下一题失败：回滚本题进度，允许用户重答触发重发
        hit.cursor -= 1
        hit.answers.pop()
        if (notify) await notify('⚠️ 下一题发送失败：' + String(err?.message ?? err) + '。请重新回答本题为重试。')
        return { status: 'advanced-failed', question, error: err }
      }
    }

    // ── 全部答完：一次性提交 ──
    const answer = {
      answers: hit.answers.map(({ question: q, parsed: p }) => ({
        id: q.id,
        selected: p.selected,
        ...(p.custom !== undefined ? { custom: p.custom } : {}),
      })),
    }
    let outcome
    try {
      outcome = await respondViaMux({
        rpcId: hit.rpcId,
        result: { ok: true, value: { sessionId: hit.sessionId, answer } },
      })
    } catch (err) {
      log('warn', '提交回答失败:', String(err))
      // 提交失败：回滚最后一题，用户重新作答即可整体重提
      hit.cursor -= 1
      hit.answers.pop()
      if (notify) await notify('⚠️ 提交回答失败：' + String(err?.message ?? err) + '。请重新回答本题以整体重试。')
      return { status: 'submit-failed', question, error: err, answer }
    }
    const receipt = outcome?.receipt ?? outcome
    const retriedAfterError = outcome?.retried === true

    const seen = seenRpcIds.get(hit.rpcId)
    if (receipt?.accepted === false) {
      // bad-response = 我方载荷被服务端 schema 拒收，是插件 bug，绝不能
      // 伪装成「网页端已处理」；回滚最后一题让用户重答，同时留下日志。
      if (receipt?.reason === 'bad-response') {
        log('error', `[提问] respond 被拒（bad-response）：载荷不符合服务端 schema`, JSON.stringify({ rpcId: hit.rpcId }))
        debugLog?.('respond-rejected', JSON.stringify({ rpcId: hit.rpcId, reason: 'bad-response' }))
        hit.cursor -= 1
        hit.answers.pop()
        if (notify) await notify('⚠️ 回答提交被拒绝（协议格式错误），请稍后重答本题。')
        return { status: 'bad-response', question, answer }
      }
      clearBatch(hit)
      // not-pending：真抢答或请求已失效。重试后拿到它更可能是首次已被受理
      // （响应丢失），按成功口径确认而非误导「已在网页端处理」。
      const note = retriedAfterError
        ? '✅ 回答已提交（首次回执超时，若网页端未见生效请忽略本条）。'
        : 'ℹ️ 该问题已在 DSH 网页端处理，无需重复回答。'
      if (notify) await notify(note)
      return { status: 'not-pending', retried: retriedAfterError, question, answer }
    }

    if (seen) seen.answeredByUs = true
    clearBatch(hit)
    if (record && messageId) {
      recordReplyMapping?.(messageId, {
        sessionId: hit.sessionId, turn: null, ts: Date.now(), source: 'feishu-question-answer',
      })
    }
    if (notify) await notify(formatBatchConfirmation(hit.answers))
    return { status: 'submitted', question, answer }
  }

  /**
   * 入站拦截点：用户回帖若针对挂起提问，消费之。
   * 返回 true 表示已按回答处理，调用方应跳过常规路由。
   */
  async function interceptReply({ parentMessageId, rootMessageId, messageId, text }) {
    const hit = pendingByFeishuId.get(parentMessageId) ?? pendingByFeishuId.get(rootMessageId)
    debugLog?.('intercept', JSON.stringify({
      parent: parentMessageId ?? null, root: rootMessageId ?? null,
      text: String(text ?? '').slice(0, 60),
      hit: hit ? hit.rpcId : null,
      registeredSample: hit ? null : [...pendingByFeishuId.keys()].slice(0, 6),
    }))
    if (!hit) return false

    const notify = (t) => postToSession(t, hit.sessionId, messageId).catch(() => undefined)

    // ── 整批取消 ──
    if (isCancelCommand(text)) {
      clearBatch(hit)
      seenRpcIds.get(hit.rpcId).answeredByUs = true // 我方主动取消，resolved 时不再补提示
      let receipt = null
      try {
        const out = await respondViaMux({
          rpcId: hit.rpcId,
          result: { ok: false, error: { code: 'cancelled', message: '用户在飞书取消了这批提问', details: {} } },
        })
        receipt = out?.receipt ?? out
      } catch (err) {
        log('warn', '取消提问失败:', String(err))
      }
      const note = receipt?.accepted === false
        ? 'ℹ️ 该问题已在 DSH 网页端处理，取消未生效。'
        : '✅ 已取消这批提问，会话将收到取消信号。'
      await notify(note)
      return true
    }

    const question = hit.questions[hit.cursor]
    const parsed = parseAnswerChoice(text, question)
    if (!parsed.ok) {
      await notify('⚠️ 无法识别的回答：' + parsed.reason + '。请回复选项编号，或直接输入自定义文字。')
      return true // 已消费，避免无效文本被注入会话
    }

    await applyParsedAnswer(hit, parsed, { messageId, notify, record: true })
    return true
  }

  /** 卡片回传的 value → 与 parseAnswerChoice 同形状的作答。 */
  function parsedFromCardAction({ kind, option, optionIndex }, question) {
    const labels = (question?.options ?? []).map((o) => o.label)
    // 回传的选项原文可信（是我们自己发出去的），但只接受**本题现有**的选项：
    // 既挡住过期卡片的点击，也挡住伪造值。
    const label = typeof option === 'string' && labels.includes(option)
      ? option
      : (Number.isInteger(optionIndex) ? labels[optionIndex] : undefined)
    if (typeof label !== 'string' || label === '') return { ok: false, reason: 'unknown-option' }
    return { ok: true, selected: [label] }
  }

  /**
   * 卡片回传交互 → 作答（card.action.trigger 的真实入口）。
   *
   * 官方要求回调 **3 秒内**响应且不可用 3xx，所以这里**同步**给出已答态卡片（乐观渲染），
   * 状态机的推进/提交异步进行：失败（回滚或协议错误）时用 im.message.patch 把卡片退回
   * 待答态，避免"界面说答了、实际没提交"。
   *
   * @returns {Promise<{toast:object, card:object|null}>} 交给入站去包成
   *          `{toast, card:{type:'raw',data}}`
   */
  async function handleCardAction(action = {}) {
    const { rpcId, questionId, kind, option, optionIndex, customText, messageId } = action
    debugLog?.('card-action', JSON.stringify({
      rpcId: rpcId ?? null, questionId: questionId ?? null, kind: kind ?? null,
      option: option ?? null, messageId: messageId ?? null,
    }))

    const seen = seenRpcIds.get(rpcId)
    const hit = seen?.batch
    if (!hit || !activeBatches.has(hit)) {
      return { toast: { type: 'warning', content: '该提问已结束' }, card: null }
    }
    const question = hit.questions[hit.cursor]
    if (!question) return { toast: { type: 'warning', content: '该提问已结束' }, card: null }
    // 卡片可能落后于批次（用户点了上一轮的卡、或重放）：按 questionId 只认当前题
    if (questionId && questionId !== question.id) {
      return { toast: { type: 'warning', content: '该题已作答，这张卡片已过期' }, card: null }
    }

    const skipped = kind === 'skip'
    const custom = kind === 'custom' ? String(customText ?? '').trim() : ''
    if (kind === 'custom' && custom === '') {
      return { toast: { type: 'warning', content: '请先输入内容再提交' }, card: null }
    }
    // 跳过 = 跳过**本题**（空 selected，正是既有"被跳过"的表示），不是取消整批。
    // 自定义输入同理：先落成空 selected，再把自由文本放进 custom 覆盖，
    // 所以这两种都**不**走选项解析（它们本来就没有选项可解）。
    const parsed = (skipped || kind === 'custom')
      ? { ok: true, selected: [] }
      : parsedFromCardAction({ kind, option, optionIndex }, question)
    if (!parsed.ok) {
      return { toast: { type: 'warning', content: '无法识别该选项，请重试' }, card: null }
    }
    if (custom) parsed.custom = custom

    const index = hit.cursor + 1
    const total = hit.questions.length
    const chosenIndex = parsed.custom
      ? null
      : (question.options ?? []).findIndex((o) => o.label === parsed.selected[0])
    const settledCard = buildQuestionCard({
      rpcId, question, index, total,
      state: skipped ? 'skipped' : 'answered',
      chosenIndex: chosenIndex >= 0 ? chosenIndex : null,
      custom: parsed.custom ?? null,
    })

    void applyParsedAnswer(hit, parsed, { notify: null, record: false })
      .then((result) => {
        debugLog?.('card-answer', JSON.stringify({ rpcId, questionId: question.id, status: result?.status ?? null }))
        const rolledBack = result?.status === 'advanced-failed'
          || result?.status === 'submit-failed'
          || result?.status === 'bad-response'
        if (rolledBack && messageId && typeof patchCard === 'function') {
          const backToPending = buildQuestionCard({ rpcId, question, index, total })
          if (backToPending) {
            void patchCard(messageId, backToPending)
              .catch((err) => log('warn', '卡片退回待答态失败:', String(err?.message ?? err)))
          }
        }
      })
      .catch((err) => {
        log('warn', '卡片作答处理失败:', String(err))
        debugLog?.('card-answer-failed', JSON.stringify({ rpcId, error: String(err?.message ?? err) }))
      })

    return {
      toast: {
        type: skipped ? 'warning' : 'success',
        content: skipped
          ? '已跳过本题'
          : (parsed.custom ? '已提交自定义答案' : '已选择：' + parsed.selected[0]),
      },
      card: settledCard,
    }
  }

  function respondViaMux(message) {
    if (respondOverride) return respondOverride(message)
    return mux.respond(message)
  }
  let respondOverride = null

  /**
   * 网页端先答：把那张提问卡原地刷成已答态。
   * 只有**以卡片发出的那一轮**才可 patch（纯文本消息不是卡片，PATCH 会失败），
   * 且卡片构造器保证 config.update_multi=true（共享卡片才允许更新，14 天内）。
   */
  async function settleCardFromWebAnswer(seen, { sessionId, answer }) {
    if (typeof patchCard !== 'function') return
    const batch = seen.batch
    if (!batch) return
    const round = batch.msgIds.length
    if (!batch.cardRounds.has(round)) return
    const messageId = batch.msgIds[round - 1]
    if (!messageId) return
    const question = batch.questions[Math.min(batch.cursor, batch.questions.length - 1)]
    if (!question) return

    const item = Array.isArray(answer?.answers)
      ? answer.answers.find((a) => a?.id === question.id)
      : undefined
    const custom = typeof item?.custom === 'string' && item.custom ? item.custom : null
    const selected = Array.isArray(item?.selected) ? item.selected : []
    const chosenIndex = custom ? null : (question.options ?? []).findIndex((o) => selected.includes(o.label))
    const card = buildQuestionCard({
      rpcId: batch.rpcId, question, index: batch.cursor + 1, total: batch.questions.length,
      state: 'answered',
      chosenIndex: chosenIndex >= 0 ? chosenIndex : null,
      custom,
    })
    if (!card) return
    try {
      await patchCard(messageId, card)
      debugLog?.('card-patched', JSON.stringify({ rpcId: batch.rpcId, messageId, sessionId: sessionId ?? null }))
    } catch (err) {
      // 更新卡片失败不影响会话本身，只留痕
      log('warn', '更新提问卡片失败（不影响会话）:', String(err?.message ?? err))
      debugLog?.('card-patch-failed', JSON.stringify({ rpcId: batch.rpcId, messageId, code: err?.feishuCode ?? null }))
    }
  }

  function handleResolved(payload) {
    const { sessionId, questionRpcId, outcome, answer } = payload ?? {}
    const seen = seenRpcIds.get(questionRpcId)
    if (!seen) return
    for (const msgId of seen.msgIds) pendingByFeishuId.delete(msgId)
    if (seen.batch) activeBatches.delete(seen.batch)
    debugLog?.('resolved', JSON.stringify({ rpcId: questionRpcId, outcome: outcome ?? null, hasAnswer: Boolean(answer) }))
    if (!seen.answeredByUs) {
      if (outcome !== 'cancelled') {
        // 网页端赢：卡片还停在待答态，刷成已答态（卡片本身就是回执）
        void settleCardFromWebAnswer(seen, { sessionId, answer })
          .catch((err) => log('warn', '刷新提问卡片失败:', String(err)))
      }
      const note = outcome === 'cancelled'
        ? 'ℹ️ 该问题已被取消。'
        : 'ℹ️ 该问题已在 DSH 网页端被回答，会话继续执行中。'
      void postToSession(note, sessionId, seen.msgIds[seen.msgIds.length - 1] ?? null).catch(() => undefined)
    }
  }

  /** 下行帧分发（mux-client 已剥壳为 {rpcId, payload}）：按 payload.type 路由。 */
  function dispatchFrame(frame) {
    const type = frame?.payload?.type
    if (type === 'question/requested') {
      void handleQuestionRequested(String(frame.rpcId ?? ''), frame.payload)
    } else if (type === 'question/resolved') {
      handleResolved(frame.payload)
    }
  }

  const mux = createMuxClient({
    origin,
    openSocket,
    onFrame: (frame) => {
      Promise.resolve(dispatchFrame(frame)).catch((err) =>
        log('warn', '提问帧处理异常:', String(err)))
    },
    log,
  })

  return {
    interceptReply,
    handleCardAction,
    close: () => mux.close(),
    done: mux.done,
    __setRespondForTest: (fn) => { respondOverride = fn },
    /** 宿主接缝（DSH ≥0.1.5）：直接喂一个 {rpcId, payload} 下行帧，不经 /api。 */
    __injectFrame: (frame) => dispatchFrame(frame),
    /** 测试缝：当前登记的飞书消息数 */
    __pendingCount: () => activeBatches.size,
  }
}
