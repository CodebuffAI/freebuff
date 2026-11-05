import { z } from 'zod/v4'

import type { Logger } from '@codebuff/common/types/contracts/logger'

export interface ParallelEnv {
  PARALLEL_API_KEY?: string
}

interface RequestOptions {
  logger: Logger
  fetch: typeof globalThis.fetch
  serverEnv: ParallelEnv
  signal?: AbortSignal
  sessionId?: string
  objective?: string
  live?: boolean
}

// Ten results are included in the Fast request price. Excerpts normally suffice
// for an answer without billing a second request to extract a page.
const MAX_RESULTS = 10
const CHARS_PER_SNIPPET = 1_500
const MAX_RESPONSE_BYTES = 1024 * 1024
// Leave room for auth and transport within the hosted client's 30s deadline.
const REQUEST_TIMEOUT_MS = 20_000
// Parallel's minimum permitted max age is ten minutes. When freshness matters,
// fail closed instead of presenting an older fallback as current evidence.
const LIVE_FETCH_POLICY = {
  max_age_seconds: 600,
  timeout_seconds: 12,
  disable_cache_fallback: true,
}

const httpUrl = z
  .url({ protocol: /^https?$/ })
  .max(8192)
  .refine((raw) => {
    try {
      const url = new URL(raw)
      return !url.username && !url.password
    } catch {
      return false
    }
  })
const pageSchema = z.object({
  url: httpUrl,
  title: z.string().nullish(),
  publish_date: z.string().nullish(),
  excerpts: z.array(z.string()),
})
const searchSchema = z.object({ results: z.array(pageSchema) })
const extractSchema = z.object({
  results: z.array(pageSchema.extend({ full_content: z.string().nullish() })),
  errors: z.array(z.object({ http_status_code: z.number().int().nullish() })),
})

// Enforce the bound on decompressed bytes, including chunked bodies with no
// Content-Length. The request's abort signal also covers reading the stream.
async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing body')
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return JSON.parse(text + decoder.decode())
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('Oversized body')
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

async function request<T>(
  options: RequestOptions,
  operation: 'search' | 'extract',
  body: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const { logger, serverEnv, signal } = options
  const requestUrl = `https://api.parallel.ai/v1/${operation}`
  const context = {
    provider: 'parallel',
    requestUrl,
    live: options.live === true,
  }
  if (!serverEnv.PARALLEL_API_KEY) {
    logger.error(context, 'Web tools require PARALLEL_API_KEY')
    return null
  }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    const response = await options.fetch(requestUrl, {
      method: 'POST',
      // Never forward x-api-key on a redirect.
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': serverEnv.PARALLEL_API_KEY,
      },
      body: JSON.stringify({
        ...body,
        objective: options.objective,
        session_id: options.sessionId,
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) {
      logger.error(
        { ...context, status: response.status },
        `Parallel ${operation} failed with ${response.status}`,
      )
      await response.body?.cancel()
      return null
    }
    const parsed = schema.parse(await readJson(response))
    logger.info(
      { ...context, totalDuration: Date.now() - startedAt },
      `Completed Parallel ${operation}`,
    )
    return parsed
  } catch (error) {
    // The error message, provider response and inputs can all contain user data.
    logger.error(
      {
        ...context,
        error: error instanceof Error ? error.name : 'UnknownError',
        totalDuration: Date.now() - startedAt,
      },
      `Parallel ${operation} request or response failed`,
    )
    return null
  }
}

function pageMetadata(page: z.infer<typeof pageSchema>) {
  return {
    url: page.url,
    title: page.title?.slice(0, 500) || page.url,
    ...(page.publish_date && { publishDate: page.publish_date.slice(0, 32) }),
  }
}

export async function searchWeb(
  options: RequestOptions & { searchQueries: string[] },
) {
  const queries = options.searchQueries.map((query) => query.trim())
  if (
    queries.length < 1 ||
    queries.length > 5 ||
    queries.some((query) => !query || query.length > 200)
  )
    return null
  const response = await request(
    options,
    'search',
    {
      search_queries: queries,
      mode: 'fast',
      max_chars_total: MAX_RESULTS * CHARS_PER_SNIPPET,
      advanced_settings: {
        max_results: MAX_RESULTS,
        excerpt_settings: { max_chars_per_result: CHARS_PER_SNIPPET },
        fetch_policy: options.live ? LIVE_FETCH_POLICY : undefined,
      },
    },
    searchSchema,
  )
  if (!response) return null
  return {
    results: response.results.slice(0, MAX_RESULTS).map((page) => ({
      ...pageMetadata(page),
      snippet: page.excerpts.join('\n\n').slice(0, CHARS_PER_SNIPPET),
    })),
  }
}

export async function fetchWeb(
  options: RequestOptions & { url: string; maxChars?: number },
) {
  if (!httpUrl.safeParse(options.url).success) return null
  const limit = Math.min(50_000, Math.max(1_000, options.maxChars ?? 20_000))
  // With an objective return relevant excerpts. Without one, return the page
  // from the start and keep the redundant excerpt portion of the response small.
  const excerptLimit = options.objective ? limit + 1 : 1_000
  const response = await request(
    options,
    'extract',
    {
      urls: [options.url],
      max_chars_total: excerptLimit,
      advanced_settings: {
        full_content: options.objective
          ? false
          : { max_chars_per_result: limit + 1 },
        excerpt_settings: { max_chars_per_result: excerptLimit },
        fetch_policy: options.live ? LIVE_FETCH_POLICY : undefined,
      },
    },
    extractSchema,
  )
  if (!response) return null
  const page = response.results[0]
  if (!page) {
    // Extract can return 200 with a per-URL failure and no results. Only the
    // status is suitable to echo; the provider's error content is untrusted.
    const status = response.errors[0]?.http_status_code
    return {
      url: options.url,
      error: `Could not retrieve this page${status ? ` (HTTP ${status})` : ''}.`,
    }
  }
  const content = options.objective
    ? page.excerpts.join('\n\n')
    : page.full_content
  if (!content?.trim())
    return {
      url: page.url,
      error: 'No readable content was available for this page.',
    }
  return {
    ...pageMetadata(page),
    content: content.slice(0, limit),
    truncated: content.length > limit,
  }
}
