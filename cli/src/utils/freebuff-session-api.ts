import { env } from '@codebuff/common/env'
import {
  FREEBUFF_COMPACT_SESSION_HEADER,
  FREEBUFF_INSTANCE_HEADER,
  FREEBUFF_MODEL_HEADER,
} from '@codebuff/common/constants/freebuff-models'

import type { FreebuffSessionResponse } from '../types/freebuff-session'
import type { FreebuffSessionServerResponse } from '@codebuff/common/types/freebuff-session'

const SESSION_FETCH_TIMEOUT_MS = 20_000
export type FreebuffSessionMethod = 'POST' | 'GET' | 'DELETE'

export class FreebuffSessionRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryAfterMs?: number,
    readonly errorCode?: string,
  ) {
    super(message)
    this.name = 'FreebuffSessionRequestError'
  }
}

export function isFreebuffSessionTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || /timeout|timed out/i.test(error.message))
  )
}

export type FreebuffSessionFailureDisposition = 'retry' | 'stop' | 'unknown'

/** How the poll loop should handle a failed request.
 *
 * A POST without a response may already have rotated the active instance, so
 * repeating it is unsafe without protocol-level idempotency. HTTP 408, 429,
 * and 503 responses are the exception: edge rejection or admission shedding
 * produces them before the session mutation can commit. GET is read-only and
 * can retry transient failures normally. */
export function classifyFreebuffSessionRequestFailure(
  method: Extract<FreebuffSessionMethod, 'POST' | 'GET'>,
  error: unknown,
): FreebuffSessionFailureDisposition {
  if (method === 'POST') {
    if (!(error instanceof FreebuffSessionRequestError)) return 'unknown'
    // These responses are produced before the session mutation can commit:
    // 408/429 come from an edge or unparsed response (the endpoint's typed
    // rate-limit responses are returned above), and a 503 means no handler was
    // available or admission shed the request. Retrying them cannot repeat a
    // successful takeover.
    if ([408, 429, 503].includes(error.statusCode)) {
      return 'retry'
    }
    return error.statusCode >= 400 && error.statusCode < 500
      ? 'stop'
      : 'unknown'
  }

  if (!(error instanceof FreebuffSessionRequestError)) return 'retry'
  return error.statusCode === 408 ||
    error.statusCode === 429 ||
    error.statusCode >= 500
    ? 'retry'
    : 'stop'
}

export function parseRetryAfterMs(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    const milliseconds = seconds * 1_000
    return Number.isFinite(milliseconds) ? Math.ceil(milliseconds) : undefined
  }
  const dateMs = Date.parse(value)
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined
}

/** Combine the caller's abort signal with a per-request timeout. */
export function sessionFetchSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number = SESSION_FETCH_TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function sessionEndpoint(): string {
  const base = (
    env.NEXT_PUBLIC_CODEBUFF_APP_URL || 'https://codebuff.com'
  ).replace(/\/$/, '')
  return `${base}/api/v1/freebuff/session`
}

export async function callFreebuffSession(
  method: FreebuffSessionMethod,
  token: string,
  opts: {
    instanceId?: string
    model?: string
    signal?: AbortSignal
    compact?: boolean
  } = {},
): Promise<FreebuffSessionServerResponse> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if ((method === 'GET' || method === 'DELETE') && opts.instanceId) {
    headers[FREEBUFF_INSTANCE_HEADER] = opts.instanceId
  }
  if (method === 'GET' && opts.compact) {
    headers[FREEBUFF_COMPACT_SESSION_HEADER] = '1'
  }
  if (method === 'POST' && opts.model) {
    headers[FREEBUFF_MODEL_HEADER] = opts.model
  }

  const response = await fetch(sessionEndpoint(), {
    method,
    headers,
    signal: sessionFetchSignal(opts.signal),
  })

  if (response.status === 404) {
    return { status: 'none' }
  }

  if (response.status === 403) {
    const body = (await response
      .json()
      .catch(() => null)) as FreebuffSessionServerResponse | null
    if (
      body &&
      (body.status === 'country_blocked' || body.status === 'banned')
    ) {
      return body
    }
  }

  if (response.status === 409 && method === 'POST') {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as FreebuffSessionServerResponse | null
    if (
      body &&
      (body.status === 'model_locked' || body.status === 'model_unavailable')
    ) {
      return body
    }
  }

  if (response.status === 429 && method === 'POST') {
    const body = (await response
      .json()
      .catch(() => null)) as FreebuffSessionServerResponse | null
    if (
      body &&
      (body.status === 'rate_limited' ||
        body.status === 'spend_limited' ||
        body.status === 'ip_capped')
    ) {
      return body
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let errorCode: string | undefined
    try {
      const body = JSON.parse(text) as { error?: unknown }
      if (typeof body.error === 'string') errorCode = body.error
    } catch {
      // Non-JSON errors have no machine-readable code.
    }
    throw new FreebuffSessionRequestError(
      `freebuff session ${method} failed: ${response.status} ${text.slice(0, 200)}`,
      response.status,
      parseRetryAfterMs(response.headers.get('retry-after')),
      errorCode,
    )
  }

  return (await response.json()) as FreebuffSessionServerResponse
}

/** A compact poll omits quota fields that were already returned by admission.
 * Keep that snapshot only for the same active session; null tells the poller
 * to fetch one full response before compacting again. */
export function mergeCompactActiveSession(
  current: FreebuffSessionResponse | null,
  next: FreebuffSessionServerResponse,
): FreebuffSessionServerResponse | null {
  if (
    current?.status !== 'active' ||
    next.status !== 'active' ||
    current.instanceId !== next.instanceId ||
    current.model !== next.model
  ) {
    return null
  }
  return {
    ...next,
    rateLimit: next.rateLimit ?? current.rateLimit,
    rateLimitsByModel: next.rateLimitsByModel ?? current.rateLimitsByModel,
    // Compact polls omit the subscription block along with the rate limits;
    // dropping it here would blank the plan panel until the next full poll.
    subscription: next.subscription ?? current.subscription,
    // Same carry, and it matters MORE here: the Freebucks header is the whole
    // meter for a metered account, so losing it mid-session would drop the
    // picker back to session rings that no longer gate anything. The balance
    // cannot change during a session anyway — a session is charged once, at
    // admission — so the carried block is not merely a placeholder, it is
    // still correct.
    freebucks: next.freebucks ?? current.freebucks,
  }
}

export function holdsLiveFreebuffSlot(
  current: FreebuffSessionResponse | null,
): boolean {
  if (!current) return false
  return (
    current.status === 'active' ||
    (current.status === 'ended' && Boolean(current.instanceId))
  )
}
