import { jsonToolResult } from '@codebuff/common/util/messages'

import { callGenerateImageAPI } from '../../../llm-api/codebuff-web-api'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { ClientEnv, CiEnv } from '@codebuff/common/types/contracts/env'
import type { Logger } from '@codebuff/common/types/contracts/logger'

/** Runs here, like web_search: the server returns a URL and the agent saves
 * it with its own terminal, so every surface (CLI, VM, device) works alike. */
export const handleGenerateImage = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<'generate_image'>
  logger: Logger
  apiKey: string
  fetch: typeof globalThis.fetch
  signal: AbortSignal
  clientEnv: ClientEnv
  ciEnv: CiEnv
}): Promise<{ output: CodebuffToolOutput<'generate_image'> }> => {
  await params.previousToolCallFinished
  const result = await callGenerateImageAPI({
    prompt: params.toolCall.input.prompt,
    aspectRatio: params.toolCall.input.aspect_ratio,
    imageUrl: params.toolCall.input.image_url,
    signal: params.signal,
    fetch: params.fetch,
    logger: params.logger,
    apiKey: params.apiKey,
    env: { clientEnv: params.clientEnv, ciEnv: params.ciEnv },
  })
  return { output: jsonToolResult(result) }
}) satisfies CodebuffToolHandlerFunction<'generate_image'>
