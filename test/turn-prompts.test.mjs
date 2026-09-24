/**
 * 回合 → 直接人类提问的重建：只认 `source.kind === 'user'`，
 * 排除 system-reminder / 工具注入 / agent.inject() 等一切非人类来源。
 * `user/message` 自身不带 turn，因此靠顺序消费 `turn/start` 关联回合。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { collectTurnPrompts, userPromptForTurn } from '../lib/shared/text.js'

const user = (text, source = { kind: 'user' }) => ({
  type: 'user/message',
  data: { role: 'user', content: [{ type: 'text', text }], source },
})

function makeSession(events) {
  return { id: 'session-1', snapshotEvents: () => events }
}

const EVENTS = [
  { type: 'turn/start', data: { turn: 1 } },
  user('q1'),
  // 非人类注入：system-reminder / 插件上下文 / goal 续跑，都必须被排除
  user('<system-reminder>项目规则</system-reminder>', { kind: 'plugin', plugin: 'agent-instructions' }),
  user('goal 续跑', { kind: 'goal' }),
  { type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }] } } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', data: { turn: 2 } },
  user('q2'),
  { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
]

test('只取真人输入，注入上下文与其他 source.kind 一律排除', () => {
  assert.deepEqual(collectTurnPrompts(makeSession(EVENTS)), [
    { turn: 1, text: 'q1' },
    { turn: 2, text: 'q2' },
  ])
})

test('userPromptForTurn 取指定回合；没有则空串', () => {
  const session = makeSession(EVENTS)
  assert.equal(userPromptForTurn(session, 2), 'q2')
  assert.equal(userPromptForTurn(session, 99), '')
})

test('同一回合的多条真人输入按顺序拼接（多段 content 也拼）', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }], source: { kind: 'user' } } },
    user('补充一句'),
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  assert.deepEqual(collectTurnPrompts(makeSession(events)), [{ turn: 1, text: '第一段第二段\n补充一句' }])
})

test('没有 turn/start 之前的 user/message 不归属任何回合（宁缺勿错）', () => {
  const events = [user('孤儿消息'), { type: 'turn/start', data: { turn: 1 } }, user('q1')]
  assert.deepEqual(collectTurnPrompts(makeSession(events)), [{ turn: 1, text: 'q1' }])
})

test('兼容只暴露 session.events 的老形态', () => {
  const session = { id: 's', events: EVENTS }
  assert.deepEqual(collectTurnPrompts(session).map((p) => p.text), ['q1', 'q2'])
})

test('兼容 data.message 包裹的老形态', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }, source: { kind: 'user' } } },
  ]
  assert.deepEqual(collectTurnPrompts(makeSession(events)), [{ turn: 1, text: 'q' }])
})

test('空 session 不抛错', () => {
  assert.deepEqual(collectTurnPrompts(undefined), [])
  assert.deepEqual(collectTurnPrompts({ snapshotEvents: () => [] }), [])
})
