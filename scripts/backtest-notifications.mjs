#!/usr/bin/env node
/**
 * 通知链路的离线回测台。
 *
 * 为什么存在：摘要逻辑很容易在几条样本上调出一堆正则、伪造「可靠」的假象。
 * 这个脚本把 DSH 真实会话记录变成语料，把「不许改写原文」变成可机器检查的事实。
 *
 * 第三批重构后，这里审计的对象变了：
 *   - 语义已交给发送层 LLM（notification-formatter.js），确定性一侧只剩**逐字引用兜底**
 *     （notification-digest.js 的 fallbackDigest）。
 *   - 因此审计判据就是 `isQuoteOf`：兜底文本必须是原文的子序列（只删不改、只截不造）。
 *     以前这里手写过一份 normalize + 子序列检查，现已收敛进模块本身，脚本不再重复实现。
 *   - 另外检查卡片 2.0 的字节预算不变量（卡片硬上限 30KB，安全线 24KB）。
 *
 * 用法：
 *   # 1) 从本机真实会话建语料（需要 zstd CLI）
 *   node scripts/backtest-notifications.mjs --build --cap 6000
 *
 *   # 2) 不变量审计 + 分布（默认读 .backtest/corpus.jsonl）
 *   node scripts/backtest-notifications.mjs
 *   node scripts/backtest-notifications.mjs --samples 15
 *
 *   # 3) 确定性兜底 vs LLM 并排对比（LLM 侧需要可达的 OpenAI 兼容端点）
 *   node scripts/backtest-notifications.mjs --compare --limit 20 \
 *        --llm-base-url http://127.0.0.1:PORT/v1 --llm-model <id> [--llm-key-env VAR]
 *
 * 语料是私有会话内容，默认落在 .backtest/（已 gitignore），不进仓库。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'

import { buildNotificationCardV2, cardFitsBudget } from '../lib/shared/progressive.js'
import {
  fallbackDigest,
  isQuoteOf,
  parseDigestJson,
  summarizeForLlm,
  validateDigest,
} from '../lib/shared/notification-digest.js'
import { SYSTEM_PROMPT } from '../lib/host/notification-formatter.js'

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

function loadRows() {
  const corpusPath = String(arg('corpus', DEFAULT_CORPUS))
  if (!existsSync(corpusPath)) {
    console.error(`没有语料：${corpusPath}\n先跑：node scripts/backtest-notifications.mjs --build`)
    process.exit(2)
  }
  return readFileSync(corpusPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// ── 不变量审计：兜底摘要必须是原文的子序列（只删不改、只截不造）──────────
// 判据由模块提供（notification-digest.js 的 isQuoteOf）：去空白、去末尾截断标记后，
// 逐码点确认是原文的子序列。这样「不许改写原文」是可机器检查的事实而非承诺。
function audit(rows) {
  const violations = []
  for (const r of rows) {
    const d = fallbackDigest(r.text)
    const bad = []
    if (!isQuoteOf(d.summary, r.text)) bad.push('summary')
    for (const b of d.bullets) if (!isQuoteOf(b, r.text)) bad.push('bullet')
    if (bad.length) violations.push({ session: r.session, turn: r.turn, bad, summary: d.summary })
  }
  return violations
}

// ── 回测：兜底侧分布 + 卡片预算不变量 ───────────────────────────────────
function backtest() {
  const rows = loadRows()
  const N = rows.length
  const pct = (n) => ((n / N) * 100).toFixed(1) + '%'

  let folded = 0, withBullets = 0, emptySummary = 0, overBudget = 0, totalBytes = 0
  const summaryLens = []
  for (const r of rows) {
    const d = fallbackDigest(r.text)
    if (r.text.length > 400) folded++
    if (d.bullets.length) withBullets++
    if (!d.summary) emptySummary++
    summaryLens.push(d.summary.length)
    const card = buildNotificationCardV2({
      title: 'dsh 回复总结', turn: r.turn, summary: d.summary, bullets: d.bullets, detail: r.text,
    })
    const bytes = Buffer.byteLength(JSON.stringify(card), 'utf8')
    totalBytes += bytes
    if (!cardFitsBudget(card)) overBudget++
  }
  summaryLens.sort((a, b) => a - b)
  const q = (p) => summaryLens[Math.min(summaryLens.length - 1, Math.floor(summaryLens.length * p))]

  console.log(`语料：${N} 条载荷，来自 ${new Set(rows.map((r) => r.session)).size} 个会话`)
  console.log(`兜底摘要长度：p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)} max=${summaryLens[summaryLens.length - 1]}`)
  console.log(`折叠(>400 字) ${pct(folded)}｜含要点 ${pct(withBullets)}｜摘要为空 ${pct(emptySummary)}`)
  console.log(`卡片 2.0 平均 ${(totalBytes / N / 1024).toFixed(1)}KB｜超 24KB 安全线 ${overBudget} 条`)
  console.log()

  const violations = audit(rows)
  console.log(`不变量审计（兜底摘要/要点必须是原文子序列）：${violations.length === 0 ? '通过 ✅' : `失败 ❌ ${violations.length} 条`}`)
  for (const v of violations.slice(0, 10)) console.log(`   ${v.session} turn ${v.turn} [${v.bad.join(',')}]: ${v.summary}`)

  const samples = Number(arg('samples', 0))
  if (samples > 0) {
    console.log()
    const step = Math.max(1, Math.floor(N / samples))
    console.log(`== 兜底摘要抽样（每 ${step} 条取一条）==`)
    for (let i = 0, shown = 0; i < N && shown < samples; i += step, shown++) {
      console.log(`  ${fallbackDigest(rows[i].text).summary.slice(0, 72)}`)
    }
  }
}

// ── 对比：确定性兜底 vs LLM ─────────────────────────────────────────────
// 为什么需要：LLM formatter 相对兜底到底有没有变好，只能并排看，不能靠断言。
// LLM 侧需要一个可达的 OpenAI 兼容端点。注意 DSH 的默认路由（raven-cc）由 raven
// 插件在本机桥接，不是独立 HTTP 端点，所以本脚本无法直接调用它——端点不可达时
// 如实说明，只输出确定性侧，绝不伪造 LLM 输出。
async function compare() {
  const rows = loadRows()
  const limit = Number(arg('limit', 20))
  const step = Math.max(1, Math.floor(rows.length / limit))
  const sample = rows.filter((_, i) => i % step === 0).slice(0, limit)
  const baseUrl = String(arg('llm-base-url', process.env.DSH_LLM_BASE_URL ?? '')).replace(/\/+$/, '')
  const model = String(arg('llm-model', process.env.DSH_LLM_MODEL ?? ''))
  const keyEnv = String(arg('llm-key-env', 'DSH_LLM_KEY'))
  const key = String(process.env[keyEnv] ?? '')

  let live = false
  let why = '未提供 --llm-base-url / --llm-model'
  if (baseUrl && model) {
    try {
      const res = await fetch(baseUrl + '/models', { headers: key ? { authorization: 'Bearer ' + key } : {} })
      live = res.ok
      if (!res.ok) why = `端点 /models 返回 HTTP ${res.status}`
    } catch (err) {
      why = `端点不可达：${String(err?.message ?? err)}`
    }
  }

  console.log(`== 对比：确定性兜底 vs LLM（样本 ${sample.length} / ${rows.length} 条）==`)
  if (!live) {
    console.log(`⚠️  LLM 侧未运行：${why}`)
    console.log('    启用：--compare --llm-base-url <openai 兼容 /v1> --llm-model <id> [--llm-key-env VAR]')
    console.log('    DSH 默认路由 raven-cc 由 raven 插件桥接，不是独立 HTTP 端点，本脚本调不到；')
    console.log('    LLM 侧的真实效果请直接看飞书通知（live 跑上第二批后）。')
    console.log()
  }

  let valid = 0, invalid = 0
  const lats = []
  for (const r of sample) {
    const det = fallbackDigest(r.text)
    let llmLine = '（LLM 侧未运行）'
    if (live) {
      const t0 = Date.now()
      try {
        const res = await fetch(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: summarizeForLlm(r.text) },
            ],
            max_tokens: 400,
            temperature: 0,
          }),
        })
        const json = await res.json()
        const raw = json?.choices?.[0]?.message?.content ?? ''
        const parsed = parseDigestJson(raw)
        const verdict = parsed ? validateDigest(parsed, r.text) : { ok: false, reason: 'unparsable-output' }
        lats.push(Date.now() - t0)
        if (verdict.ok) { valid++; llmLine = verdict.digest.summary }
        else { invalid++; llmLine = `✗ ${verdict.reason} → 回退兜底` }
      } catch (err) {
        invalid++
        llmLine = `✗ ${String(err?.message ?? err)} → 回退兜底`
      }
    }
    console.log(`\n--- ${String(r.session).slice(-12)} turn ${r.turn}（${r.text.length} 字）`)
    console.log(`  兜底: ${det.summary}`)
    console.log(`  LLM : ${llmLine}`)
  }

  if (live) {
    lats.sort((a, b) => a - b)
    const q = (p) => lats[Math.min(lats.length - 1, Math.floor(lats.length * p))] ?? 0
    console.log(`\nLLM 通过契约校验 ${valid}/${sample.length}｜被判违规并回退 ${invalid}`)
    console.log(`LLM 延迟 p50=${q(0.5)}ms p90=${q(0.9)}ms（formatter 硬 deadline 1500ms）`)
  }
}

if (arg('build')) build()
else if (arg('compare')) await compare()
else backtest()
