import { WEBSITE_URL } from '@codebuff/sdk'
import {
  sanitizeTerminalStrings,
  sanitizeTerminalText,
} from '@codebuff/common/util/terminal-safe-text'
import type {
  PublishAgentsResponse,
} from '@codebuff/common/types/api/agents/publish'
import type { FeedbackRequest } from '@codebuff/common/schemas/feedback'

/**
 * API response types for consistent error handling.
 *
 * When `ok` is true, `data` may be undefined for responses with no body (e.g., 204 No Content).
 * Callers should check for `response.data` when they expect data from the endpoint.
 */
export type ApiResponse<T> =
  | { ok: true; status: number; data?: T }
  | { ok: false; status: number; error?: string; errorData?: Record<string, unknown> }

// ============================================================================
// Type-safe endpoint request/response types
// ============================================================================

/** User fields that can be fetched from /api/v1/me */
export type UserField = 'id' | 'email' | 'discord_id'

export type UserDetails<T extends UserField = UserField> = {
  [K in T]: K extends 'discord_id' ? string | null : string
}

export interface UsageRequest {
  fingerprintId?: string
}

export interface UsageResponse {
  type: 'usage-response'
  usage: number
  remainingBalance: number | null
  balanceBreakdown?: Record<string, number>
  next_quota_reset: string | null
}

export interface LoginCodeRequest {
  fingerprintId: string
}

export interface LoginCodeResponse {
  loginUrl: string
  fingerprintHash: string
  expiresAt: string
}

export interface LoginStatusRequest {
  fingerprintId: string
  fingerprintHash: string
  expiresAt: string
}

export interface LoginStatusResponse {
  user?: Record<string, unknown>
}

export interface LogoutRequest {
  userId?: string
  fingerprintId?: string
  fingerprintHash?: string
}

export interface FeedbackResponse {
  success: boolean
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number
  /** Initial delay in ms before first retry (default: 1000) */
  initialDelayMs?: number
  /** Maximum delay in ms between retries (default: 10000) */
  maxDelayMs?: number
  /** HTTP status codes to retry on (default: [408, 429, 500, 502, 503, 504]) */
  retryableStatusCodes?: number[]
}

const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
}

/**
 * Configuration for creating a Codebuff API client
 */
export interface CodebuffApiClientConfig {
  /** Base URL for API requests (defaults to WEBSITE_URL from SDK) */
  baseUrl?: string
  /** Auth token for Bearer authentication */
  authToken?: string
  /** Custom fetch implementation (for testing) */
  fetch?: typeof fetch
  /** Default timeout in ms for all requests (default: 30000) */
  defaultTimeoutMs?: number
  /** Default retry configuration */
  retry?: RetryConfig
}

/**
 * Options for individual requests
 */
export interface RequestOptions {
  /** Query parameters to append to URL */
  query?: Record<string, string>
  /** Include Authorization header (default: true when authToken is set) */
  includeAuth?: boolean
  /** Include session token as Cookie header (for legacy endpoints) */
  includeCookie?: boolean
  /** Request timeout in ms (overrides default) */
  timeoutMs?: number
  /** Retry configuration (overrides default) */
  retry?: RetryConfig | false
  /** Custom headers */
  headers?: Record<string, string>
}

export interface CodebuffApiClient {
  readonly baseUrl: string
  readonly authToken?: string

  /** Make a raw HTTP request */
  request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<ApiResponse<T>>

  /** Make a GET request */
  get<T>(path: string, options?: RequestOptions): Promise<ApiResponse<T>>

  /** Make a POST request */
  post<T>(
    path: string,
    body?: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<ApiResponse<T>>

  /** Make a PUT request */
  put<T>(
    path: string,
    body?: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<ApiResponse<T>>

  /** Make a PATCH request */
  patch<T>(
    path: string,
    body?: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<ApiResponse<T>>

  /** Make a DELETE request */
  delete<T>(path: string, options?: RequestOptions): Promise<ApiResponse<T>>

  // ============================================================================
  // Type-safe endpoint methods
  // ============================================================================

  /** Fetch user details from /api/v1/me */
  me<T extends UserField>(
    fields: readonly T[],
  ): Promise<ApiResponse<UserDetails<T>>>

  /** Fetch usage data from /api/v1/usage */
  usage(req?: UsageRequest): Promise<ApiResponse<UsageResponse>>

  /** Request a login code from /api/auth/cli/code */
  loginCode(req: LoginCodeRequest): Promise<ApiResponse<LoginCodeResponse>>

  /** Check login status from /api/auth/cli/status */
  loginStatus(
    req: LoginStatusRequest,
  ): Promise<ApiResponse<LoginStatusResponse>>

  /** Publish agents via /api/agents/publish */
  publish(
    data: Record<string, unknown>[],
    allLocalAgentIds?: string[],
  ): Promise<ApiResponse<PublishAgentsResponse>>

  /** Logout via /api/auth/cli/logout */
  logout(req?: LogoutRequest): Promise<ApiResponse<void>>

  /** Submit feedback via /api/v1/feedback */
  feedback(req: FeedbackRequest): Promise<ApiResponse<FeedbackResponse>>
}

const TLS_CERTIFICATE_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
])

function getTlsCertificateError(error: Error, depth = 0): Error | null {
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : undefined
  const message = error.message.toLowerCase()
  if (
    (code && TLS_CERTIFICATE_ERROR_CODES.has(code)) ||
    message.includes('self signed certificate') ||
    message.includes('unable to verify the first certificate') ||
    message.includes('certificate has expired') ||
    message.includes('certificate verify failed')
  ) {
    return error
  }

  if (depth >= 2 || !(error.cause instanceof Error)) {
    return null
  }

  return getTlsCertificateError(error.cause, depth + 1)
}

function formatNetworkErrorMessage(error: Error, method: string, url: string) {
  const requestUrl = new URL(url)
  const tlsCertificateError = getTlsCertificateError(error)

  if (tlsCertificateError) {
    return [
      `TLS certificate verification failed for ${requestUrl.origin}.`,
      'If your network intercepts HTTPS traffic, install its root certificate into your system trust store or use a network path that does not intercept TLS.',
      `Original error: ${tlsCertificateError.message} (${method} ${url})`,
    ].join(' ')
  }

  return `${error.message} (${method} ${url})`
}

/**
 * Sleep for a given duration
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Calculate delay with exponential backoff and jitter
 */
const calculateBackoffDelay = (
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
): number => {
  const exponentialDelay = initialDelayMs * Math.pow(2, attempt)
  const jitter = Math.random() * 0.3 * exponentialDelay // 0-30% jitter
  return Math.min(exponentialDelay + jitter, maxDelayMs)
}

/**
 * Check if an error is retryable (network errors).
 *
 * Note: AbortError is NOT retryable because it indicates intentional cancellation
 * (e.g., user cancelled the request or our timeout was exceeded).
 */
const isRetryableError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const name = error.name.toLowerCase()
    const message = error.message.toLowerCase()

    // Don't retry abort errors - they indicate intentional cancellation
    if (name === 'aborterror') {
      return false
    }
    if (getTlsCertificateError(error)) {
      return false
    }

    return (
      name === 'timeouterror' ||
      message.includes('network') ||
      message.includes('fetch') ||
      message.includes('econnreset') ||
      message.includes('econnrefused')
    )
  }
  return false
}

/**
 * Create a Codebuff API client for making authenticated requests to the Codebuff API
 */
export function createCodebuffApiClient(
  config: CodebuffApiClientConfig = {},
): CodebuffApiClient {
  const {
    baseUrl = WEBSITE_URL,
    authToken,
    fetch: fetchFn = fetch,
    defaultTimeoutMs = 30000,
    retry: defaultRetryConfig = {},
  } = config

  const mergedDefaultRetry: Required<RetryConfig> = {
    ...DEFAULT_RETRY_CONFIG,
    ...defaultRetryConfig,
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const {
      query,
      includeAuth = true,
      includeCookie = false,
      timeoutMs = defaultTimeoutMs,
      retry: retryConfig = mergedDefaultRetry,
      headers: customHeaders = {},
    } = options

    // Build URL with query parameters
    let url = `${baseUrl}${path}`
    if (query && Object.keys(query).length > 0) {
      const params = new URLSearchParams(query)
      url += `?${params.toString()}`
    }

    // Build headers
    const headers: Record<string, string> = { ...customHeaders }
    if (authToken && includeAuth) {
      headers['Authorization'] = `Bearer ${authToken}`
    }
    if (authToken && includeCookie) {
      headers['Cookie'] = `next-auth.session-token=${authToken};`
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    // Build fetch options
    const fetchOptions: RequestInit = {
      method,
      headers,
    }
    if (body !== undefined) {
      fetchOptions.body = JSON.stringify(body)
    }

    // Determine retry config
    const shouldRetry = retryConfig !== false
    const retryOpts = shouldRetry
      ? { ...mergedDefaultRetry, ...retryConfig }
      : null

    let lastError: unknown
    const maxAttempts = shouldRetry ? (retryOpts?.maxRetries ?? 0) + 1 : 1

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Create abort controller for timeout
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetchFn(url, {
          ...fetchOptions,
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        if (response.ok) {
          try {
            const responseBody = await response.json()
            const data = responseBody as T
            return { ok: true, status: response.status, data }
          } catch {
            // Response was OK but no JSON body (e.g., 204 No Content)
            return { ok: true, status: response.status }
          }
        }

        // Check if we should retry on this status code
        if (
          shouldRetry &&
          retryOpts &&
          retryOpts.retryableStatusCodes.includes(response.status) &&
          attempt < maxAttempts - 1
        ) {
          const delay = calculateBackoffDelay(
            attempt,
            retryOpts.initialDelayMs,
            retryOpts.maxDelayMs,
          )
          await sleep(delay)
          continue
        }

        // Parse error response
        let errorMessage: string | undefined
        let errorData: unknown
        try {
          // Error text is shown to the user as-is by several callers: no
          // escape sequences from a response body reach the terminal.
          const errorBody = sanitizeTerminalStrings(await response.json())
          errorData = errorBody
          errorMessage =
            errorBody?.error || errorBody?.message || response.statusText
        } catch {
          try {
            errorMessage = sanitizeTerminalText(await response.text())
          } catch {
            errorMessage = response.statusText
          }
        }

        return { ok: false, status: response.status, error: errorMessage, errorData: errorData as Record<string, unknown> | undefined }
      } catch (error) {
        clearTimeout(timeoutId)
        lastError = error

        // Check if we should retry on this error
        if (
          shouldRetry &&
          retryOpts &&
          isRetryableError(error) &&
          attempt < maxAttempts - 1
        ) {
          const delay = calculateBackoffDelay(
            attempt,
            retryOpts.initialDelayMs,
            retryOpts.maxDelayMs,
          )
          await sleep(delay)
          continue
        }

        // Don't retry, throw the error with URL context
        if (error instanceof Error) {
          const enhancedError = new Error(
            formatNetworkErrorMessage(error, method, url),
          )
          enhancedError.name = error.name
          enhancedError.cause = error
          throw enhancedError
        }
        throw error
      }
    }

    // Should not reach here, but just in case
    throw lastError ?? new Error('Request failed after all retries')
  }

  return {
    baseUrl,
    authToken,
    request,

    get<T>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
      return request<T>('GET', path, undefined, options)
    },

    post<T>(
      path: string,
      body?: Record<string, unknown>,
      options?: RequestOptions,
    ): Promise<ApiResponse<T>> {
      return request<T>('POST', path, body, options)
    },

    put<T>(
      path: string,
      body?: Record<string, unknown>,
      options?: RequestOptions,
    ): Promise<ApiResponse<T>> {
      return request<T>('PUT', path, body, options)
    },

    patch<T>(
      path: string,
      body?: Record<string, unknown>,
      options?: RequestOptions,
    ): Promise<ApiResponse<T>> {
      return request<T>('PATCH', path, body, options)
    },

    delete<T>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
      return request<T>('DELETE', path, undefined, options)
    },

    // ============================================================================
    // Type-safe endpoint methods
    // ============================================================================

    me<T extends UserField>(
      fields: readonly T[],
    ): Promise<ApiResponse<UserDetails<T>>> {
      return request<UserDetails<T>>('GET', '/api/v1/me', undefined, {
        query: { fields: fields.join(',') },
      })
    },

    usage(req: UsageRequest = {}): Promise<ApiResponse<UsageResponse>> {
      // Auth is sent via Authorization header (includeAuth defaults to true)
      return request<UsageResponse>('POST', '/api/v1/usage', {
        fingerprintId: req.fingerprintId ?? 'cli-usage',
      })
    },

    loginCode(req: LoginCodeRequest): Promise<ApiResponse<LoginCodeResponse>> {
      return request<LoginCodeResponse>(
        'POST',
        '/api/auth/cli/code',
        { fingerprintId: req.fingerprintId },
        { includeAuth: false },
      )
    },

    loginStatus(
      req: LoginStatusRequest,
    ): Promise<ApiResponse<LoginStatusResponse>> {
      return request<LoginStatusResponse>('GET', '/api/auth/cli/status', undefined, {
        query: {
          fingerprintId: req.fingerprintId,
          fingerprintHash: req.fingerprintHash,
          expiresAt: req.expiresAt,
        },
        includeAuth: false,
      })
    },

    publish(
      data: Record<string, unknown>[],
      allLocalAgentIds?: string[],
    ): Promise<ApiResponse<PublishAgentsResponse>> {
      // Auth is sent via Authorization header (includeAuth defaults to true)
      return request<PublishAgentsResponse>('POST', '/api/agents/publish', {
        data,
        allLocalAgentIds,
      })
    },

    logout(req: LogoutRequest = {}): Promise<ApiResponse<void>> {
      // Auth is sent via Authorization header (includeAuth defaults to true)
      return request<void>('POST', '/api/auth/cli/logout', {
        userId: req.userId,
        fingerprintId: req.fingerprintId,
        fingerprintHash: req.fingerprintHash,
      })
    },

    feedback(req: FeedbackRequest): Promise<ApiResponse<FeedbackResponse>> {
      return request<FeedbackResponse>('POST', '/api/v1/feedback', req, {
        // Feedback submissions are not idempotent server-side yet, so avoid automatic retries.
        retry: false,
      })
    },
  }
}

// ============================================================================
// Shared singleton client
// ============================================================================

let sharedClient: CodebuffApiClient | null = null
let sharedAuthToken: string | undefined
// Track the token that was used to create the current client instance
let clientCreatedWithToken: string | undefined

/**
 * Get or create the shared API client singleton.
 * The client is lazily created and reused across the application.
 *
 * Note: Always call setApiClientAuthToken() before getApiClient() when you need
 * to ensure a specific auth token is used. The client is recreated whenever
 * the auth token changes.
 */
export function getApiClient(): CodebuffApiClient {
  // Recreate client if it doesn't exist or if the token has changed since creation
  if (!sharedClient || clientCreatedWithToken !== sharedAuthToken) {
    sharedClient = createCodebuffApiClient({ authToken: sharedAuthToken })
    clientCreatedWithToken = sharedAuthToken
  }
  return sharedClient
}

/**
 * Set the auth token for the shared API client.
 * This will cause the next call to getApiClient() to create a new client
 * with the updated token.
 */
export function setApiClientAuthToken(authToken: string | undefined): void {
  sharedAuthToken = authToken
  // Note: We don't eagerly invalidate the client here. Instead, getApiClient()
  // checks if the token has changed and recreates the client if needed.
  // This avoids race conditions where the client is nullified but not yet recreated.
}
