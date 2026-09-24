#!/usr/bin/env node
/**
 * 卡片渲染探针：用真实凭据 + 真实载荷发一张话题根卡片，供人工确认渲染。
 *
 * 这是新信息架构的「上线门禁」，单测覆盖不到的部分都靠一次真实投递确认：
 * 根卡片的标题/摘要/元信息在飞书客户端里长什么样、响应是否回传 message_id
 * （reply-map 回复路由依赖它）、以及 `--thread` 时首条线程回复是否真的创建了
 * 原生话题（客户端出现「N 条回复 / 话题」入口）。
 *
 * 用法：
 *   node scripts/probe-card.mjs --dry-run            # 只打印将要发送的卡片与体积
 *   node scripts/probe-card.mjs                      # 真发一张根卡片（发到 bot owner）
 *   node scripts/probe-card.mjs --thread             # 再补一条线程回复（完整回复的位置）
 *   node scripts/probe-card.mjs --v2 --thread        # 用 Markdown 能力样本作完整回复
 *   node scripts/probe-card.mjs --corpus x.jsonl --index 3
 *
 * 凭据从 DSH 凭据库读取，绝不打印密钥本体。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { buildNotificationCardV2 } from '../lib/shared/progressive.js'
import { fallbackDigest } from '../lib/shared/notification-digest.js'
import { createFeishuApi } from '../lib/host/feishu-api.js'

const argv = process.argv.slice(2)
const has = (f) => argv.includes('--' + f)
const val = (f, d = null) => {
  const i = argv.indexOf('--' + f)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

const dshHome = val('home', process.env.DSH_HOME || join(homedir(), '.dsh'))
const feishuDir = join(dshHome, 'integrations', 'dsh-feishu')

/**
 * 读取 DSH 凭据库里的 refs 映射。
 * 只解析 `refs:` 下的 `KEY: value` 两空格缩进映射——这是 credentials-local
 * 的当前落盘形态；若形态变了，这里会以明确报错退出，而不是静默拿不到密钥。
 */
function readSecretRefs(path) {
  if (!existsSync(path)) throw new Error('找不到凭据库：' + path)
  const lines = readFileSync(path, 'utf8').split('\n')
  const refs = {}
  let inRefs = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (inRefs) {
      if (/^\S/.test(line) && line.trim()) { inRefs = false; continue }
      const m = line.match(/^\s+([A-Za-z0-9_.\-]+):\s*(.+?)\s*$/)
      if (m) refs[m[1]] = m[2]
    }
  }
  if (Object.keys(refs).length === 0) throw new Error('凭据库里没解析到 refs（格式可能已变）：' + path)
  return refs
}

function pickPayload() {
  const corpus = val('corpus')
  if (corpus) {
    const rows = readFileSync(corpus, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const idx = Number(val('index', -1))
    const row = idx >= 0 ? rows[idx] : rows.reduce((a, b) => (b.text.length > a.text.length ? b : a))
    return { text: row.text, label: `${row.session} turn ${row.turn}` }
  }
  // 无外部语料时用内置样本，保证探针可独立运行。
  // --v2 用「Markdown 能力自检」样本：标题/表格/引用/代码块/列表各一，
  // 一次投递就能看出该客户端到底渲染了哪些语法（2.0 需 ≥7.20）。
  const text = has('v2')
    ? [
        '# 一级标题（仅 2.0 支持）',
        '',
        '正文含 **加粗**、`行内代码` 与 [链接](https://open.feishu.cn)。',
        '',
        '| 语法 | 1.0 | 2.0 |',
        '| --- | --- | --- |',
        '| 标题 | ✗ | ✓ |',
        '| 表格 | ✗ | ✓ |',
        '| 引用 | ✗ | ✓ |',
        '',
        '> 引用块（仅 2.0 支持）',
        '',
        '- 列表项一',
        '- 列表项二',
        '',
        '```json',
        '{"codeBlock": "代码块"}',
        '```',
        '',
        '---',
        '',
        '以上为 Markdown 能力自检。'.repeat(8),
      ].join('\n')
    : [
        '## 交付物',
        '',
        '本轮把出站通知改成渐进披露卡片：',
        '',
        '- 结论行与要点常驻可见',
        '- 正文收进折叠面板，展开不新增消息',
        '- 卡片不可用时回退纯文本，复用同一幂等 uuid',
        '',
        '这是一段用来把折叠面板撑开的正文。'.repeat(12),
      ].join('\n')
  return { text, label: has('v2') ? 'builtin-markdown-capability' : 'builtin-sample' }
}

const { text, label } = pickPayload()
// 探针固定发 2.0 话题根卡片；摘要用确定性兜底（探针不发 LLM 请求）。
// 信息架构（Codex FINAL 修订版）：卡片 = 话题根（标题 + 摘要 + 要点 + turn/cwd），
// 完整回复**不进卡片**，由 `--thread` 的线程回复承接。
const digest = fallbackDigest(text)
const card = buildNotificationCardV2({
  title: digest.title,
  turn: 1,
  summary: digest.summary,
  bullets: digest.bullets,
  cwd: process.cwd(),
})
const bytes = Buffer.byteLength(JSON.stringify(card), 'utf8')
const elements = card.elements ?? card.body?.elements ?? []

console.log(`载荷来源：${label}（${text.length} 字）`)
console.log('卡片结构：JSON 2.0（需客户端 ≥7.20）')
console.log(`标题（主题）：${digest.title}`)
console.log(`摘要：${digest.summary}`)
console.log(`要点 ${digest.bullets.length} 条｜元信息仅 turn/cwd｜卡片不含完整回复`)
console.log(`卡片 JSON：${bytes} 字节（安全线 24576，硬上限 30720）`)
console.log(`元素：${elements.map((e) => e.tag).join(', ')}`)

if (has('dry-run')) {
  console.log('\n--dry-run：未发送')
  process.exit(0)
}

const bots = JSON.parse(readFileSync(join(feishuDir, 'config.json'), 'utf8')).bots ?? []
const bot = bots.find((b) => !b.deletionPending)
if (!bot) throw new Error('没有可用 bot：' + feishuDir)
const refs = readSecretRefs(join(dshHome, '.credentials.yaml'))
const secret = refs[bot.secretRef]
if (!secret) throw new Error(`凭据库里没有 ${bot.secretRef}`)

// 目的地：--to 显式指定 > 入站学到的 lastChatId > ownerOpenIds。
// 为什么优先 chat_id：实测同一应用以 open_id 主动发送会被拒
// （230101 "Sending messages to users is temporarily unavailable."）。
let target = val('to', null)
let receiveType = target ? 'open_id' : null
if (!target) {
  let learned = null
  try {
    learned = JSON.parse(readFileSync(join(feishuDir, 'bots', bot.id, 'state.json'), 'utf8')).lastChatId
  } catch { learned = null }
  if (learned) { target = learned; receiveType = 'chat_id' } else if (bot.ownerOpenIds?.[0]) {
    target = bot.ownerOpenIds[0]; receiveType = 'open_id'
  }
}
if (!target) throw new Error('bot 没有可用接收目标，请用 --to 指定')

const api = createFeishuApi()
const out = {}
try {
  const messageId = await api.sendCardMessage(
    { appId: bot.appId, appSecret: secret, receiveId: target, receiveType },
    card,
    { out },
  )
  console.log(`\n已发送 ✅ message_id=${messageId || '(空)'}（${receiveType}）`)
  if (!messageId) {
    console.log('⚠️ 未回传 message_id：reply-map 的回复路由会退化，需要处理')
    process.exit(1)
  }
  if (has('thread')) {
    const out2 = {}
    const replyId = await api.replyToMessage(
      { appId: bot.appId, appSecret: secret, messageId },
      text,
      { replyInThread: true, out: out2 },
    )
    console.log(`线程回复 ✅ message_id=${replyId || '(空)'} thread_id=${out2.threadId ?? '-'}`)
    console.log('请到飞书客户端确认：根卡片出现「N 条回复 / 话题」入口，点进去能看到完整回复（含 Markdown 渲染）。')
  }
} catch (err) {
  console.log(`\n发送失败 ❌ feishuCode=${err?.feishuCode ?? '-'} httpStatus=${err?.httpStatus ?? '-'}`)
  console.log(String(err?.message ?? err).slice(0, 400))
  process.exit(1)
}
