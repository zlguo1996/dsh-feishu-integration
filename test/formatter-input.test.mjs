/**
 * formatter 输入组装：历史项选择（最近 5 条、时间序、缺失不补造）+ 16 KiB 预算分配。
 *
 * 契约来自 Codex FINAL 修订版：历史只做指代消解、不授权事实；预算优先级
 * 回复 > 提问 > 历史；只允许截断，不许为了塞进预算而总结或改写。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFormatterInput,
  clipToBytes,
  selectPriorItems,
  MAX_PRIOR_ITEMS,
  PRIOR_ITEM_MAX_BYTES,
  PRIOR_TOTAL_MAX_BYTES,
  QUESTION_MAX_BYTES,
  NO_PRIOR_CONTEXT,
  LABEL_PRIOR,
  LABEL_QUESTION,
  LABEL_REPLY,
} from '../lib/shared/formatter-input.js'
import { DEFAULT_MAX_INPUT_BYTES } from '../lib/shared/notification-digest.js'

const bytes = (s) => Buffer.byteLength(s, 'utf8')

// ── 历史项选择 ──────────────────────────────────────────────────────────

test('「5 条消息」= 5 个会话项：用户输入与该回合的总结各算一项，取最近 5 项并回到时间序', () => {
  const items = selectPriorItems({
    prompts: [{ turn: 7, text: 'q7' }, { turn: 8, text: 'q8' }, { turn: 9, text: 'q9' }],
    summaries: [{ turn: 7, summary: 's7' }, { turn: 8, summary: 's8' }, { turn: 9, summary: 's9' }],
    currentTurn: 10,
  })
  // 6 项里取最近 5 项：turn7 的用户输入被挤出，其余按时间序、回合内 user 在前
  assert.deepEqual(items, [
    { turn: 7, kind: 'assistant_summary', text: 's7' },
    { turn: 8, kind: 'user', text: 'q8' },
    { turn: 8, kind: 'assistant_summary', text: 's8' },
    { turn: 9, kind: 'user', text: 'q9' },
    { turn: 9, kind: 'assistant_summary', text: 's9' },
  ])
  assert.equal(items.length, MAX_PRIOR_ITEMS)
})

test('当前回合被排除（提问与总结都不进历史）', () => {
  const items = selectPriorItems({
    prompts: [{ turn: 3, text: 'q3' }, { turn: 4, text: 'q4' }],
    summaries: [{ turn: 3, summary: 's3' }, { turn: 4, summary: 's4' }],
    currentTurn: 4,
  })
  assert.deepEqual(items.map((i) => i.text), ['q3', 's3'])
})

test('缺失的总结不补造：只有用户输入的回合就只贡献一项', () => {
  const items = selectPriorItems({
    prompts: [{ turn: 1, text: 'q1' }, { turn: 2, text: 'q2' }],
    summaries: [{ turn: 2, summary: 's2' }],   // turn 1 没有总结（例如飞书触发回合）
    currentTurn: 3,
  })
  assert.deepEqual(items, [
    { turn: 1, kind: 'user', text: 'q1' },
    { turn: 2, kind: 'user', text: 'q2' },
    { turn: 2, kind: 'assistant_summary', text: 's2' },
  ])
})

test('同一回合出现多条用户消息时合并（保留先后顺序）', () => {
  const items = selectPriorItems({
    prompts: [{ turn: 1, text: '第一条' }, { turn: 1, text: '第二条' }],
    currentTurn: 2,
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].text, '第一条\n第二条')
})

// ── 输入组装 ────────────────────────────────────────────────────────────

test('三段式框架：标签齐全，无历史时写 (none)', () => {
  const { text, priorUsed } = buildFormatterInput({ question: '为什么失败', reply: '因为连接池耗尽' })
  assert.equal(priorUsed, 0)
  assert.ok(text.startsWith(LABEL_PRIOR))
  assert.ok(text.includes(NO_PRIOR_CONTEXT))
  assert.ok(text.includes(LABEL_QUESTION + '\n为什么失败'))
  assert.ok(text.includes(LABEL_REPLY + '\n因为连接池耗尽'))
})

test('历史项按时间序渲染，且带 [turn N][user|assistant_summary] 标签', () => {
  const { text } = buildFormatterInput({
    question: 'q3',
    reply: 'r3',
    priorItems: [
      { turn: 1, kind: 'user', text: 'u1' },
      { turn: 2, kind: 'assistant_summary', text: 's2' },
    ],
  })
  assert.ok(text.includes('[turn 1][user]\nu1'))
  assert.ok(text.includes('[turn 2][assistant_summary]\ns2'))
  assert.ok(text.indexOf('[turn 1]') < text.indexOf('[turn 2]'))
})

test('单条历史项受 768 字节上限约束：只截断，追加省略号，保留开头', () => {
  const long = '中'.repeat(2000)   // 6000 字节
  const { text } = buildFormatterInput({
    question: 'q', reply: 'r',
    priorItems: [{ turn: 1, kind: 'user', text: long }],
  })
  const block = text.split('\n').find((l) => l.startsWith('[turn 1][user]'))
  assert.ok(block, '应有该历史项标签')
  const body = text.slice(text.indexOf(block) + block.length + 1).split('\n')[0]
  assert.ok(bytes(body) <= PRIOR_ITEM_MAX_BYTES, `body=${bytes(body)} 超过 ${PRIOR_ITEM_MAX_BYTES}`)
  assert.ok(body.startsWith('中'))
  assert.ok(body.endsWith('…'))
})

test('全部历史项合计受 3 KiB 上限：超预算时丢最老的', () => {
  const priorItems = [1, 2, 3, 4, 5].map((t) => ({ turn: t, kind: 'user', text: '中'.repeat(400) }))
  const out = buildFormatterInput({ question: 'q', reply: 'r', priorItems })
  assert.ok(out.priorDropped >= 1, '应丢掉最老的历史项')
  assert.ok(out.priorUsed < priorItems.length)
  const priorSection = out.text.slice(out.text.indexOf(LABEL_PRIOR), out.text.indexOf(LABEL_QUESTION))
  assert.ok(bytes(priorSection) <= PRIOR_TOTAL_MAX_BYTES, `prior=${bytes(priorSection)}`)
  assert.ok(!priorSection.includes('[turn 1]'), '最先丢的是最老的 turn 1')
})

test('提问受 3 KiB 上限约束', () => {
  const out = buildFormatterInput({ question: '字'.repeat(5000), reply: 'r' })
  assert.equal(out.questionTruncated, true)
  const q = out.text.split(LABEL_QUESTION + '\n')[1].split('\n')[0]
  assert.ok(bytes(q) <= QUESTION_MAX_BYTES, `question=${bytes(q)}`)
})

test('回复优先：总预算不足时先丢历史、保住提问，回复仍拿到预留额度', () => {
  const priorItems = [1, 2, 3, 4, 5].map((t) => ({ turn: t, kind: 'assistant_summary', text: '中'.repeat(250) }))
  const out = buildFormatterInput({
    question: '问'.repeat(1000),      // 3000 字节，接近提问上限
    reply: '回'.repeat(20000),        // 60000 字节，必然截断
    priorItems,
  })
  assert.ok(bytes(out.text) <= DEFAULT_MAX_INPUT_BYTES, `input=${bytes(out.text)}`)
  assert.equal(out.replyTruncated, true)
  assert.ok(out.priorDropped >= 1, '为了给回复腾空间应先丢历史')
  assert.ok(out.priorUsed < priorItems.length)
  // 永不删掉提问：标签与内容都必须还在
  assert.ok(out.text.includes(LABEL_QUESTION))
  const q = out.text.split(LABEL_QUESTION + '\n')[1].split('\n')[0]
  assert.ok(q.length > 0)
  // 回复段落非空且明显大于预留下限的一半（说明确实分到了大头）
  const r = out.text.split(LABEL_REPLY + '\n')[1]
  assert.ok(bytes(r) > 5 * 1024, `reply=${bytes(r)} 应拿到主要预算`)
})

test('预算充裕时不截断任何一段', () => {
  const out = buildFormatterInput({ question: '问题', reply: '回复', priorItems: [{ turn: 1, kind: 'user', text: 'u1' }] })
  assert.equal(out.questionTruncated, false)
  assert.equal(out.replyTruncated, false)
  assert.equal(out.priorDropped, 0)
  assert.equal(out.priorUsed, 1)
})

// ── 字节级截断 ──────────────────────────────────────────────────────────

test('clipToBytes：UTF-8 安全（不切开多字节字符/代理对），且不超上限', () => {
  const clipped = clipToBytes('中'.repeat(100), 10)
  assert.equal(clipped.truncated, true)
  assert.ok(bytes(clipped.text) <= 10, `bytes=${bytes(clipped.text)}`)
  assert.ok(clipped.text.endsWith('…'))
  assert.ok(!clipped.text.includes('\uFFFD'), '不得产生替换字符')
  const emoji = clipToBytes('😀'.repeat(50), 11)
  assert.ok(bytes(emoji.text) <= 11)
  assert.ok(!emoji.text.includes('\uFFFD'))
})

test('clipToBytes：未超限时原样返回且不标截断', () => {
  const r = clipToBytes('短', 100)
  assert.equal(r.text, '短')
  assert.equal(r.truncated, false)
})
