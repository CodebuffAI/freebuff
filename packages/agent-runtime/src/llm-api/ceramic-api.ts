import { z } from 'zod/v4'

import type { Logger } from '@codebuff/common/types/contracts/logger'

export interface CeramicEnv {
  CERAMIC_API_KEY?: string
}

const CERAMIC_SEARCH_URL = 'https://api.ceramic.ai/search'
// Leave room inside the hosted client's 30-second deadline for auth and transport.
const FETCH_TIMEOUT_MS = 20_000
const MAX_DESCRIPTION_LENGTH = 1_000

/** Return guidance the agent can act on, without silently changing identifiers.
 * https://docs.ceramic.ai/api/search/best-practices#unsupported-query-content
 */
export function getCeramicQueryError(query: string): string | null {
  const words = query.trim().split(/\s+/)
  if (!query.trim() || words.length > 50) {
    return 'Rewrite the web search query as 1–50 English keywords.'
  }
  if (/[/\\]/.test(query)) {
    return 'Web search does not support slashes, including package names, imports, URLs, and file paths. Rewrite them as keywords: "next/navigation useRouter" → "Nextjs useRouter", "@tanstack/react-query" → "tanstack react-query". Use read_url for a known URL.'
  }
  if (/\d,\d/.test(query)) {
    return 'Web search does not support numbers with commas. Rewrite the query with ungrouped digits, for example "101,342" → "101342".'
  }
  // Keep Latin accents, combining marks, and ordinary search punctuation.
  if (/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(query)) {
    return 'Web search supports English pages and cannot search non-Latin scripts. Translate the query into English keywords or transliterate names, then retry. Use read_url for a known source URL.'
  }
  return null
}

const searchResponseSchema = z.object({
  result: z.object({
    results: z.array(
      z.object({
        title: z.string(),
        url: z.url().refine((url) => /^https?:\/\//i.test(url)),
        description: z.string(),
      }),
    ),
  }),
})

export async function searchWeb(options: {
  query: string
  depth?: 'standard' | 'deep'
  logger: Logger
  fetch: typeof globalThis.fetch
  serverEnv: CeramicEnv
}): Promise<string | null> {
  const { depth = 'standard', logger, fetch, serverEnv } = options
  const query = options.query.trim().replace(/\s+/g, ' ')
  const context = { provider: 'ceramic', requestUrl: CERAMIC_SEARCH_URL, depth }
  if (!serverEnv.CERAMIC_API_KEY) {
    logger.error(context, 'Web search requires CERAMIC_API_KEY')
    return null
  }
  const queryError = getCeramicQueryError(query)
  if (queryError) {
    logger.warn(context, queryError)
    return null
  }

  const startedAt = Date.now()
  const maxResults = depth === 'deep' ? 20 : 10
  try {
    const response = await fetch(CERAMIC_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serverEnv.CERAMIC_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        maxResults,
        maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
      }),
      // Covers reading the response body as well as receiving the headers.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      logger.error(
        {
          ...context,
          status: response.status,
          totalDuration: Date.now() - startedAt,
        },
        `Ceramic search failed with ${response.status}`,
      )
      await response.body?.cancel()
      return null
    }
    const parsed = searchResponseSchema.safeParse(await response.json())
    if (!parsed.success) {
      logger.error(context, 'Invalid response format from Ceramic')
      return null
    }
    const results = parsed.data.result.results
      .slice(0, maxResults)
      .map((item) => ({
        title: item.title.slice(0, 500),
        url: item.url,
        snippet: item.description.slice(0, MAX_DESCRIPTION_LENGTH),
      }))
    logger.info(
      {
        ...context,
        resultCount: results.length,
        totalDuration: Date.now() - startedAt,
      },
      'Completed web search',
    )
    return JSON.stringify({ results }, null, 2)
  } catch (error) {
    logger.error(
      {
        ...context,
        error: error instanceof Error ? error.name : 'UnknownError',
        totalDuration: Date.now() - startedAt,
      },
      'Network or response failure during Ceramic search',
    )
    return null
  }
}
