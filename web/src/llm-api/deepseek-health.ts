import { deepseekModels } from '@codebuff/common/constants/model-config'

import { logger } from '@/util/logger'

/**
 * Passive circuit breaker for the official DeepSeek API.
 *
 * Tracks transient failures observed from real user requests in a rolling
 * window. When the threshold is exceeded, the circuit opens for a cooldown,
 * and supported models (currently `deepseek-v4-flash`) are routed to Fireworks
 * instead. No background polling — every request acts as the probe. After the
 * cooldown elapses, the next request retries DeepSeek directly; if it
 * succeeds the circuit resets, otherwise it re-opens.
 *
 * State lives in-process. Each server instance maintains its own view, which
 * is fine: failures are correlated across pods, so all instances converge to
 * the same state within a few seconds.
 */

const FAILURE_THRESHOLD = 3
const FAILURE_WINDOW_MS = 60_000
const OPEN_DURATION_MS = 5 * 60_000

let recentFailures: number[] = []
let openUntil = 0

function isDeepSeekV4FlashModel(model: string): boolean {
  return (
    model === deepseekModels.deepseekV4Flash ||
    model === deepseekModels.deepseekV4FlashDirect
  )
}

export function recordDeepSeekFailure(context?: {
  model?: string
  reason?: string
  statusCode?: number
}): void {
  const now = Date.now()
  recentFailures = recentFailures.filter((ts) => now - ts < FAILURE_WINDOW_MS)
  recentFailures.push(now)
  const wasOpen = now < openUntil
  if (recentFailures.length >= FAILURE_THRESHOLD) {
    openUntil = now + OPEN_DURATION_MS
    if (!wasOpen) {
      logger.warn(
        {
          failureCount: recentFailures.length,
          openUntilIso: new Date(openUntil).toISOString(),
          ...context,
        },
        'DeepSeek circuit opened — routing deepseek-v4-flash to Fireworks',
      )
    }
  }
}

export function recordDeepSeekSuccess(): void {
  if (openUntil !== 0 || recentFailures.length > 0) {
    logger.info(
      { previousFailureCount: recentFailures.length },
      'DeepSeek circuit reset after successful request',
    )
  }
  recentFailures = []
  openUntil = 0
}

export function isDeepSeekCircuitOpen(): boolean {
  return Date.now() < openUntil
}

/** Returns true if this request should bypass DeepSeek and use the Fireworks
 *  fallback. Only `deepseek-v4-flash` has a Fireworks alternative today. */
export function shouldBypassDeepSeek(model: string): boolean {
  if (!isDeepSeekV4FlashModel(model)) return false
  return isDeepSeekCircuitOpen()
}

/** Classify whether an error/status reflects a likely DeepSeek-side outage
 *  (network/timeout/5xx) vs. a request-specific 4xx. We only count outages
 *  toward circuit-opening. */
export function isLikelyDeepSeekOutage(
  error: unknown,
  statusCode?: number,
): boolean {
  if (typeof statusCode === 'number') {
    return statusCode >= 500 || statusCode === 408 || statusCode === 429
  }
  if (error instanceof Error) {
    const code = (error as { code?: string }).code
    if (
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_SOCKET' ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'ETIMEDOUT' ||
      code === 'EAI_AGAIN'
    ) {
      return true
    }
    if (
      error.name === 'AbortError' ||
      error.name === 'HeadersTimeoutError' ||
      error.name === 'TimeoutError'
    ) {
      return true
    }
    const msg = error.message?.toLowerCase() ?? ''
    return (
      msg.includes('headers timeout') ||
      msg.includes('fetch failed') ||
      msg.includes('socket hang up') ||
      msg.includes('connect timeout') ||
      msg.includes('network') ||
      msg.includes('econnreset') ||
      msg.includes('aborted')
    )
  }
  return false
}

export function getDeepSeekCircuitState(): {
  circuitOpen: boolean
  openUntil: number
  recentFailureCount: number
} {
  const now = Date.now()
  return {
    circuitOpen: now < openUntil,
    openUntil,
    recentFailureCount: recentFailures.filter(
      (ts) => now - ts < FAILURE_WINDOW_MS,
    ).length,
  }
}

export function __resetDeepSeekCircuitForTests(): void {
  recentFailures = []
  openUntil = 0
}

export const DEEPSEEK_CIRCUIT_CONFIG = {
  FAILURE_THRESHOLD,
  FAILURE_WINDOW_MS,
  OPEN_DURATION_MS,
} as const
