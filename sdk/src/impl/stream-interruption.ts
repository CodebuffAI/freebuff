/**
 * Classification of completion-stream endings that would otherwise silently
 * end the turn with nothing visible to the user. Two classes:
 *
 * **'stream-interrupted'** — the connection was cut mid-response. A healthy
 * OpenAI-compatible SSE stream always ends with a chunk carrying a real
 * `finish_reason` (and, on our backend, usage totals) before `[DONE]`. When
 * the connection dies mid-stream — a server deploy killing the instance, a
 * proxy timeout, a network drop — the HTTP body just ends: the AI SDK
 * provider's flush then emits a `finish` part with raw finish reason
 * `'unknown'` and no usage (normalized to `'other'` by AI SDK 7), and the
 * stream otherwise looks like a normal completion. `'unknown'` alone is not
 * proof: providers map any unrecognized `finish_reason` string to `'unknown'`
 * too. Usage disambiguates — it arrives in the stream's final chunk, so
 * `'unknown'` *with* usage means an odd but complete stream, while `'unknown'`
 * *without* usage means the tail was never received. A missing finish part
 * altogether is always an interruption.
 *
 * **'output-limit'** — the model produced no text or tool calls because it
 * either spent its output budget on reasoning (`length`) or ended the stream
 * after emitting only native reasoning, under any finish reason the provider
 * chose to report (a Bedrock-via-OpenRouter reasoning-only end has arrived as
 * 'unknown' with usage). Both are complete, well-formed streams whose turns
 * would otherwise end with nothing visible. A `length` stop after real output
 * is the answer running long, which is not silently recoverable (retrying
 * would duplicate output).
 *
 * **'provider-error'** — the provider (or our server, on its behalf) reported
 * a retryable failure (5xx, 429) as an in-band error chunk. The same outage as
 * a cut connection, just announced; see {@link classifyProviderErrorRecovery}.
 *
 * Before this existed, the first two classes read as the agent "randomly stopping"
 * mid-thinking with no error anywhere (2026-07-17 incident).
 */

import type { StreamRecoverySource } from '@codebuff/common/types/contracts/llm'
import { isTransientNetworkError } from '@codebuff/common/util/error'
import { APICallError } from 'ai'

export interface StreamFinishInfo {
  finishReason: string
  hasUsage: boolean
}

/** Distill an AI SDK `stream` finish part into what detection needs. */
export function streamFinishInfoOf(
  part: {
    finishReason: string
    rawFinishReason?: string
    totalUsage: {
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
    }
  },
  v2Compatibility = false,
): StreamFinishInfo {
  const { inputTokens, outputTokens, totalTokens } = part.totalUsage
  return {
    finishReason:
      part.finishReason === 'other' &&
      (part.rawFinishReason === 'unknown' ||
        (v2Compatibility && part.rawFinishReason === undefined))
        ? 'unknown'
        : part.finishReason,
    hasUsage: [inputTokens, outputTokens, totalTokens].some(
      (tokens) => typeof tokens === 'number' && Number.isFinite(tokens),
    ),
  }
}

export interface StreamEndRecovery {
  source: StreamRecoverySource
  /** Injected into the conversation (and shown to the user). Written for the
   *  model: the retry step sees its own partial output plus this note. */
  message: string
  /** How long to wait before yielding the recovery, so the forced retry step
   *  does not hit a provider that just failed or asked us to back off.
   *  Bounded by PROVIDER_ERROR_MAX_RETRY_DELAY_MS. */
  delayMs?: number
  /** User-facing summary of the failure, for the error the agent loop raises
   *  if the retries run out. */
  detail?: string
  /** HTTP status of a provider error, for telemetry. */
  statusCode?: number
}

const STREAM_INTERRUPTED_RECOVERY: StreamEndRecovery = {
  source: 'stream-interrupted',
  message:
    'The connection dropped while the response was streaming, so the output above may be cut off mid-thought. Continue from where it left off (or start the step over if nothing useful arrived).',
}

const OUTPUT_LIMIT_RECOVERY: StreamEndRecovery = {
  source: 'output-limit',
  // The actionable instruction is a tighter budget on the redo: finishing the
  // same depth of reasoning would hit the same limit again.
  message:
    'The response hit its output token limit while still reasoning, so no answer was produced. Redo this step thinking much more briefly, and get to the response or tool calls quickly.',
}

const REASONING_ONLY_RECOVERY: StreamEndRecovery = {
  // Keep the existing source so this follows the same bounded retry path,
  // while the message stays truthful for a complete stream.
  source: 'output-limit',
  message:
    'The response ended after reasoning without producing an answer or tool call. Continue this step, think more briefly, and get to the response or tool calls quickly.',
}

/**
 * Decide whether a completed stream ended in a recoverable silent stop.
 * Returns the recovery to yield as an error chunk, or null for normal
 * endings. A user cancel (`aborted`) also ends streams early and is never a
 * recovery.
 */
export function classifyStreamEndRecovery(params: {
  aborted: boolean
  /** Info from the stream's `finish` part, or undefined if none arrived. */
  finish: StreamFinishInfo | undefined
  receivedReasoning: boolean
  yieldedText: boolean
  yieldedToolCall: boolean
}): StreamEndRecovery | null {
  const { aborted, finish, receivedReasoning, yieldedText, yieldedToolCall } =
    params
  if (aborted) return null

  const interrupted =
    finish === undefined ||
    (finish.finishReason === 'unknown' && !finish.hasUsage)
  if (interrupted) return STREAM_INTERRUPTED_RECOVERY

  if (yieldedText || yieldedToolCall) return null

  if (finish.finishReason === 'length') return OUTPUT_LIMIT_RECOVERY

  // Whatever finish reason the provider reported ('stop', 'unknown' with
  // usage, anything else): reasoning with nothing visible after it is a
  // silent stop.
  if (receivedReasoning) return REASONING_ONLY_RECOVERY

  return null
}

/**
 * Classify an exception thrown while consuming a completion stream. Some
 * runtimes surface a severed response body as an exception (for example Bun's
 * `ConnectionClosed` / `ECONNRESET`) instead of the graceful-but-incomplete
 * stream ending handled by {@link classifyStreamEndRecovery}. Both represent
 * the same recoverable condition to the agent loop.
 */
export function classifyThrownStreamRecovery(params: {
  aborted: boolean
  error: unknown
}): StreamEndRecovery | null {
  if (params.aborted || !isTransientNetworkError(params.error)) return null
  return STREAM_INTERRUPTED_RECOVERY
}

/** Upper bound on any wait before a provider-error retry, whatever the
 *  provider asked for. The user is watching a stalled turn meanwhile, and the
 *  retries are capped (MAX_CONSECUTIVE_STREAM_RECOVERIES), so a long
 *  retry-after is better answered by giving up than by sitting on it. */
export const PROVIDER_ERROR_MAX_RETRY_DELAY_MS = 10_000
/** Backoff when a rate-limited provider gave no retry-after. */
export const PROVIDER_RATE_LIMIT_DEFAULT_DELAY_MS = 2_000
/** Backoff after a provider server error. */
export const PROVIDER_ERROR_DEFAULT_DELAY_MS = 1_000

/** Keeps a provider's error text from flooding the conversation note. */
const MAX_PROVIDER_ERROR_DETAIL_LENGTH = 500

/**
 * The server's grace flush (web/src/app/api/v1/chat/completions/
 * grace-flush.ts) reports an upstream failure that arrives after SSE headers
 * were sent as `{error: {message: 'Upstream provider error (NNN): ...', type:
 * 'upstream_error'}}`. That shape has nowhere structured to put the status,
 * so it rides in the message text (and is absent when the upstream gave none).
 */
const UPSTREAM_ERROR_TYPE = 'upstream_error'
const UPSTREAM_STATUS_IN_MESSAGE = /^Upstream provider error \((\d{3})\)/

/** String codes an in-band error carries instead of an HTTP status (the
 *  server's OpenAI Responses adapter forwards the event's own `code`). */
const RETRYABLE_ERROR_CODES = new Set(['server_error', 'rate_limit_exceeded'])

const isRetryableStatus = (status: number) =>
  status === 408 || status === 429 || (status >= 500 && status <= 599)

function parseErrorBody(
  responseBody: string | undefined,
): { type?: unknown; code?: unknown } | undefined {
  if (!responseBody) return undefined
  try {
    const parsed = JSON.parse(responseBody) as { error?: unknown } | null
    return parsed?.error && typeof parsed.error === 'object'
      ? (parsed.error as { type?: unknown; code?: unknown })
      : undefined
  } catch {
    return undefined
  }
}

/** Milliseconds from a `retry-after-ms` / `retry-after` header, if any. */
function retryAfterMsOf(
  headers: Record<string, string> | undefined,
): number | undefined {
  if (!headers) return undefined
  const header = (name: string) =>
    Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
  const retryAfterMs = header('retry-after-ms')
  if (retryAfterMs !== undefined) {
    const ms = Number(retryAfterMs)
    if (Number.isFinite(ms) && ms >= 0) return ms
  }
  const retryAfter = header('retry-after')
  if (retryAfter === undefined) return undefined
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(retryAfter)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

/**
 * Classify an `error` part of the completion stream as a retryable provider
 * failure: a 5xx, 429 or 408 the provider reported in band (OpenRouter's
 * mid-stream `{error: {code: 502, ...}}`), or the server's own in-band
 * upstream failure (see UPSTREAM_ERROR_TYPE).
 *
 * These used to be thrown straight out and end the run, while the same outage
 * showing up as a severed body got a continuation step instead, so "the
 * provider said it failed" was fatal and "the connection died" was not, which
 * is backwards for a flaky endpoint. Both now take the same capped retry
 * path; the note and the give-up error say it was the provider, not the
 * user's network.
 *
 * Deliberately NOT retried: anything refused on purpose. That is every other
 * 4xx, such as 400 (context too long, content policy), 401, 402, 403 and the
 * session/admission refusals (409, 428), plus an error explicitly marked
 * non-retryable (the per-turn spend breaker's 429), and in-band errors that
 * carry neither a status nor a known retryable code. A failed HTTP response
 * the AI SDK already retried arrives wrapped in a RetryError, not a bare
 * APICallError, so this never stacks a second retry loop on top of it.
 */
export function classifyProviderErrorRecovery(params: {
  aborted: boolean
  error: unknown
}): StreamEndRecovery | null {
  const { aborted, error } = params
  if (aborted || !APICallError.isInstance(error)) return null
  // An error built with a status carries an explicit retry verdict
  // (FINAL_REFUSALS in model-provider.ts: the spend breaker's 429, a
  // refunded or superseded start's 409); respect it.
  if (error.statusCode !== undefined && !error.isRetryable) return null

  const body = parseErrorBody(error.responseBody)
  const isUpstreamError = body?.type === UPSTREAM_ERROR_TYPE
  const statusInMessage = isUpstreamError
    ? UPSTREAM_STATUS_IN_MESSAGE.exec(error.message)?.[1]
    : undefined
  const statusCode =
    error.statusCode ??
    (statusInMessage !== undefined ? Number(statusInMessage) : undefined)
  const code = typeof body?.code === 'string' ? body.code : undefined

  let rateLimited: boolean
  if (statusCode !== undefined) {
    if (!isRetryableStatus(statusCode)) return null
    rateLimited = statusCode === 429
  } else if (code !== undefined && RETRYABLE_ERROR_CODES.has(code)) {
    rateLimited = code === 'rate_limit_exceeded'
  } else if (isUpstreamError) {
    // The server lost the upstream without a status (a connect failure or
    // timeout on its side): the same class as a 502.
    rateLimited = false
  } else {
    return null
  }

  const delayMs = Math.min(
    PROVIDER_ERROR_MAX_RETRY_DELAY_MS,
    retryAfterMsOf(error.responseHeaders) ??
      (rateLimited
        ? PROVIDER_RATE_LIMIT_DEFAULT_DELAY_MS
        : PROVIDER_ERROR_DEFAULT_DELAY_MS),
  )
  const message =
    error.message.trim() ||
    (statusCode !== undefined ? `HTTP ${statusCode}` : 'no reason given')
  const detail =
    message.length > MAX_PROVIDER_ERROR_DETAIL_LENGTH
      ? message.slice(0, MAX_PROVIDER_ERROR_DETAIL_LENGTH) + '...'
      : message
  return {
    source: 'provider-error',
    message: `The model provider reported an error while the response was streaming (${detail}), so the output above may be cut off mid-thought. Continue from where it left off (or start the step over if nothing useful arrived).`,
    delayMs,
    detail,
    ...(statusCode !== undefined && { statusCode }),
  }
}
