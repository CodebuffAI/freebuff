import {
  GENERATE_IMAGE_CLIENT_TIMEOUT_MS,
  GENERATE_IMAGE_MAX_WAIT_MS,
} from '@codebuff/common/tools/params/tool/generate-image'
import { deadlineSignal } from '@codebuff/common/util/promise'
import { z } from 'zod/v4'

import type { ClientEnv, CiEnv } from '@codebuff/common/types/contracts/env'
import type { JSONObject } from '@codebuff/common/types/json'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const FETCH_TIMEOUT_MS = 30_000
const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

/**
 * Thrown by a runtime `fetch` that will never reach the hosted service (a
 * direct BYOK run has no Codebuff allowance). Retrying it cannot succeed, so
 * the tool fails at once instead of after the 1s + 2s network-error backoff.
 */
export class HostedServiceUnavailableError extends Error {
  override name = 'HostedServiceUnavailableError'
}

interface CodebuffWebApiEnv {
  clientEnv: ClientEnv
  ciEnv: CiEnv
}

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const getStringField = (value: unknown, key: string): string | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const field = record[key]
  return typeof field === 'string' ? field : undefined
}

const getNumberField = (value: unknown, key: string): number | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const field = record[key]
  return typeof field === 'number' ? field : undefined
}

const callCodebuffV1 = async (params: {
  endpoint:
    | '/api/v1/web-search'
    | '/api/v1/web-fetch'
    | '/api/v1/docs-search'
    | '/api/v1/gravity-index'
    | '/api/v1/generate-image'
  payload: unknown
  fetch: typeof globalThis.fetch
  logger: Logger
  env: CodebuffWebApiEnv
  baseUrl?: string
  apiKey?: string
  signal?: AbortSignal
  requestName:
    | 'web-search'
    | 'web-fetch'
    | 'docs-search'
    | 'gravity-index'
    | 'generate-image'
}): Promise<{ json?: unknown; error?: string; creditsUsed?: number }> => {
  const { endpoint, payload, fetch, logger, env, requestName } = params
  const baseUrl = params.baseUrl ?? env.clientEnv.NEXT_PUBLIC_CODEBUFF_APP_URL
  const apiKey = params.apiKey ?? env.ciEnv.CODEBUFF_API_KEY

  if (!baseUrl || !apiKey) {
    return { error: 'Missing Codebuff base URL or API key' }
  }

  const url = `${baseUrl}${endpoint}`
  let lastError: string | undefined

  // A disconnected paid request may already have reached the provider. The
  // research routes own their upstream retry policy; never replay the POST.
  // An image is paid per generation the same way.
  const research =
    requestName === 'web-search' ||
    requestName === 'web-fetch' ||
    requestName === 'generate-image'
  const maxAttempts = research ? 1 : MAX_RETRIES
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const deadline = deadlineSignal(
      requestName === 'generate-image'
        ? GENERATE_IMAGE_CLIENT_TIMEOUT_MS
        : FETCH_TIMEOUT_MS,
      params.signal,
    )
    try {
      const res = await fetch(url, {
        method: 'POST',
        // A redirected request could forward the custom API key header.
        ...(research ? { redirect: 'error' as const } : {}),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'x-codebuff-api-key': apiKey,
        },
        body: JSON.stringify(payload),
        signal: deadline.signal,
      })

      const text = await res.text()
      const json = tryParseJson(text)

      if (!res.ok) {
        const err =
          getStringField(json, 'error') ??
          getStringField(json, 'message') ??
          (research
            ? `Web API ${requestName} returned ${res.status}`
            : text || 'Request failed')

        // Retry on transient errors
        if (RETRYABLE_STATUS_CODES.has(res.status) && attempt < maxAttempts) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
          logger.warn(
            {
              url,
              status: res.status,
              statusText: res.statusText,
              attempt,
              maxRetries: maxAttempts,
              nextRetryDelayMs: delay,
            },
            `Web API ${requestName} request failed with retryable status, retrying...`,
          )
          await new Promise((resolve) => setTimeout(resolve, delay))
          lastError = err
          continue
        }

        logger.warn(
          {
            url,
            status: res.status,
            statusText: res.statusText,
            ...(research ? {} : { body: text?.slice(0, 500) }),
            attempt,
          },
          `Web API ${requestName} request failed`,
        )
        return { error: err }
      }

      return { json, creditsUsed: getNumberField(json, 'creditsUsed') }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Network error'
      if (error instanceof HostedServiceUnavailableError) {
        return { error: lastError }
      }

      // Retry on network errors
      if (attempt < maxAttempts) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
        logger.warn(
          {
            error:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : error,
            attempt,
            maxRetries: maxAttempts,
            nextRetryDelayMs: delay,
          },
          `Web API ${requestName} network error, retrying...`,
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }

      logger.error(
        {
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : error,
          attempt,
        },
        `Web API ${requestName} network error after all retries`,
      )
      return { error: lastError }
    } finally {
      deadline.clear()
    }
  }

  return { error: lastError ?? 'Request failed after all retries' }
}

type WebToolClient = {
  fetch: typeof globalThis.fetch
  logger: Logger
  env: CodebuffWebApiEnv
  baseUrl?: string
  apiKey?: string
  signal?: AbortSignal
}

export async function callWebSearchAPI(
  params: WebToolClient & {
    query: string
    searchQueries?: string[]
    objective?: string
    live?: boolean
    sessionId?: string
    repoUrl?: string | null
  },
): Promise<{ result?: string; error?: string; creditsUsed?: number }> {
  const { query, searchQueries, objective, live, sessionId, repoUrl } = params
  const res = await callCodebuffV1({
    ...params,
    endpoint: '/api/v1/web-search',
    payload: {
      query,
      searchQueries,
      objective,
      live,
      sessionId,
      repoUrl: repoUrl ?? undefined,
    },
    requestName: 'web-search',
  })
  if (res.error) return { error: res.error }

  const result = getStringField(res.json, 'result')
  if (result) return { result, creditsUsed: res.creditsUsed }
  return {
    error: getStringField(res.json, 'error') ?? 'Invalid web search response',
  }
}

const generatedImageSchema = z.object({
  url: z.string(),
  width: z.number(),
  height: z.number(),
})
const pendingImageSchema = z.object({ jobId: z.string() })

export async function callGenerateImageAPI(
  params: WebToolClient & {
    prompt: string
    aspectRatio?: string
  },
): Promise<
  { url: string; width: number; height: number } | { errorMessage: string }
> {
  const giveUpAt = Date.now() + GENERATE_IMAGE_MAX_WAIT_MS
  let payload: Record<string, unknown> = {
    prompt: params.prompt,
    aspectRatio: params.aspectRatio,
  }
  for (;;) {
    const res = await callCodebuffV1({
      ...params,
      endpoint: '/api/v1/generate-image',
      payload,
      requestName: 'generate-image',
    })
    if (res.error) return { errorMessage: res.error }
    const image = generatedImageSchema.safeParse(res.json)
    if (image.success) return image.data
    const pending = pendingImageSchema.safeParse(res.json)
    if (!pending.success)
      return { errorMessage: 'Invalid image generation response' }
    if (Date.now() >= giveUpAt)
      return {
        errorMessage:
          'The image is taking too long to generate. Try again later.',
      }
    // Still running at the route's deadline: keep waiting on the same job.
    // Never resubmit the prompt: each new job is a new charge.
    payload = { jobId: pending.data.jobId }
  }
}

const fetchResultSchema = z.union([
  z.object({
    url: z.string(),
    title: z.string().optional(),
    content: z.string(),
    publishDate: z.string().optional(),
    truncated: z.boolean(),
  }),
  z.object({ url: z.string(), error: z.string() }),
])

export async function callWebFetchAPI(
  params: WebToolClient & {
    url: string
    maxChars?: number
    objective?: string
    live?: boolean
    sessionId?: string
  },
) {
  const { url, maxChars, objective, live, sessionId } = params
  const res = await callCodebuffV1({
    ...params,
    endpoint: '/api/v1/web-fetch',
    payload: { url, maxChars, objective, live, sessionId },
    requestName: 'web-fetch',
  })
  const errorMessage = res.error ?? getStringField(res.json, 'error')
  if (errorMessage) return { url, errorMessage }

  const parsed = z.object({ result: fetchResultSchema }).safeParse(res.json)
  if (!parsed.success)
    return { url, errorMessage: 'Invalid web fetch response' }
  const page = parsed.data.result
  if ('error' in page) return { url, errorMessage: page.error }
  const { content: text, ...metadata } = page
  return { ...metadata, text }
}

export async function callDocsSearchAPI(params: {
  libraryTitle: string
  topic?: string
  maxTokens?: number
  repoUrl?: string | null
  fetch: typeof globalThis.fetch
  logger: Logger
  env: CodebuffWebApiEnv
  baseUrl?: string
  apiKey?: string
}): Promise<{ documentation?: string; error?: string; creditsUsed?: number }> {
  const { libraryTitle, topic, maxTokens, repoUrl, fetch, logger, env } = params
  const payload: Record<string, unknown> = { libraryTitle }
  if (topic) payload.topic = topic
  if (typeof maxTokens === 'number') payload.maxTokens = maxTokens
  if (repoUrl) payload.repoUrl = repoUrl

  const res = await callCodebuffV1({
    endpoint: '/api/v1/docs-search',
    payload,
    fetch,
    logger,
    env,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    requestName: 'docs-search',
  })
  if (res.error) return { error: res.error }

  const documentation = getStringField(res.json, 'documentation')
  if (documentation) {
    return { documentation, creditsUsed: res.creditsUsed }
  }

  const error = getStringField(res.json, 'error')
  return { error: error ?? 'Invalid response format' }
}

export async function callGravityIndexAPI(params: {
  input: JSONObject
  fetch: typeof globalThis.fetch
  logger: Logger
  env: CodebuffWebApiEnv
  baseUrl?: string
  apiKey?: string
}): Promise<{
  result?: JSONObject
  error?: string
  creditsUsed?: number
}> {
  const { input, fetch, logger, env } = params

  const res = await callCodebuffV1({
    endpoint: '/api/v1/gravity-index',
    payload: input,
    fetch,
    logger,
    env,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    requestName: 'gravity-index',
  })
  if (res.error) return { error: res.error }

  if (res.json && typeof res.json === 'object' && !Array.isArray(res.json)) {
    return {
      result: res.json as JSONObject,
      creditsUsed: res.creditsUsed,
    }
  }

  const error = getStringField(res.json, 'error')
  return { error: error ?? 'Invalid response format' }
}
