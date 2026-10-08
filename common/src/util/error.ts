import {
  redactHeadersForLog,
  redactUrlForLog,
  summarizeRequestBodyForLog,
} from './log-redaction'

import type { RequestBodySummary } from './log-redaction'

export type ErrorOr<T, E extends ErrorObject = ErrorObject> =
  | Success<T>
  | Failure<E>

export type Success<T> = {
  success: true
  value: T
}

export type Failure<E extends ErrorObject = ErrorObject> = {
  success: false
  error: E
}

/**
 * Result type for prompt functions that can be aborted.
 * Provides rich semantics to distinguish between successful completion and user abort.
 *
 * ## When to use `PromptResult<T>` vs `ErrorOr<T>`
 *
 * Use `PromptResult<T>` when:
 * - The operation can be cancelled by the user (via AbortSignal)
 * - An abort is an expected outcome, not an error
 * - You need to distinguish between errors (which might trigger fallbacks) and
 *   user-initiated aborts (which should propagate immediately)
 *
 * Use `ErrorOr<T>` when:
 * - The operation can fail with an error that should be handled
 * - There's no concept of user-initiated abort
 * - You want to return error details rather than throw
 *
 * ## Abort handling patterns
 *
 * 1. **Check and return early** - For graceful handling where abort means "stop, no error":
 *    ```ts
 *    const result = await promptAiSdk({ ... })
 *    if (result.aborted) return // or return null, false, etc.
 *    doSomething(result.value)
 *    ```
 *
 * 2. **Unwrap and throw** - For propagating aborts as exceptions:
 *    ```ts
 *    const value = unwrapPromptResult(await promptAiSdk({ ... }))
 *    // Throws if aborted, callers should use isAbortError() in catch blocks
 *    ```
 *
 * 3. **Rethrow in catch blocks** - Prevent swallowing abort errors:
 *    ```ts
 *    try {
 *      await someOperation()
 *    } catch (error) {
 *      if (isAbortError(error)) throw error // Don't swallow aborts
 *      // Handle other errors
 *    }
 *    ```
 */
export type PromptResult<T> = PromptSuccess<T> | PromptAborted

export type PromptSuccess<T> = {
  aborted: false
  value: T
}

export type PromptAborted = {
  aborted: true
  reason?: string
}

export type ErrorObject = {
  name: string
  message: string
  stack?: string
  /** HTTP status code from error.status (used by some libraries) */
  status?: number
  /** HTTP status code from error.statusCode (used by AI SDK and Codebuff errors) */
  statusCode?: number
  /** Optional machine-friendly error code, if available */
  code?: string
  /** Optional raw error object */
  rawError?: string
  /** Response body from API errors (AI SDK APICallError) */
  responseBody?: string
  /** URL that was called (API errors) */
  url?: string
  /** Whether the error is retryable (API errors) */
  isRetryable?: boolean
  /**
   * Shape of the request body that was sent (API errors): model, message
   * count, keys and size. Never the body itself, which holds the prompt.
   */
  requestBody?: RequestBodySummary
  /** Cause of the error, if nested */
  cause?: ErrorObject
}

export function success<T>(value: T): Success<T> {
  return {
    success: true,
    value,
  }
}

export function failure(error: unknown): Failure<ErrorObject> {
  return {
    success: false,
    error: getErrorObject(error),
  }
}

/**
 * Create a successful prompt result.
 */
export function promptSuccess<T>(value: T): PromptSuccess<T> {
  return {
    aborted: false,
    value,
  }
}

/**
 * Create an aborted prompt result.
 */
export function promptAborted(reason?: string): PromptAborted {
  return {
    aborted: true,
    ...(reason !== undefined && { reason }),
  }
}

/**
 * Standard error message for aborted requests.
 * Use this constant when throwing abort errors to ensure consistency.
 */
export const ABORT_ERROR_MESSAGE = 'Request aborted'

/**
 * Custom error class for abort errors.
 * Use this class instead of generic Error for abort errors to ensure
 * robust detection via isAbortError() (checks error.name === 'AbortError').
 */
export class AbortError extends Error {
  constructor(reason?: string) {
    super(reason ? `${ABORT_ERROR_MESSAGE}: ${reason}` : ABORT_ERROR_MESSAGE)
    this.name = 'AbortError'
  }
}

/**
 * Check if an error is an abort error.
 * Use this helper to detect abort errors in catch blocks.
 *
 * Detects both:
 * - Errors with message starting with 'Request aborted' (thrown by our code via AbortError)
 * - Native AbortError (thrown by fetch/AI SDK when AbortSignal is triggered)
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  // Check for our custom abort error message:
  // - Exact match: 'Request aborted'
  // - With reason: 'Request aborted: <reason>' (from AbortError class)
  if (
    error.message === ABORT_ERROR_MESSAGE ||
    error.message.startsWith(`${ABORT_ERROR_MESSAGE}: `)
  ) {
    return true
  }
  // Check for native AbortError (DOMException or Error with name 'AbortError')
  // This is thrown by fetch, AI SDK, and other web APIs when AbortSignal is triggered
  if (error.name === 'AbortError') {
    return true
  }
  return false
}

/**
 * Unwrap a PromptResult, returning the value if successful or throwing if aborted.
 *
 * Use this helper for consistent abort handling when you want aborts to propagate
 * as exceptions. Callers should use `isAbortError()` in catch blocks to detect
 * and handle abort errors appropriately (e.g., rethrow instead of logging as errors).
 *
 * @throws {AbortError} When result.aborted is true.
 */
export function unwrapPromptResult<T>(result: PromptResult<T>): T {
  if (result.aborted) {
    throw new AbortError(result.reason)
  }
  return result.value
}

/**
 * Parses a JSON response body string from an API error to extract structured error details.
 * Used to extract machine-readable error codes and human-readable messages from API responses
 * (e.g., AI SDK's APICallError includes a responseBody with the server's JSON response).
 *
 * Returns extracted fields, or an empty object if the responseBody is not a valid JSON string
 * with the expected shape.
 */
export function parseApiErrorResponseBody(responseBody: unknown): {
  errorCode?: string
  message?: string
  countryCode?: string
  countryBlockReason?: string
  ipPrivacySignals?: string[]
} {
  if (typeof responseBody !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(responseBody)
    if (!parsed || typeof parsed !== 'object') return {}
    const result: {
      errorCode?: string
      message?: string
      countryCode?: string
      countryBlockReason?: string
      ipPrivacySignals?: string[]
    } = {}
    if (
      'error' in parsed &&
      typeof (parsed as { error: unknown }).error === 'string'
    ) {
      result.errorCode = (parsed as { error: string }).error
    }
    if (
      'message' in parsed &&
      typeof (parsed as { message: unknown }).message === 'string'
    ) {
      result.message = (parsed as { message: string }).message
    }
    // OpenAI-style nested error object: { error: { message, code, type } }.
    // Upstream provider errors (Fireworks, OpenRouter, etc.) are relayed to
    // the client in this shape.
    if (
      'error' in parsed &&
      typeof (parsed as { error: unknown }).error === 'object' &&
      (parsed as { error: unknown }).error !== null
    ) {
      const nested = (parsed as { error: Record<string, unknown> }).error
      if (result.errorCode === undefined) {
        if (typeof nested.code === 'string') {
          result.errorCode = nested.code
        } else if (typeof nested.type === 'string') {
          result.errorCode = nested.type
        }
      }
      if (result.message === undefined && typeof nested.message === 'string') {
        result.message = nested.message
      }
    }
    if (
      'countryCode' in parsed &&
      typeof (parsed as { countryCode: unknown }).countryCode === 'string'
    ) {
      result.countryCode = (parsed as { countryCode: string }).countryCode
    }
    if (
      'countryBlockReason' in parsed &&
      typeof (parsed as { countryBlockReason: unknown }).countryBlockReason ===
        'string'
    ) {
      result.countryBlockReason = (
        parsed as { countryBlockReason: string }
      ).countryBlockReason
    }
    if ('ipPrivacySignals' in parsed) {
      const signals = (parsed as { ipPrivacySignals: unknown }).ipPrivacySignals
      if (Array.isArray(signals)) {
        result.ipPrivacySignals = signals.filter(
          (signal): signal is string => typeof signal === 'string',
        )
      }
    }
    return result
  } catch {
    return {}
  }
}

export type ApiErrorDetails = ReturnType<typeof parseApiErrorResponseBody> & {
  statusCode?: number
}

function getApiErrorCandidates(
  error: unknown,
  seen = new Set<object>(),
): unknown[] {
  if (!error || typeof error !== 'object') return [error]
  if (seen.has(error)) return []
  seen.add(error)

  const candidates: unknown[] = [error]
  const errorWithNested = error as {
    lastError?: unknown
    errors?: unknown[]
    cause?: unknown
  }

  candidates.push(...getApiErrorCandidates(errorWithNested.lastError, seen))

  if (Array.isArray(errorWithNested.errors)) {
    for (const nestedError of [...errorWithNested.errors].reverse()) {
      candidates.push(...getApiErrorCandidates(nestedError, seen))
    }
  }

  candidates.push(...getApiErrorCandidates(errorWithNested.cause, seen))

  return candidates
}

function getApiErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined

  if ('statusCode' in error) {
    const statusCode = (error as { statusCode: unknown }).statusCode
    if (typeof statusCode === 'number') return statusCode
  }

  if ('status' in error) {
    const status = (error as { status: unknown }).status
    if (typeof status === 'number') return status
  }

  return undefined
}

function getApiErrorResponseBody(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined
  if (!('responseBody' in error)) return undefined
  return (error as { responseBody: unknown }).responseBody
}

function hasParsedApiErrorDetails(
  details: ReturnType<typeof parseApiErrorResponseBody>,
): boolean {
  return (
    details.errorCode !== undefined ||
    details.message !== undefined ||
    details.countryCode !== undefined ||
    details.countryBlockReason !== undefined ||
    details.ipPrivacySignals !== undefined
  )
}

/**
 * Extracts HTTP status and structured server error fields from API errors,
 * including AI SDK RetryError wrappers whose useful APICallError is nested in
 * `lastError` / `errors`.
 */
export function extractApiErrorDetails(error: unknown): ApiErrorDetails {
  for (const candidate of getApiErrorCandidates(error)) {
    const statusCode = getApiErrorStatusCode(candidate)
    const parsed = parseApiErrorResponseBody(getApiErrorResponseBody(candidate))

    if (statusCode !== undefined || hasParsedApiErrorDetails(parsed)) {
      return {
        ...parsed,
        ...(statusCode !== undefined && { statusCode }),
      }
    }
  }

  return {}
}

/**
 * Detects the runtime's fetch inactivity timeout (a DOMException named
 * "TimeoutError"). Bun hardcodes this to fire after 5 minutes without
 * receiving any bytes on a fetch response — including while still waiting on
 * the response headers, verified 2026-08-02 against a server that delayed only
 * its headers. Walks AI SDK RetryError wrappers and cause chains.
 */
export function isFetchIdleTimeoutError(error: unknown): boolean {
  for (const candidate of getApiErrorCandidates(error)) {
    if (!candidate || typeof candidate !== 'object') continue
    const { name, message } = candidate as { name?: unknown; message?: unknown }
    if (
      name === 'TimeoutError' ||
      (typeof message === 'string' &&
        message.toLowerCase().includes('the operation timed out'))
    ) {
      return true
    }
  }
  return false
}

/**
 * User-facing explanation for the fetch idle timeout. The raw runtime message
 * ("The operation timed out.") reads like a server failure, so this states the
 * symptom instead.
 *
 * It deliberately does NOT blame the user's network. That copy shipped in June
 * 2026 on the assumption that a heartbeat covered every silent window, but the
 * heartbeat only started once the upstream model had answered — a slow model
 * start produced exactly this error with nothing wrong on the user's end, and
 * sent them chasing their own VPN. See grace-flush.ts on the server.
 */
export const FETCH_IDLE_TIMEOUT_USER_MESSAGE =
  'Connection timed out: no data was received from the server for 5 minutes, so the request was aborted.\n\n' +
  'This can be a slow model start on our side, or a connection dropped in transit (VPN, proxy, firewall, or flaky network).\n\n' +
  'Retrying your message usually works. If it keeps happening, try a different model, or check your network/VPN/proxy.'

/**
 * Substrings of error messages that indicate the TCP connection died in
 * transit (as opposed to the server returning an error response). Bun's fetch
 * throws a plain Error with "The socket connection was closed unexpectedly..."
 * and code ECONNRESET/ConnectionClosed; undici throws TypeError "fetch failed".
 */
const TRANSIENT_NETWORK_ERROR_MESSAGE_PATTERNS = [
  'socket connection was closed unexpectedly',
  'fetch failed',
  'failed to fetch',
  'network connection was lost',
]

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  // Bun-specific fetch error codes
  'ConnectionClosed',
  'ConnectionRefused',
  'FailedToOpenSocket',
  // Bun's fetch, when a compressed body ends before its compressed stream
  // does: the same cut connection as above, on a gzip/br response (the
  // chat-completions SSE body is gzipped, COD-764). Reproduced on Bun 1.3.14:
  // a gzip SSE body whose HTTP framing ends cleanly mid-stream throws
  // "ZlibError fetching <url>", code ZlibError; br gives
  // BrotliDecompressionError. On 2026-10-08 every web deploy turned these
  // into failed turns (545 in 15 minutes at 2pm PT). The same cut on an
  // identity body is a clean end, and Node's fetch treats a truncated gzip
  // body as one too, so both already recover.
  'ZlibError',
  'BrotliDecompressionError',
  // undici (Node's fetch): the peer closed the socket. It rides as the cause
  // of the body-read TypeError below.
  'UND_ERR_SOCKET',
])

/**
 * undici's error when a response body is cut after the headers arrived:
 * `TypeError: terminated`, cause `SocketError: other side closed`
 * (UND_ERR_SOCKET). Bun reports the same cut as "The socket connection was
 * closed unexpectedly". Matched on the exact message and type, because
 * "terminated" alone is too common a word. Without this, an SDK host running
 * on Node ended the turn in an error on a dropped model stream, where a Bun
 * host gets the stream-interrupted continuation step.
 */
function isUndiciBodyTerminated(candidate: object): boolean {
  return (
    candidate instanceof TypeError &&
    (candidate as { message?: unknown }).message === 'terminated'
  )
}

/**
 * Detects transient connection-level failures (socket closed/reset, connection
 * refused, etc.) where no HTTP response was received. These are safe to retry
 * and should be shown to the user as a connectivity problem instead of a raw
 * runtime error with a stack trace. Walks AI SDK RetryError wrappers and
 * cause chains.
 */
export function isTransientNetworkError(error: unknown): boolean {
  for (const candidate of getApiErrorCandidates(error)) {
    if (!candidate || typeof candidate !== 'object') continue
    if (isUndiciBodyTerminated(candidate)) return true
    const { message, code } = candidate as {
      message?: unknown
      code?: unknown
    }
    if (typeof code === 'string' && TRANSIENT_NETWORK_ERROR_CODES.has(code)) {
      return true
    }
    if (typeof message === 'string') {
      const lower = message.toLowerCase()
      if (
        TRANSIENT_NETWORK_ERROR_MESSAGE_PATTERNS.some((pattern) =>
          lower.includes(pattern),
        )
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * User-facing explanation for a dropped connection. The raw runtime message
 * ("The socket connection was closed unexpectedly. For more information, pass
 * `verbose: true`...") plus a stack trace reads like a crash; in practice the
 * connection to the server was cut mid-request, which is transient and safe
 * to retry.
 */
export const TRANSIENT_NETWORK_ERROR_USER_MESSAGE =
  'Connection interrupted: the connection to the server was closed unexpectedly, even after retrying.\n\n' +
  'This is usually a transient issue — a flaky network, VPN/proxy, or the server briefly under heavy load.\n\n' +
  'Your progress is saved. Please try sending your message again.'

// Extended error properties that various libraries add to Error objects
interface ExtendedErrorProperties {
  status?: number
  statusCode?: number
  code?: string
  // API error properties (AI SDK APICallError, etc.)
  responseBody?: string
  url?: string
  isRetryable?: boolean
  requestBodyValues?: Record<string, unknown>
  cause?: unknown
}

/**
 * Safely stringify an object, handling circular references and large objects.
 */
function safeStringify(
  value: unknown,
  maxLength = 10000,
  redact?: (key: string, val: unknown) => unknown,
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value.slice(0, maxLength)
  try {
    const seen = new WeakSet()
    const str = JSON.stringify(
      value,
      (key, raw) => {
        const val = redact ? redact(key, raw) : raw
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]'
          seen.add(val)
        }
        return val
      },
      2,
    )
    return str?.slice(0, maxLength)
  } catch {
    return '[Unable to stringify]'
  }
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * `rawError` serializes every enumerable field of the error and its causes, so
 * the same redaction applies there: an AI SDK `APICallError` carries the whole
 * request body and the response headers, and Bun's fetch errors carry the
 * request URL as `path`.
 */
function redactRawErrorField(key: string, val: unknown): unknown {
  if (key === 'requestBodyValues') return summarizeRequestBodyForLog(val)
  if (
    key === 'requestHeaders' ||
    key === 'responseHeaders' ||
    key === 'headers'
  ) {
    return redactHeadersForLog(val) ?? val
  }
  if (
    (key === 'url' || key === 'path') &&
    typeof val === 'string' &&
    URL_LIKE.test(val)
  ) {
    return redactUrlForLog(val)
  }
  return val
}

export function getErrorObject(
  error: unknown,
  options: { includeRawError?: boolean } = {},
): ErrorObject {
  if (error instanceof Error) {
    const extError = error as Error & Partial<ExtendedErrorProperties>

    // Extract responseBody - could be string or object
    let responseBody: string | undefined
    if (extError.responseBody !== undefined) {
      responseBody = safeStringify(extError.responseBody)
    }

    // Extract cause - recursively convert to ErrorObject if present
    let cause: ErrorObject | undefined
    if (extError.cause !== undefined) {
      cause = getErrorObject(extError.cause, options)
    }

    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      status: typeof extError.status === 'number' ? extError.status : undefined,
      statusCode:
        typeof extError.statusCode === 'number'
          ? extError.statusCode
          : undefined,
      code: typeof extError.code === 'string' ? extError.code : undefined,
      rawError: options.includeRawError
        ? safeStringify(error, 10000, redactRawErrorField)
        : undefined,
      // API error fields
      responseBody,
      url:
        typeof extError.url === 'string'
          ? redactUrlForLog(extError.url)
          : undefined,
      isRetryable:
        typeof extError.isRetryable === 'boolean'
          ? extError.isRetryable
          : undefined,
      requestBody: summarizeRequestBodyForLog(extError.requestBodyValues),
      cause,
    }
  }

  return {
    name: 'Error',
    message: `${error}`,
  }
}
