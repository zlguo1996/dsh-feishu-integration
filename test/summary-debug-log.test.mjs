/**
 * 回归：出站摘要的结果必须**落盘**到 debugLog（bridge-debug.log）。
 *
 * 背景（2026-09-24）：插件的 `log` 走 `ctx.logger`，而 DSH 的 ctx 日志**只进 GUI
 * 控制台、不落盘**。于是「摘要到底走没走 LLM」在磁盘上完全不可观测 ——
 * 成功路径本来就没有日志，失败只进控制台，导致「没问题」与「根本没跑」长得
 * 一模一样（实践里据此误判过一次）。
 *
 * 修法：summary-service 每次出站都往共享的 bridge-debug.log 记一行
 * `summary {sessionId,turn,via,reason,elapsedMs,summaryChars,bullets}`，
 * 一条 `grep '"via":"fallback"'` 即可自查。成功也记，否则又变成「缺席即证据」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { installSummaryPush } from '../lib/host/summary-service.js'

async function until(fn, what = 'condition') {
  const deadline = Date.now() + 2000
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for ' + what)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const SESSION = {
  id: 'session-x',
  header: { cwd: '/tmp/demo' },
  snapshotEvents: () => [{
    type: 'assistant/message',
    data: {
      turn: 1,
      message: { content: [{ type: 'text', text: '连接池耗尽，建议把 maxPool 从 10 提到 20。' }] },
    },
  }],
}

function makeHarness(digest) {
  const handlers = {}
  const lines = []
  const sent = []
  installSummaryPush({ on: (name, fn) => { handlers[name] = fn } }, {
    title: 't', maxText: 1500, includeReasons: ['completed'], botSelection: 'all',
    notificationFormat: 'text',
    loadBots: () => [{ appId: 'cli_x', ownerOpenIds: ['ou_owner'] }],
    // 注意：凭据必须是 { value } 形状（targetsWithCredentials 判的是 secret?.value），
    // 返回裸字符串会被当成「凭据缺失」直接跳过，什么都不会发。
    resolveSecret: async () => ({ value: 'secret' }),
    sendTextMessage: async (_target, text) => { sent.push(text); return 'om_1' },
    sendCardMessage: async () => 'om_1',
    recordReplyMapping: () => {},
    readBotState: () => ({}),
    // 与生产实现同形：[ISO 时间] <tag> <json>（生产那层加了时间戳，这里也要加，
    // 否则断言的就是一个生产里不存在的形状）。
    debugLog: (...args) => lines.push(`[${new Date().toISOString()}] ${args.join(' ')}`),
    formatDigest: async () => digest,
    log: () => {},
  })
  return { handlers, lines, sent }
}

/** 触发一个「非飞书来源」的 turn/end（正是会送出总结的那种回合）。 */
function fireTurnEnd({ handlers }) {
  handlers['session/event'](SESSION, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
}

function parseSummaryLine(line) {
  assert.match(line, /\] summary \{/, '必须带 summary 标签便于 grep；实际: ' + line)
  return JSON.parse(line.slice(line.indexOf('{')))
}

test('走通 LLM 时也落盘一行（via=llm），否则「没问题」无法与「没跑」区分', async () => {
  const h = makeHarness({ summary: '连接池耗尽：上限 10、峰值 18。', bullets: ['提到 20'], via: 'llm' })
  fireTurnEnd(h)
  await until(() => h.lines.length > 0, 'debug line')

  const rec = parseSummaryLine(h.lines.at(-1))
  assert.equal(rec.via, 'llm')
  assert.equal(rec.reason, null)
  assert.equal(rec.turn, 1)
  assert.equal(rec.sessionId, 'session-x')
  assert.equal(typeof rec.elapsedMs, 'number')
  assert.equal(rec.summaryChars, '连接池耗尽：上限 10、峰值 18。'.length)
  assert.equal(rec.bullets, 1)

  // 落盘不影响投递：文本仍发出
  await until(() => h.sent.length > 0, 'send')
  assert.match(h.sent[0], /连接池耗尽/)
})

test('走兜底时落盘一行并带上断点原因（via=fallback + reason）', async () => {
  const h = makeHarness({
    summary: '连接池耗尽，建议把 maxPool 从 10 提到 20。',
    bullets: [],
    via: 'fallback',
    reason: 'formatter deadline 1500ms exceeded',
  })
  fireTurnEnd(h)
  await until(() => h.lines.length > 0, 'debug line')

  const rec = parseSummaryLine(h.lines.at(-1))
  assert.equal(rec.via, 'fallback')
  assert.equal(rec.reason, 'formatter deadline 1500ms exceeded')
  assert.equal(rec.bullets, 0)

  // 兜底也照样投递（只是摘要来源不同），绝不能让通知发不出去
  await until(() => h.sent.length > 0, 'send')
})

test('没有 debugLog 注入时照常工作（不能因为可观测性把主链路弄挂）', async () => {
  const handlers = {}
  const sent = []
  installSummaryPush({ on: (name, fn) => { handlers[name] = fn } }, {
    title: 't', maxText: 1500, includeReasons: ['completed'], botSelection: 'all',
    notificationFormat: 'text',
    loadBots: () => [{ appId: 'cli_x', ownerOpenIds: ['ou_owner'] }],
    resolveSecret: async () => ({ value: 'secret' }),
    sendTextMessage: async (_t, text) => { sent.push(text); return 'om_1' },
    sendCardMessage: async () => 'om_1',
    recordReplyMapping: () => {},
    readBotState: () => ({}),
    formatDigest: async () => ({ summary: 's', bullets: [], via: 'llm' }),
    log: () => {},
  })
  handlers['session/event'](SESSION, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await until(() => sent.length > 0, 'send without debugLog')
})
