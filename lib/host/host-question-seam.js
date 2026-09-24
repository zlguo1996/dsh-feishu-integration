/**
 * 宿主提问接缝（DSH ≥0.1.5-rc.2）。
 *
 * 背景：提问桥原本经 /api/events.mux（下行帧）与 POST /api/respond（上行作答）工作。
 * 当前 DSH 的 /api 受浏览器会话鉴权保护，插件进程没有浏览器凭据，回环请求必得 401，
 * 于是「会话挂起 ask_user_question → 问题发到飞书 → 在飞书作答」整条链路是死的。
 *
 * 现在改走宿主侧的 Cordis waterfall `user-questions/request`（dsh-user-questions 的公开接缝）：
 *   进：拿到 request（questions/agent/signal）→ 组装成桥认得的 {rpcId,payload} 帧注入；
 *   出：拦下桥的 respond 调用 → 把回答 resolve 回 waterfall（不再 POST /api/respond）。
 * 同时照常 next()，让网页端的提问弹窗继续存在——两边谁先答谁生效，网页端先答则
 * 由桥按老逻辑回一条「已在网页端处理」的提示。
 */

import { randomUUID } from 'node:crypto'

/** 与网页端取消提问时同款错误：name/code 对齐 dsh-user-questions 的还原逻辑。 */
function cancelledError() {
  const err = new Error('the user cancelled ask_user_question')
  err.name = 'UserQuestionError'
  err.code = 'ASK_CANCELLED'
  return err
}

export function installHostQuestionSeam(ctx, bridge, { log, debug } = {}) {
  /** rpcId → {resolve, reject, sessionId} */
  const pending = new Map()

  // 上行：桥原来 POST /api/respond，现在直接把回答交给 waterfall
  bridge.__setRespondForTest(async (message) => {
    const entry = pending.get(message?.rpcId)
    if (!entry) return { accepted: false, reason: 'not-pending' }
    pending.delete(message.rpcId)
    bridge.__injectFrame({
      payload: {
        type: 'question/resolved',
        sessionId: entry.sessionId,
        questionRpcId: message.rpcId,
        outcome: message?.result?.ok ? 'answered' : 'cancelled',
        // 带上答案：桥靠它在网页端/飞书作答后把卡片刷成"选了哪一项"。
        // 只带 outcome 的话卡片只能显示"已回答"，说不到具体选项。
        answer: message?.result?.ok ? (message.result.value?.answer ?? null) : null,
      },
    })
    debug?.('respond', JSON.stringify({ rpcId: message?.rpcId, ok: Boolean(message?.result?.ok) }))
    if (message?.result?.ok) entry.resolve(message.result.value?.answer)
    else entry.reject(cancelledError())
    return { accepted: true }
  })

  const dispose = ctx.on('user-questions/request', async function hostQuestionSeam(request, next) {
    const questions = request?.questions
    if (!Array.isArray(questions) || questions.length === 0) return next()
    // 运行时 Agent 暴露的是 `session`（Session 实例）；client-safe 投影上可能叫 id
    const agent = request?.agent
    const sessionId = agent?.session?.id ?? agent?.sessionId ?? agent?.id ?? ''
    debug?.('request', JSON.stringify({ sessionId, questions: questions.length, hasAgent: Boolean(agent) }))

    const rpcId = 'hostq-' + randomUUID()
    const fromFeishu = new Promise((resolve, reject) => {
      pending.set(rpcId, { resolve, reject, sessionId })
      const signal = request?.signal
      if (signal?.aborted) {
        pending.delete(rpcId)
        reject(cancelledError())
        return
      }
      signal?.addEventListener?.('abort', () => {
        const entry = pending.get(rpcId)
        if (!entry) return
        pending.delete(rpcId)
        bridge.__injectFrame({
          payload: { type: 'question/resolved', sessionId, questionRpcId: rpcId, outcome: 'cancelled' },
        })
        entry.reject(cancelledError())
      }, { once: true })
    })

    // 注入到桥：与 mux 下行帧同款，桥的发帖/多题串行/线程登记逻辑原样复用
    Promise.resolve(bridge.__injectFrame({
      rpcId,
      payload: { type: 'question/requested', sessionId, questions },
    })).catch((err) => log?.('warn', '提问帧注入失败:', String(err)))

    // 网页端并行：先答就用它，答不了（无客户端接入等）也不影响飞书这条等待
    const fromWeb = Promise.resolve()
      .then(() => next())
      .then((answer) => {
        const entry = pending.get(rpcId)
        debug?.('web-answered', JSON.stringify({ rpcId, hadPending: Boolean(entry) }))
        if (entry) {
          pending.delete(rpcId)
          // 清算桥侧批次：桥会按老逻辑回一条「已在网页端被回答」的说明，
          // 并把那张提问卡刷成已答态（answer 用于显示具体选了哪一项）。
          bridge.__injectFrame({
            payload: {
              type: 'question/resolved',
              sessionId,
              questionRpcId: rpcId,
              outcome: 'answered',
              answer: answer ?? null,
            },
          })
        }
        return answer
      })
      .catch(() => new Promise(() => {}))

    return await Promise.race([fromFeishu, fromWeb])
  }, { prepend: true })

  return { dispose, pendingCount: () => pending.size }
}
