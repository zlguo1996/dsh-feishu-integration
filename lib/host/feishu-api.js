/** 飞书开放平台直连：tenant_access_token 缓存 + 纯文本/卡片直发 + 线程回帖。 */

import { createHash } from 'node:crypto'
import { FEISHU_OPEN_BASE } from '../shared/constants.js'

const FETCH_TIMEOUT_MS = 15000
// token 无效类错误码：命中即逐出缓存，避免换 secret 后最长 2h 沿用旧 token
const INVALID_TOKEN_CODES = new Set([99991663, 99991661, 99991668])

export function createFeishuApi() {
  // ── token 缓存（tenant_access_token ~2h）──
  // key 含 secret 摘要：删 bot 后同 appId 重配新 secret 时不会沿用旧 token。
  const tokenCache = new Map()

  const cacheKey = (appId, appSecret) =>
    appId + ':' + createHash('sha256').update(String(appSecret)).digest('hex').slice(0, 12)

  async function tenantToken(appId, appSecret) {
    const key = cacheKey(appId, appSecret)
    const hit = tokenCache.get(key)
    if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token
    const res = await fetch(FEISHU_OPEN_BASE + '/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const body = await res.json().catch(() => ({}))
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error('tenant_access_token: ' + JSON.stringify(body))
    }
    const ttlMs = (body.expire ?? 7200) * 1000
    tokenCache.set(key, { token: body.tenant_access_token, expiresAt: Date.now() + ttlMs })
    return body.tenant_access_token
  }

  /** 业务 API 调用包装：token 失效时逐出缓存（下次调用会重新获取）。 */
  async function callFeishu(key, path, init) {
    const res = await fetch(FEISHU_OPEN_BASE + path, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.code !== 0) {
      if (INVALID_TOKEN_CODES.has(body.code)) tokenCache.delete(key)
      return { ok: false, status: res.status, body }
    }
    return { ok: true, body }
  }

  /**
   * 直发文本。opts.uuid：飞书 im/v1/messages 的幂等键——重试同一逻辑消息时
   * 传相同 uuid，服务端对「已送达但响应丢失」的场景去重，避免重复投递。
   */
  async function sendTextMessage({ appId, appSecret, receiveId, receiveType }, text, opts = {}) {
    const key = cacheKey(appId, appSecret)
    const token = await tenantToken(appId, appSecret)
    let path = '/im/v1/messages?receive_id_type=' + receiveType
    if (opts.uuid) path += '&uuid=' + encodeURIComponent(opts.uuid)
    const { ok, status, body } = await callFeishu(key, path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    })
    if (!ok) throw new Error('feishu im/v1/messages ' + status + ': ' + JSON.stringify(body))
    // 响应里若带线程信息，回填给调用方（提问桥用它做多键登记）
    if (opts.out && body?.data) {
      opts.out.rootId = body.data.root_id ?? null
      opts.out.parentId = body.data.parent_id ?? null
    }
    return body?.data?.message_id ?? ''
  }

  /**
   * 直发卡片（msg_type:'interactive'）。card 为卡片 JSON 对象。
   * 失败时在 Error 上带 feishuCode：调用方据此区分「卡片发不出去」（确定性，
   * 可回退纯文本）与瞬时故障（应交给重试层，不要换格式重发）。
   */
  async function sendCardMessage({ appId, appSecret, receiveId, receiveType }, card, opts = {}) {
    const key = cacheKey(appId, appSecret)
    const token = await tenantToken(appId, appSecret)
    let path = '/im/v1/messages?receive_id_type=' + receiveType
    if (opts.uuid) path += '&uuid=' + encodeURIComponent(opts.uuid)
    const { ok, status, body } = await callFeishu(key, path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      }),
    })
    if (!ok) {
      const err = new Error('feishu im/v1/messages(card) ' + status + ': ' + JSON.stringify(body))
      err.feishuCode = body?.code
      err.httpStatus = status
      throw err
    }
    if (opts.out && body?.data) {
      opts.out.rootId = body.data.root_id ?? null
      opts.out.parentId = body.data.parent_id ?? null
    }
    return body?.data?.message_id ?? ''
  }

  /**
   * 把回帖响应里的线程三元组回填给调用方。
   *
   * `thread_id` 必须回填：出站「卡片 = 话题根消息，完整回复 = 线程回复」这条链路
   * 靠它记账/排障（实测：带 reply_in_thread 的首次回帖才返回 thread_id）。
   */
  function fillThreadOut(opts, body) {
    if (!opts?.out || !body?.data) return
    opts.out.rootId = body.data.root_id ?? null
    opts.out.parentId = body.data.parent_id ?? null
    opts.out.threadId = body.data.thread_id ?? null
  }

  /**
   * 线程回帖（REST 版）：供提问桥 / 出站线程投递等不依赖 WSClient 的路径使用。
   *
   * opts.replyInThread：置 `data.reply_in_thread=true`。**首次**回帖必须带它才会真正
   *   创建飞书原生话题——实测（2026-09-24 金丝雀）不带它只得到 root_id/parent_id、
   *   没有 thread_id，客户端也就不会出现「N 条回复」入口。
   * opts.uuid：回帖侧的幂等键（**请求体**字段）。每个线程分段各用自己的 uuid，
   *   绝不复用根消息的 uuid，否则服务端会把不同分段当成同一条消息去重。
   */
  async function replyToMessage({ appId, appSecret, messageId }, text, opts = {}) {
    const key = cacheKey(appId, appSecret)
    const token = await tenantToken(appId, appSecret)
    const payload = { msg_type: 'text', content: JSON.stringify({ text }) }
    if (opts.uuid) payload.uuid = opts.uuid
    if (opts.replyInThread) payload.reply_in_thread = true
    const { ok, status, body } = await callFeishu(
      key,
      '/im/v1/messages/' + encodeURIComponent(messageId) + '/reply',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )
    if (!ok) throw new Error('feishu im/v1/messages/reply ' + status + ': ' + JSON.stringify(body))
    fillThreadOut(opts, body)
    return body?.data?.message_id ?? ''
  }

  /** 线程回帖**卡片**（msg_type:'interactive'）。提问桥逐题串行时用它把后续题目接在同一线程。 */
  async function replyCardMessage({ appId, appSecret, messageId }, card, opts = {}) {
    const key = cacheKey(appId, appSecret)
    const token = await tenantToken(appId, appSecret)
    const payload = { msg_type: 'interactive', content: JSON.stringify(card) }
    if (opts.uuid) payload.uuid = opts.uuid
    if (opts.replyInThread) payload.reply_in_thread = true
    const { ok, status, body } = await callFeishu(
      key,
      '/im/v1/messages/' + encodeURIComponent(messageId) + '/reply',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )
    if (!ok) {
      const err = new Error('feishu im/v1/messages/reply(card) ' + status + ': ' + JSON.stringify(body))
      err.feishuCode = body?.code
      err.httpStatus = status
      throw err
    }
    fillThreadOut(opts, body)
    return body?.data?.message_id ?? ''
  }

  /**
   * 更新**已发送**的消息卡片：PATCH /im/v1/messages/{message_id}，body `{content: <卡片 JSON 字符串>}`。
   * 官方约束：仅支持未撤回的**共享卡片**（即 `config.update_multi: true`）、
   * 消息发出后 **14 天**内可更新；失败同样在 Error 上带 feishuCode。
   */
  async function patchCardMessage({ appId, appSecret, messageId }, card) {
    const key = cacheKey(appId, appSecret)
    const token = await tenantToken(appId, appSecret)
    const { ok, status, body } = await callFeishu(
      key,
      '/im/v1/messages/' + encodeURIComponent(messageId),
      {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ content: JSON.stringify(card) }),
      },
    )
    if (!ok) {
      const err = new Error('feishu im/v1/messages(patch) ' + status + ': ' + JSON.stringify(body))
      err.feishuCode = body?.code
      err.httpStatus = status
      throw err
    }
    return body?.data?.message_id ?? messageId
  }

  return {
    tenantToken, sendTextMessage, sendCardMessage, replyToMessage,
    replyCardMessage, patchCardMessage,
  }
}
