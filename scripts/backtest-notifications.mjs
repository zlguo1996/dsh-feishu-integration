#!/usr/bin/env node
/**
 * 通知抽取的离线回测台。
 *
 * 为什么存在：抽取逻辑很容易在几条样本上调出一堆正则、伪造「可靠」的假象。
 * 这个脚本把 DSH 真实会话记录变成语料，量化覆盖率与每条规则的实际效果，
 * 从而让「加规则」和「删规则」都由数字决定，而不是由印象决定。
 *
 * 用法：
 *   # 1) 从本机真实会话建语料（需要 zstd CLI）
 *   node scripts/backtest-notifications.mjs --build --cap 6000
 *
 *   # 2) 回测（默认读 .backtest/corpus.jsonl）
 *   node scripts/backtest-notifications.mjs
 *   node scripts/backtest-notifications.mjs --samples 15
 *
 * 语料是私有会话内容，默认落在 .backtest/（已 gitignore），不进仓库。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'

import { describeReply, parseBlocks, stripInline, HEADER_COMPOSE_BELOW } from '../lib/shared/progressive.js'

const DEFAULT_CORPUS = '.backtest/corpus.jsonl'
const PROMPT_RPC_PREFIX = 'fsum-'

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

// ── 语料构建：复刻插件的出站判定 ─────────────────────────────────────────
// 只取 turn/end(completed)、非飞书触发（rpcId 前缀 fsum-）、该回合最后一条
// assistant/message 的 text 块拼接、非空。这和 summary-service 推送到飞书的
// 载荷一致，所以回测的是真实输入分布。
function payloadsFrom(file) {
  const res = spawnSync('zstd', ['-dc', file], { maxBuffer: 1024 * 1024 * 512 })
  if (res.status !== 0 || !res.stdout) return []
  const out = []
  let openTurn = null
  const feishuTurns = new Set()
  const lastText = new Map()
  for (const raw of res.stdout.toString('utf8').split('\n')) {
    if (!raw.trim()) continue
    let e
    try { e = JSON.parse(raw) } catch { continue }
    const d = e.data ?? {}
    if (e.type === 'turn/start') openTurn = d.turn
    else if (e.type === 'user/message') {
      const rpc = d.source?.rpcId
      if (typeof rpc === 'string' && rpc.startsWith(PROMPT_RPC_PREFIX) && openTurn != null) feishuTurns.add(openTurn)
    } else if (e.type === 'assistant/message') {
      const txt = (d.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (txt) lastText.set(d.turn, txt)
    } else if (e.type === 'turn/end') {
      if ((d.reason?.kind) !== 'completed' || feishuTurns.has(d.turn)) continue
      const txt = lastText.get(d.turn)
      if (txt) out.push({ session: basename(dirname(file)), turn: d.turn, text: txt })
    }
  }
  return out
}

function build() {
  const dshHome = String(arg('home', process.env.DSH_HOME || join(homedir(), '.dsh')))
  const cap = Number(arg('cap', 6000))
  const outPath = dirname(String(arg('corpus', DEFAULT_CORPUS))) === '.' ? DEFAULT_CORPUS : String(arg('corpus'))
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) {
    console.error('找不到会话目录：' + root)
    process.exit(2)
  }
  const files = []
  for (const ws of readdirSync(root)) {
    const wsDir = join(root, ws)
    if (!statSync(wsDir).isDirectory()) continue
    for (const sid of readdirSync(wsDir)) {
      const sDir = join(wsDir, sid)
      if (!statSync(sDir).isDirectory()) continue
      for (const f of readdirSync(sDir)) {
        if (/^session.*\.jsonl\.zstd$/.test(f)) files.push(join(sDir, f))
      }
    }
  }
  const rows = []
  for (const f of files) {
    for (const p of payloadsFrom(f)) {
      rows.push(p)
      if (rows.length >= cap) break
    }
    if (rows.length >= cap) break
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  console.log(`会话文件 ${files.length} 个 → 载荷 ${rows.length} 条 → ${outPath}`)
}

// ── 不变量审计：头部不得包含原文里没有的内容字符 ─────────────────────────
// 把「绝不改写正文」变成可机器检查的事实，而不是一句承诺。
// 允许的差异只有这四种（都属于排版/截断，不属于改写）：
//   a. 删除 Markdown 装饰符号（#、**、`、链接语法）——纯删除
//   b. 段落的软换行折叠为空白（Markdown 语义：软换行属于同一段）
//   c. 超长时末尾截断并追加 '…'
//   d. 组合规则在标题与后文首句之间插入一个全角冒号
// 因此审计方式：先去掉末尾截断标记、把所有空白归一化，再要求头部的每个
// 内容字符都能在原文里按顺序找到（子序列）。组合头部按分隔符拆成两段分别检。
function normalize(s) { return String(s ?? '').replace(/\s+/g, '') }
function stripClip(s) { return s.endsWith('…') ? s.slice(0, -1) : s }
// 注意：needle 也要按码点遍历。用 needle[i] 取的是 UTF-16 码元，
// 与 for..of 得到的码点永远不相等，emoji 会被误判成「原文里没有的字符」。
function isSubsequence(needle, haystack) {
  const chars = [...needle]
  let i = 0
  for (const ch of haystack) {
    if (ch === chars[i]) i++
    if (i >= chars.length) return true
  }
  return i >= chars.length
}

function checkHeaderInvariant(layers, source) {
  const hay = normalize(source)
  // 组合头部由实现逐段回传（base / tail），审计不去猜拼接点——猜错过一次：
  // 标题本身含全角冒号时（如「一、权限：结论要推翻」），按首个冒号切会切错。
  const parts = layers.headerSource === 'composed'
    ? [layers.headerBase, layers.headerTail]
    : [layers.header]
  return parts.every((part) => {
    const probe = normalize(stripClip(part))
    return probe === '' || isSubsequence(probe, hay)
  })
}

function audit(rows) {
  const violations = []
  for (const r of rows) {
    const l = describeReply(r.text)
    if (!checkHeaderInvariant(l, r.text)) {
      violations.push({ session: r.session, turn: r.turn, header: l.header })
    }
  }
  return violations
}

// ── 回测 ────────────────────────────────────────────────────────────────
function backtest() {
  const corpusPath = String(arg('corpus', DEFAULT_CORPUS))
  if (!existsSync(corpusPath)) {
    console.error(`没有语料：${corpusPath}\n先跑：node scripts/backtest-notifications.mjs --build`)
    process.exit(2)
  }
  const rows = readFileSync(corpusPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const N = rows.length
  const pct = (n) => ((n / N) * 100).toFixed(1) + '%'

  const src = { heading: 0, composed: 0, paragraph: 0, none: 0 }
  let folded = 0, truncated = 0, withBullets = 0, shortHeader = 0
  const headerLens = []
  const longs = []
  for (const r of rows) {
    const l = describeReply(r.text)
    src[l.headerSource] = (src[l.headerSource] ?? 0) + 1
    if (l.folded) folded++
    if (l.truncated) truncated++
    if (l.bullets.length) withBullets++
    if (l.header.length <= 8) shortHeader++
    headerLens.push(l.header.length)
    if (l.detailChars > 6000) longs.push(l.detailChars)
  }
  headerLens.sort((a, b) => a - b)
  const q = (p) => headerLens[Math.min(headerLens.length - 1, Math.floor(headerLens.length * p))]

  console.log(`语料：${N} 条载荷，来自 ${new Set(rows.map((r) => r.session)).size} 个会话`)
  console.log(`头部来源：标题原文 ${pct(src.heading)}｜短标题补句 ${pct(src.composed)}｜首段首句 ${pct(src.paragraph)}｜无 ${pct(src.none)}`)
  console.log(`头部长度：p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)} max=${headerLens[headerLens.length - 1]}｜≤8 字 ${pct(shortHeader)}`)
  console.log(`折叠(>400 字) ${pct(folded)}｜超 6000 字被截断 ${pct(truncated)}${longs.length ? `（${longs.length} 条）` : ''}｜含要点 ${pct(withBullets)}`)
  console.log(`组合阈值 HEADER_COMPOSE_BELOW=${HEADER_COMPOSE_BELOW}`)
  console.log()

  const violations = audit(rows)
  console.log(`不变量审计（头部不得含原文没有的字符）：${violations.length === 0 ? '通过 ✅' : `失败 ❌ ${violations.length} 条`}`)
  for (const v of violations.slice(0, 10)) console.log(`   ${v.session} turn ${v.turn}: ${v.header}`)

  const samples = Number(arg('samples', 0))
  if (samples > 0) {
    console.log()
    console.log(`== 头部抽样（每 ${Math.floor(N / samples)} 条取一条）==`)
    for (let i = 0, shown = 0; i < N && shown < samples; i += Math.max(1, Math.floor(N / samples)), shown++) {
      const l = describeReply(rows[i].text)
      console.log(`  [${l.headerSource}] ${l.header.slice(0, 72)}`)
    }
  }
}

if (arg('build')) build()
else backtest()
