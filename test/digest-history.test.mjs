/**
 * digest-history 持久化：把每个回合真正产出的摘要存下来，供后续回合当 formatter
 * 的历史背景。契约：只存摘要文本（不存回复全文）、先落盘再投递、有界、TTL、
 * 损坏即退化为空历史（绝不打断出站）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDigestHistoryStore } from '../lib/host/digest-history-store.js'

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-digest-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('记录并读取：按回合升序返回', () => withTempDir((dir) => {
  const store = createDigestHistoryStore({ historyPath: join(dir, 'digest-history.json') })
  store.record({ sessionId: 's1', turn: 3, summary: '第三轮' })
  store.record({ sessionId: 's1', turn: 1, summary: '第一轮' })
  store.record({ sessionId: 's1', turn: 2, summary: '第二轮' })
  assert.deepEqual(store.getForSession('s1').map((r) => r.turn), [1, 2, 3])
  assert.deepEqual(store.getForSession('s1').map((r) => r.summary), ['第一轮', '第二轮', '第三轮'])
}))

test('同一回合重复记录是 upsert（后者覆盖，不产生重复行）', () => withTempDir((dir) => {
  const store = createDigestHistoryStore({ historyPath: join(dir, 'digest-history.json') })
  store.record({ sessionId: 's1', turn: 5, summary: '旧摘要' })
  store.record({ sessionId: 's1', turn: 5, summary: '新摘要' })
  const rows = store.getForSession('s1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].summary, '新摘要')
}))

test('进程重启后仍能读回（落盘 + 新实例加载）', () => withTempDir((dir) => {
  const path = join(dir, 'digest-history.json')
  createDigestHistoryStore({ historyPath: path }).record({ sessionId: 's1', turn: 2, summary: '重启前的摘要' })
  const reloaded = createDigestHistoryStore({ historyPath: path })
  assert.equal(reloaded.getForSession('s1')[0].summary, '重启前的摘要')
}))

test('落盘内容是摘要文本，不含回复全文（存储边界）', () => withTempDir((dir) => {
  const path = join(dir, 'digest-history.json')
  const store = createDigestHistoryStore({ historyPath: path })
  store.record({ sessionId: 's1', turn: 1, summary: '一句话摘要' })
  const raw = readFileSync(path, 'utf8')
  assert.ok(raw.includes('一句话摘要'))
  assert.ok(!raw.includes('回复全文'), '不得把回复全文写进 digest-history')
}))

test('每 session 有界：只保留最新 N 个回合', () => withTempDir((dir) => {
  const store = createDigestHistoryStore({ historyPath: join(dir, 'digest-history.json'), maxTurnsPerSession: 3 })
  for (let t = 1; t <= 6; t++) store.record({ sessionId: 's1', turn: t, summary: `第${t}轮` })
  assert.deepEqual(store.getForSession('s1').map((r) => r.turn), [4, 5, 6])
}))

test('TTL：过期行被过滤掉', () => withTempDir((dir) => {
  const store = createDigestHistoryStore({ historyPath: join(dir, 'digest-history.json'), ttlDays: 7 })
  const old = Date.now() - 8 * 24 * 3600 * 1000
  store.record({ sessionId: 's1', turn: 1, summary: '过期', ts: old })
  store.record({ sessionId: 's1', turn: 2, summary: '新鲜', ts: Date.now() })
  assert.deepEqual(store.getForSession('s1').map((r) => r.summary), ['新鲜'])
}))

test('损坏/缺失文件退化为空历史，绝不抛错', () => withTempDir((dir) => {
  const path = join(dir, 'digest-history.json')
  writeFileSync(path, '{ 这不是 JSON')
  const store = createDigestHistoryStore({ historyPath: path })
  assert.deepEqual(store.getForSession('s1'), [])
  store.record({ sessionId: 's1', turn: 1, summary: '写回后可用' })
  assert.equal(store.getForSession('s1')[0].summary, '写回后可用')
}))

test('非法入参被忽略：没有 sessionId/turn/summary 都不写', () => withTempDir((dir) => {
  const store = createDigestHistoryStore({ historyPath: join(dir, 'digest-history.json') })
  store.record({ turn: 1, summary: 'x' })
  store.record({ sessionId: 's1', summary: 'x' })
  store.record({ sessionId: 's1', turn: 1, summary: '' })
  assert.deepEqual(store.getForSession('s1'), [])
}))

test('不同 session 互不干扰', () => withTempDir((dir) => {
  const store = createDigestHistoryStore({ historyPath: join(dir, 'digest-history.json') })
  store.record({ sessionId: 's1', turn: 1, summary: 'a' })
  store.record({ sessionId: 's2', turn: 1, summary: 'b' })
  assert.deepEqual(store.getForSession('s1').map((r) => r.summary), ['a'])
  assert.deepEqual(store.getForSession('s2').map((r) => r.summary), ['b'])
}))
