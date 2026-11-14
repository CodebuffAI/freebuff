import { jsonToolResult } from '@codebuff/common/util/messages'

import { callWebSearchAPI } from '../../../llm-api/codebuff-web-api'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { ClientEnv, CiEnv } from '@codebuff/common/types/contracts/env'
import type { Logger } from '@codebuff/common/types/contracts/logger'

export const handleWebSearch = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<'web_search'>
  logger: Logger
  apiKey: string

  agentStepId: string
  clientSessionId: string
  fingerprintId: string
  repoId: string | undefined
  repoUrl: string | undefined
  userInputId: string
  userId: string | undefined

  fetch: typeof globalThis.fetch
  signal: AbortSignal
  clientEnv: ClientEnv
  ciEnv: CiEnv
}): Promise<{
  output: CodebuffToolOutput<'web_search'>
  creditsUsed: number
}> => {
  const {
    previousToolCallFinished,
    toolCall,

    agentStepId,
    apiKey,
    clientSessionId,
    fingerprintId,
    logger,
    repoId,
    repoUrl,
    userId,
    userInputId,

    fetch,
    signal,
    clientEnv,
    ciEnv,
  } = params
  const { query, objective, additional_queries, live } = toolCall.input

  const searchStartTime = Date.now()
  const searchContext = {
    toolCallId: toolCall.toolCallId,
    queryCount: 1 + (additional_queries?.length ?? 0),
    live: live === true,
    userId,
    agentStepId,
    clientSessionId,
    fingerprintId,
    userInputId,
    repoId,
  }

  await previousToolCallFinished

  let creditsUsed = 0

  try {
    const webApi = await callWebSearchAPI({
      query,
      searchQueries: additional_queries?.length
        ? [query, ...additional_queries]
        : undefined,
      objective,
      live,
      sessionId: clientSessionId,
      signal,
      repoUrl: repoUrl ?? null,
      fetch,
      logger,
      apiKey,
      env: { clientEnv, ciEnv },
    })

    if (webApi.error) {
      const searchDuration = Date.now() - searchStartTime
      logger.warn(
        {
          ...searchContext,
          searchDuration,
          usedWebApi: true,
          success: false,
          error: webApi.error,
        },
        'Web API search returned error',
      )
      return {
        output: jsonToolResult({
          errorMessage: webApi.error,
        }),
        creditsUsed,
      }
    }
    const searchDuration = Date.now() - searchStartTime
    const resultLength = webApi.result?.length || 0
    const hasResults = Boolean(webApi.result && webApi.result.trim())

    // Capture credits used from the API response
    if (typeof webApi.creditsUsed === 'number') {
      creditsUsed = webApi.creditsUsed
    }

    logger.info(
      {
        ...searchContext,
        searchDuration,
        resultLength,
        hasResults,
        usedWebApi: true,
        creditsCharged: 'server',
        creditsUsed,
        success: true,
      },
      'Search completed via web API',
    )

    return {
      output: jsonToolResult({ result: webApi.result ?? '' }),
      creditsUsed,
    }
  } catch (error) {
    const searchDuration = Date.now() - searchStartTime
    const errorMessage = `Error performing web search: ${
      error instanceof Error ? error.message : 'Unknown error'
    }`
    logger.error(
      {
        ...searchContext,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
        searchDuration,
        success: false,
      },
      'Search failed with error',
    )
    return { output: jsonToolResult({ errorMessage }), creditsUsed }
  }
}) satisfies CodebuffToolHandlerFunction<'web_search'>
