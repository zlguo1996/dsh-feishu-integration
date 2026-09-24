/**
 * DSH session 网关：HTTP RPC 通路 + 会话存在性 + 路由信息 + 默认会话创建
 * + prompt 注入并轮询最终回答（ask）。
 */

import { randomUUID } from 'node:crypto'
import { PROMPT_RPC_PREFIX } from '../shared/constants.js'

/** 纯函数：从 session.list 条目解析路由回执所需的 workspace/title。 */
export function pickRouteInfo(items, sessionId, fallbackWorkspace) {
  const item = (items ?? []).find((candidate) => candidate.sessionId === sessionId)
  return {
    workspacePath: item?.cwd || fallbackWorkspace,
    sessionTitle: item?.projections?.values?.title || '未命名会话',
  }
}

export function createSessionGateway({
  origin, workspace, agentPreset, replyTimeoutMs, log,
  sessionController, workspaceRegistry,
}) {

  // ── 宿主服务优先；HTTP 仅为旧版 DSH 的兼容回退 ──
  // DSH 0.1.5-rc.2 的 /api 受浏览器会话鉴权保护。插件作为宿主内代码没有
  // 浏览器 cookie，回环请求必然得到 401；这里直接使用同一进程服务。
  async function rpc(method, payload = {}, timeoutMs = 30000, options = {}) {
    if (sessionController && workspaceRegistry) {
      switch (method) {
        case 'workspace.list':
          return { items: workspaceRegistry.list().map((item) => ({ workspaceId: item.id, path: item.path })) }
        case 'workspace.create': {
          const item = await workspaceRegistry.create(payload.path)
          return { workspace: { workspaceId: item.id, path: item.path } }
        }
        case 'session.create': return await sessionController.create(payload)
        case 'session.list': return await sessionController.list({})
        case 'session.history': {
          try {
            const snapshot = await sessionController.inspect(payload.sessionId)
            return { events: snapshot.events.map((event) => ({ event })) }
          } catch (err) {
            // 旧 HTTP 通路靠错误码区分「会话不存在」；宿主服务 inspect() 抛的是普通
            // Error（session "..." not found）。不把 code 补回去的话，
            // sessionExistsSafe 会把它当未知错误上抛（实测会拖垮整个宿主进程）。
            if (/not found/i.test(String(err?.message ?? err))) {
              const e = new Error(String(err?.message ?? err))
              e.code = 'session-not-found'
              throw e
            }
            throw err
          }
        }
        case 'session.prompt':
          return await sessionController.prompt({
            ...payload,
            requestId: options.rpcId ?? PROMPT_RPC_PREFIX + 'rpc-' + randomUUID(),
          }, AbortSignal.timeout(timeoutMs))
        default: throw new Error(`Unsupported internal Harness method: ${method}`)
      }
    }

    // 旧版兼容：仅在宿主未提供上述服务时才走浏览器 API 回环。
    const rpcId = options.rpcId ?? PROMPT_RPC_PREFIX + 'rpc-' + randomUUID()
    const response = await fetch(new URL('/api/' + method, origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`Harness transport ${method}: HTTP ${response.status}`)
    const body = await response.json()
    if (body?.type !== 'server-response' || body?.rpcId !== rpcId) {
      throw new Error(`Harness 返回了无效响应 (${method})`)
    }
    if (!body.result?.ok) {
      const err = new Error(`${method}: ${body.result?.error?.message ?? 'unknown error'}`)
      err.code = body.result?.error?.code
      throw err
    }
    return body.result.value
  }

  async function sessionExistsSafe(sessionId) {
    try {
      await rpc('session.history', { sessionId, maxMessages: 1 })
      return true
    } catch (err) {
      if (err.code === 'session-not-found') return false
      throw err
    }
  }

  async function sessionRouteInfo(sessionId) {
    try {
      const { items } = await rpc('session.list', {})
      return pickRouteInfo(items, sessionId, workspace)
    } catch (err) {
      log('warn', '读取会话路由信息失败，使用配置空间:', String(err))
      return { workspacePath: workspace, sessionTitle: '未命名会话' }
    }
  }

  async function createFixedSession(key) {
    const { items } = await rpc('workspace.list', {})
    let workspaceId = items.find((i) => i.path === workspace)?.workspaceId
    if (!workspaceId) {
      const created = await rpc('workspace.create', { path: workspace })
      workspaceId = created.workspace.workspaceId
    }
    const r = await rpc('session.create', { workspaceId, agentPreset })
    log('info', `为 ${key} 创建默认会话 ${r.sessionId}`)
    return r.sessionId
  }

  /**
   * 只注入 prompt，**不等回答**。
   *
   * 为什么需要它：飞书发起的回合不需要在这里等结果 —— 出站投递与「回合结束」都挂在
   * `session/event` 的 turn/end 上（与 Web 发起的回合同一条路径）。原先入站路径用
   * `ask()` 等整轮并带 `replyTimeoutMs` 硬超时，一旦超时就把回复**静默丢弃**；改为
   * 只注入之后，这条链路上不再存在「等待」与「超时」两个概念。
   *
   * @returns {Promise<string>} 本条 prompt 的 rpcId（PROMPT_RPC_PREFIX + uuid）
   */
  async function injectPrompt(sessionId, text) {
    const promptRpcId = PROMPT_RPC_PREFIX + randomUUID()
    await rpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, 30000, { rpcId: promptRpcId })
    return promptRpcId
  }

  return { rpc, sessionExistsSafe, sessionRouteInfo, createFixedSession, injectPrompt }
}
