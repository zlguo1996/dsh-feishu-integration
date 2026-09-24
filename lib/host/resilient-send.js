/**
 * 有界重试发送器：指数退避 + 可达性门控（ping）。
 *
 * 策略：
 * - 最多 maxAttempts 次真实发送尝试（默认 10）；
 * - 相邻尝试间隔 min(base*2^(n-1), cap)，±20% 抖动（默认 1s→30s）；
 * - 重试等待期间轮询 isReachable()：网络不可达时顺延等待（不消耗尝试次数），
 *   直到恢复或总截止时间（默认 10 分钟）到——避免对着断网空烧重试；
 * - 最终失败返回 {ok:false,error}，由调用方决定落盘/告警。
 */

import { lookup as dnsLookup } from 'node:dns'
import { setTimeout as delay } from 'node:timers/promises'

/** 第 n 次重试前的退避间隔（ms），带 ±20% 抖动，封顶 maxDelayMs。 */
export function computeBackoffMs(attempt, baseDelayMs = 1000, maxDelayMs = 30000) {
  const raw = Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs)
  const jitter = raw * 0.2
  return Math.round(raw - jitter + Math.random() * jitter * 2)
}

const DEFAULT_REACHABLE_HOST = 'open.feishu.cn'

/**
 * 默认可达性探测：DNS 能否解析飞书域名。
 *
 * ⚠️ `dns.lookup` 是**回调式** API，不返回 Promise（`timeout` 选项也只对
 * `dns.Resolver` 的 resolve* 系列有效）。这里曾经写成
 * `dnsLookup(host, {timeout:2000}).then(...)`：回调缺失，Node 直接抛
 * `ERR_INVALID_ARG_TYPE: The "callback" argument must be of type function`。
 * 更糟的是它抛在**重试路径**上（`backoffAndWait` → `isReachable`），于是
 * 「一次瞬时发送失败 + 一次可达性探测」= 整条投递链路中断；而调用方（出站总结）
 * 的 catch 走的是不落盘的 ctx 日志，磁盘上只留下「根消息在、线程不在」这种
 * 无从判断的现象（2026-09-24 验证实例实测）。
 *
 * 现在改为回调式 + 自带超时兜底：任何情况下都 resolve 成 boolean，绝不抛错。
 */
export function defaultIsReachable(host = DEFAULT_REACHABLE_HOST, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      dnsLookup(host, (err) => { clearTimeout(timer); finish(!err) })
    } catch {
      clearTimeout(timer)
      finish(false)
    }
  })
}

/**
 * @param opts.log            logger(kind, ...args)
 * @param opts.isReachable    () => Promise<boolean>（测试可注入）
 * @param opts.sleep          ms => Promise（测试可注入）
 * @param opts.maxAttempts    真实发送尝试上限，默认 10
 * @param opts.baseDelayMs/maxDelayMs/jitter 退避参数
 * @param opts.probeEveryMs   不可达时的探测间隔
 * @param opts.totalDeadlineMs 总截止时间，超时后即使不可达也做最后一次尝试
 */
export function createResilientSender({
  log,
  isReachable = defaultIsReachable,
  sleep = delay,
  maxAttempts = 10,
  baseDelayMs = 1000,
  maxDelayMs = 30000,
  probeEveryMs = 2000,
  totalDeadlineMs = 10 * 60_000,
} = {}) {
  /** 睡满退避窗口；醒来仍不可达则按探测周期顺延，直到恢复或逼近总截止。 */
  async function backoffAndWait(backoffMs, startedAt) {
    await sleep(backoffMs)
    let reachable = await isReachable()
    while (!reachable && Date.now() - startedAt < totalDeadlineMs - probeEveryMs) {
      await sleep(probeEveryMs)
      reachable = await isReachable()
    }
    return reachable
  }

  /**
   * 执行 fn()（抛错视为失败）。返回 {ok:true,value} 或 {ok:false,error}。
   * 注意：若单次请求「实际已送达但响应丢失」，服务端幂等键（uuid）负责去重，
   * 本层不做响应级判别。
   */
  async function sendWithRetry(fn, label = 'send') {
    const startedAt = Date.now()
    let lastError = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const value = await fn()
        if (attempt > 1) log?.('info', `[重试] ${label} 第 ${attempt} 次尝试成功`)
        return { ok: true, value }
      } catch (err) {
        lastError = err
        if (attempt >= maxAttempts) break
        if (Date.now() - startedAt >= totalDeadlineMs) {
          log?.('warn', `[重试] ${label} 达到总截止时间，停止重试`)
          break
        }
        const backoff = computeBackoffMs(attempt, baseDelayMs, maxDelayMs)
        log?.('warn', `[重试] ${label} 第 ${attempt} 次失败，${Math.round(backoff / 1000)}s 后重试:`, String(err?.message ?? err))
        // 先睡满退避；醒来若网络仍不可达则顺延等待（不消耗尝试次数）
        await backoffAndWait(backoff, startedAt)
      }
    }
    return { ok: false, error: lastError }
  }

  return { sendWithRetry }
}
