import { FIRST_TAB_DISCOUNT_HEADER } from '@codebuff/common/util/freebuff-first-tab-discount'
import type { FreebuffWalletSpendLimit } from '@codebuff/common/types/freebuff-session'
import { freebucksTimeZoneHeaders } from '@codebuff/common/util/freebucks-timezone'
import { env } from '@codebuff/common/env'
import {
  FREEBUFF_COMPACT_SESSION_HEADER,
  FREEBUFF_INSTANCE_HEADER,
  FREEBUFF_MODEL_HEADER,
  FREEBUFF_WALLET_SPEND_LIMIT_HEADER,
  FREEBUFF_SESSION_ADMISSION_PATH,
  FREEBUFF_SESSION_UNSUPPORTED_MESSAGE,
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

function sessionBaseUrl(): string {
  return (env.NEXT_PUBLIC_CODEBUFF_APP_URL || 'https://codebuff.com').replace(
    /\/$/,
    '',
  )
}

function sessionEndpoint(method: FreebuffSessionMethod): string {
  return `${sessionBaseUrl()}${method === 'POST' ? FREEBUFF_SESSION_ADMISSION_PATH : '/api/v1/freebuff/session'}`
}

/** The host the session API is reached on, for copy that names it. */
export function freebuffSessionHost(): string {
  try {
    return new URL(sessionBaseUrl()).host
  } catch {
    return sessionBaseUrl()
  }
}

/**
 * A network-layer failure: nothing came back, as opposed to a response we did
 * not like. Bun's `fetch` surfaces these as `fetch failed`, a TimeoutError, or
 * a bare socket code.
 */
export function isFreebuffSessionNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (isFreebuffSessionTimeoutError(error)) return true
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|network/i.test(
    `${error.message} ${(error.cause as Error | undefined)?.message ?? ''}`,
  )
}

/**
 * What the landing screen shows for a session request that never got an
 * answer.
 *
 * Until 2026-09-19 it printed the runtime's error verbatim, so a user whose
 * ISP could not route to this host — while every browser on the machine
 * reached freebuff.com, which sits on a different address — read
 * `The operation timed out.` and reinstalled. Four PLDT (Philippines) users
 * reported exactly that in two days; switching ISP fixed each one. Name the
 * host we could not reach and the two things that actually help, and never
 * blame the machine: the server was serving everyone else at the time.
 */
export function freebuffSessionUnreachableMessage(host: string): string {
  return (
    `Couldn't get a response from ${host}. If your browser can open ` +
    `freebuff.com, this network isn't routing to that host: try mobile data ` +
    `or another ISP, or use freebuff.com/web meanwhile.`
  )
}

export async function callFreebuffSession(
  method: FreebuffSessionMethod,
  token: string,
  opts: {
    instanceId?: string
    model?: string
    walletSpendLimit?: FreebuffWalletSpendLimit
    firstTabDiscount?: boolean
    signal?: AbortSignal
    compact?: boolean
  } = {},
): Promise<FreebuffSessionServerResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...freebucksTimeZoneHeaders(),
    [FIRST_TAB_DISCOUNT_HEADER]: opts.firstTabDiscount ? '1' : '0',
  }
  if ((method === 'GET' || method === 'DELETE') && opts.instanceId) {
    headers[FREEBUFF_INSTANCE_HEADER] = opts.instanceId
  }
  if (method === 'GET' && opts.compact) {
    headers[FREEBUFF_COMPACT_SESSION_HEADER] = '1'
  }
  if (method === 'POST') {
    if (opts.model) headers[FREEBUFF_MODEL_HEADER] = opts.model
    headers[FREEBUFF_WALLET_SPEND_LIMIT_HEADER] = String(
      opts.walletSpendLimit ?? 0,
    )
  }

  const response = await fetch(sessionEndpoint(method), {
    method,
    headers,
    signal: sessionFetchSignal(opts.signal),
  })

  if (method === 'POST' && [404, 405].includes(response.status)) {
    throw new FreebuffSessionRequestError(
      FREEBUFF_SESSION_UNSUPPORTED_MESSAGE,
      response.status,
      undefined,
      'session_admission_unsupported',
    )
  }
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
      (body.status === 'model_locked' ||
        body.status === 'model_unavailable' ||
        body.status === 'first_tab_discount_changed' ||
        body.status === 'consent_required')
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
    freebucks: next.freebucks !== undefined ? next.freebucks : current.freebucks,
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
