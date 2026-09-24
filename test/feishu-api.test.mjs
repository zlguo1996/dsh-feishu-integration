/** feishu-api 回归：token 缓存按 appId+secret 摘要隔离，失败不残留脏缓存。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createFeishuApi } from '../lib/host/feishu-api.js'

function withFakeFetch(handler) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    return handler(calls.length - 1, { url: String(url), body: init?.body ? JSON.parse(init.body) : null })
  }
  return { calls, restore() { globalThis.fetch = real } }
}

test('same appId with a different secret mints a fresh token (no stale reuse)', async () => {
  const api = createFeishuApi()
  let n = 0
  const fake = withFakeFetch(() => {
    n += 1
    return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tk-' + n, expire: 7200 }), { headers: { 'content-type': 'application/json' } })
  })
  try {
    const t1 = await api.tenantToken('cli_a', 'secret-one')
    const t1again = await api.tenantToken('cli_a', 'secret-one')
    assert.equal(t1, 'tk-1')
    assert.equal(t1again, 'tk-1', '同 appId+secret 命中缓存')
    assert.equal(n, 1)

    const t2 = await api.tenantToken('cli_a', 'secret-two')
    assert.equal(t2, 'tk-2', '换 secret 必须重新取 token')
    assert.equal(n, 2)
  } finally {
    fake.restore()
  }
})

test('invalid-token business codes are surfaced (and would evict cache)', async () => {
  const api = createFeishuApi()
  // 先填充缓存
  const seed = withFakeFetch(() => new Response(JSON.stringify({ code: 0, tenant_access_token: 'tk-old', expire: 7200 })))
  await api.tenantToken('cli_b', 's')
  seed.restore()

  const fail = withFakeFetch((i) => {
    if (i === 0) return new Response(JSON.stringify({ code: 99991663, msg: 'invalid token' }))
    return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tk-fresh', expire: 7200 }))
  })
  try {
    await assert.rejects(
      () => api.tenantToken('cli_b', 'other-secret'),
      /99991663/,
    )
    const again = await api.tenantToken('cli_b', 'other-secret')
    assert.equal(again, 'tk-fresh', '失败后再次调用应重新获取而非复用脏缓存')
  } finally {
    fail.restore()
  }
})

// ── 线程回帖的真实契约（2026-09-24 回归）────────────────────────────────
// 出站线程投递曾把 replyToMessage 调成 (creds, rootId, text, opts)，而真实签名是
// `({appId, appSecret, messageId}, text, opts)` —— messageId 变成 undefined，飞书返回
// 400 `Invalid ids: [undefined]`，于是「根卡片在、线程永远不出现」。当时的单测 mock 与
// 实现犯的是同一个错，所以全绿。这里用假 fetch 直接锁 URL 与请求体，不经过调用方 mock。
test('replyToMessage 的真实契约：messageId 进 URL，reply_in_thread 与 uuid 进请求体', async () => {
  const api = createFeishuApi()
  const fake = withFakeFetch((_i, req) => {
    if (req.url.includes('/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tk', expire: 7200 }), { headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({
      code: 0,
      data: { message_id: 'om_reply', root_id: 'om_root', parent_id: 'om_root', thread_id: 'omt_x' },
    }), { headers: { 'content-type': 'application/json' } })
  })
  try {
    const out = {}
    const id = await api.replyToMessage(
      { appId: 'cli_x', appSecret: 's', messageId: 'om_root' },
      '完整回复正文',
      { replyInThread: true, uuid: 'u-c0', out },
    )
    assert.equal(id, 'om_reply')
    assert.deepEqual(out, { rootId: 'om_root', parentId: 'om_root', threadId: 'omt_x' },
      '必须回填 thread_id（出站线程记账/排障依赖它）')
    const reply = fake.calls.find((c) => c.url.includes('/reply'))
    assert.ok(reply, '必须打到 /reply 端点')
    assert.ok(reply.url.endsWith('/im/v1/messages/om_root/reply'),
      `URL 必须内嵌 messageId，实际 ${reply.url}`)
    assert.equal(reply.body.reply_in_thread, true, '首次线程回复必须带 reply_in_thread')
    assert.equal(reply.body.uuid, 'u-c0')
    assert.match(reply.body.content, /完整回复正文/)
  } finally {
    fake.restore()
  }
})
