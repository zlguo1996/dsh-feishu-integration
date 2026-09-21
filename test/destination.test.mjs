import test from 'node:test'
import assert from 'node:assert/strict'

import { installSummaryPush } from '../lib/host/summary-service.js'

/**
 * 出站目的地选择是本次 230101 事故的修复点，值得单独锁住。
 * 背景：飞书对「以 open_id 主动发送」会返回 code=230101
 * （"Sending messages to users is temporarily unavailable."，官方文档无此码），
 * 而同一应用以 chat_id 主动发送（文本与 2.0 卡片）均成功。因此 chat_id 必须优先。
 */

const fakeCtx = { on() {} }

function makeSummary(deps = {}) {
  return installSummaryPush(fakeCtx, {
    title: 't', maxText: 1500, includeReasons: ['completed'], botSelection: 'all',
    loadBots: () => [], resolveSecret: async () => null,
    sendTextMessage: async () => '', sendCardMessage: async () => '',
    recordReplyMapping: () => {}, log: () => {},
    ...deps,
  })
}

const bot = (extra = {}) => ({ appId: 'cli_x', ownerOpenIds: ['ou_owner'], ...extra })

test('配置里的 chatId 优先级最高', () => {
  const s = makeSummary({ chatId: 'oc_config', readBotState: () => ({ lastChatId: 'oc_learned' }) })
  assert.deepEqual(s.destinationFor(bot()), { receiveId: 'oc_config', receiveType: 'chat_id' })
})

test('入站学到的 lastChatId 优先于 open_id（本次修复的核心）', () => {
  const s = makeSummary({ readBotState: () => ({ lastChatId: 'oc_learned' }) })
  assert.deepEqual(s.destinationFor(bot()), { receiveId: 'oc_learned', receiveType: 'chat_id' })
})

test('配置 openId 仍然生效，但优先级低于 lastChatId', () => {
  const withLearned = makeSummary({ openId: 'ou_cfg', readBotState: () => ({ lastChatId: 'oc_learned' }) })
  assert.deepEqual(withLearned.destinationFor(bot()), { receiveId: 'oc_learned', receiveType: 'chat_id' })
  const withoutLearned = makeSummary({ openId: 'ou_cfg', readBotState: () => ({}) })
  assert.deepEqual(withoutLearned.destinationFor(bot()), { receiveId: 'ou_cfg', receiveType: 'open_id' })
})

test('没有 chatId / lastChatId 时退回 bot.ownerOpenIds[0]', () => {
  const s = makeSummary({ readBotState: () => ({}) })
  assert.deepEqual(s.destinationFor(bot()), { receiveId: 'ou_owner', receiveType: 'open_id' })
})

test('未注入 readBotState 也不崩，退回 open_id', () => {
  const s = makeSummary()
  assert.deepEqual(s.destinationFor(bot()), { receiveId: 'ou_owner', receiveType: 'open_id' })
})

test('readBotState 抛错时降级为 open_id，而不是让通知发不出去', () => {
  const s = makeSummary({ readBotState: () => { throw new Error('state unreadable') } })
  assert.deepEqual(s.destinationFor(bot()), { receiveId: 'ou_owner', receiveType: 'open_id' })
})

test('无任何可用目标时返回 null', () => {
  const s = makeSummary({ readBotState: () => ({}) })
  assert.equal(s.destinationFor({ appId: 'cli_x' }), null)
})
