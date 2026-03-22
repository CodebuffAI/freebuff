
import { PROFIT_MARGIN } from '@codebuff/common/constants/limits'
import { getErrorObject } from '@codebuff/common/util/error'
import { env } from '@codebuff/internal/env'
import { Agent } from 'undici'

import {
  consumeCreditsForMessage,
  extractRequestMetadata,
  insertMessageToBigQuery,
} from './helpers'
import {
  OpenRouterErrorResponseSchema,
  OpenRouterStreamChatCompletionChunkSchema,
} from './type/openrouter'

import type { UsageData } from './helpers'
import type { OpenRouterStreamChatCompletionChunk } from './type/openrouter'
import type {
  ChatCompletionRequestBody,
} from './types'
import type { InsertMessageBigqueryFn } from '@codebuff/common/types/contracts/bigquery'
import type { Logger } from '@codebuff/common/types/contracts/logger'

type StreamState = { responseText: string; reasoningText: string; ttftMs: number | null }

// Extended timeout for deep-thinking models (e.g., gpt-5) that can take
// a long time to start streaming.
const OPENROUTER_HEADERS_TIMEOUT_MS = 10 * 60 * 1000

const openrouterAgent = new Agent({
  headersTimeout: OPENROUTER_HEADERS_TIMEOUT_MS,
  bodyTimeout: 0, // No body timeout for streaming responses
})

/** Result from processing a line, including optional billed credits for final chunk */
type LineResult = {
  state: StreamState
  billedCredits?: number
}

function createOpenRouterRequest(params: {
  body: ChatCompletionRequestBody
  openrouterApiKey: string | null
  fetch: typeof globalThis.fetch
}) {
  const { body, openrouterApiKey, fetch } = params
  return fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openrouterApiKey ?? env.OPEN_ROUTER_API_KEY}`,
      'HTTP-Referer': 'https://codebuff.com',
      'X-Title': 'Codebuff',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    // Use custom agent with extended headers timeout for deep-thinking models
    // @ts-expect-error - dispatcher is a valid undici option not in fetch types
    dispatcher: openrouterAgent,
  })
}

function extractUsageAndCost(usage: any): UsageData {
  const openRouterCost = usage?.cost ?? 0
  const upstreamCost = usage?.cost_details?.upstream_inference_cost ?? 0
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    cost: openRouterCost + upstreamCost,
  }
}

function extractRequestMetadataWithN(params: {
  body: unknown
  logger: Logger
}) {
  const { body, logger } = params
  const { clientId, clientRequestId, costMode } = extractRequestMetadata({ body, logger })
  const typedBody = body as ChatCompletionRequestBody | undefined
  const n = typedBody?.codebuff_metadata?.n
  return { clientId, clientRequestId, costMode, ...(n && { n }) }
}

export async function handleOpenRouterNonStream({
  body,
  userId,
  stripeCustomerId,
  agentId,
  openrouterApiKey,
  fetch,
  logger,
  insertMessageBigquery,
}: {
  body: ChatCompletionRequestBody
  userId: string
  stripeCustomerId?: string | null
  agentId: string
  openrouterApiKey: string | null
  fetch: typeof globalThis.fetch
  logger: Logger
  insertMessageBigquery: InsertMessageBigqueryFn
}) {
  // Ensure usage tracking is enabled
  if (body.usage === undefined) {
    body.usage = {}
  }
  body.usage.include = true

  const startTime = new Date()
  const { clientId, clientRequestId, costMode, n } = extractRequestMetadataWithN({
    body,
    logger,
  })
  const byok = openrouterApiKey !== null

  // If n > 1, make n parallel requests
  if (n && n > 1) {
    const requests = Array.from({ length: n }, () =>
      createOpenRouterRequest({ body, openrouterApiKey, fetch }),
    )

    const responses = await Promise.all(requests)
    if (responses.every((r) => !r.ok)) {
      // Return provider-specific error from the first failed response
      const firstFailedResponse = responses[0]
      throw await parseOpenRouterError(firstFailedResponse)
    }
    const allData = await Promise.all(responses.map((r) => r.json()))

    // Aggregate usage data from all responses
    const responseContents: string[] = []
    const aggregatedUsage: UsageData = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
      cost: 0,
    }

    for (const data of allData) {
      const content = data.choices?.[0]?.message?.content ?? ''
      responseContents.push(content)
      const usageData = extractUsageAndCost(data.usage)
      aggregatedUsage.inputTokens += usageData.inputTokens
      aggregatedUsage.outputTokens += usageData.outputTokens
      aggregatedUsage.cacheReadInputTokens += usageData.cacheReadInputTokens
      aggregatedUsage.reasoningTokens += usageData.reasoningTokens
      aggregatedUsage.cost += usageData.cost
    }

    const responseText = JSON.stringify(responseContents)
    const reasoningText = ''
    const firstData = allData[0]

    // Insert into BigQuery (don't await)
    insertMessageToBigQuery({
      messageId: firstData.id,
      userId,
      startTime,
      request: body,
      reasoningText,
      responseText,
      usageData: aggregatedUsage,
      logger,
      insertMessageBigquery,
    }).catch((error) => {
      logger.error({ error }, 'Failed to insert message into BigQuery')
    })

    // Consume credits and get the actual billed amount
    const billedCredits = await consumeCreditsForMessage({
      messageId: firstData.id,
      userId,
      stripeCustomerId,
      agentId,
      clientId,
      clientRequestId,
      startTime,
      model: firstData.model,
      reasoningText,
      responseText,
      usageData: aggregatedUsage,
      byok,
      logger,
      costMode,
      ttftMs: null, // Non-stream - no TTFT to report
    })

    // Return the first response with aggregated data
    return {
      ...firstData,
      choices: [
        {
          index: 0,
          message: { content: responseText, role: 'assistant' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: aggregatedUsage.inputTokens,
        completion_tokens: aggregatedUsage.outputTokens,
        total_tokens:
          aggregatedUsage.inputTokens + aggregatedUsage.outputTokens,
        // Overwrite cost so SDK calculates exact credits we charged
        cost: creditsToFakeCost(billedCredits),
        cost_details: { upstream_inference_cost: 0 },
      },
    }
  }

  // Single request logic
  const response = await createOpenRouterRequest({
    body,
    openrouterApiKey,
    fetch,
  })

  if (!response.ok) {
    throw await parseOpenRouterError(response)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content ?? ''
  const reasoningText = data.choices?.[0]?.message?.reasoning ?? ''
  const usageData = extractUsageAndCost(data.usage)

  // Insert into BigQuery (don't await)
  insertMessageToBigQuery({
    messageId: data.id,
    userId,
    startTime,
    request: body,
    reasoningText,
    responseText: content,
    usageData,
    logger,
    insertMessageBigquery,
  }).catch((error) => {
    logger.error({ error }, 'Failed to insert message into BigQuery')
  })

  // Consume credits and get the actual billed amount
  const billedCredits = await consumeCreditsForMessage({
    messageId: data.id,
    userId,
    stripeCustomerId,
    agentId,
    clientId,
    clientRequestId,
    startTime,
    model: data.model,
    reasoningText,
    responseText: content,
    usageData,
    byok,
    logger,
    costMode,
    ttftMs: null, // Non-stream - no TTFT to report
  })

  // Overwrite cost so SDK calculates exact credits we charged
  if (data.usage) {
    data.usage.cost = creditsToFakeCost(billedCredits)
    data.usage.cost_details = { upstream_inference_cost: 0 }
  }

  return data
}

export async function handleOpenRouterStream({
  body,
  userId,
  stripeCustomerId,
  agentId,
  openrouterApiKey,
  fetch,
  logger,
  insertMessageBigquery,
}: {
  body: ChatCompletionRequestBody
  userId: string
  stripeCustomerId?: string | null
  agentId: string
  openrouterApiKey: string | null
  fetch: typeof globalThis.fetch
  logger: Logger
  insertMessageBigquery: InsertMessageBigqueryFn
}) {
  // Ensure usage tracking is enabled
  if (body.usage === undefined) {
    body.usage = {}
  }
  body.usage.include = true

  const startTime = new Date()
  const { clientId, clientRequestId, costMode } = extractRequestMetadata({ body, logger })

  const byok = openrouterApiKey !== null
  const response = await createOpenRouterRequest({
    body,
    openrouterApiKey,
    fetch,
  })

  if (!response.ok) {
    throw await parseOpenRouterError(response)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Failed to get response reader')
  }

  let heartbeatInterval: NodeJS.Timeout
  let state: StreamState = { responseText: '', reasoningText: '', ttftMs: null }
  let clientDisconnected = false

  // Create a ReadableStream that Next.js can handle
  const stream = new ReadableStream({
    async start(controller) {
      const decoder = new TextDecoder()
      let buffer = ''

      // Send initial connection message
      controller.enqueue(
        new TextEncoder().encode(`: connected ${new Date().toISOString()}\n`),
      )

      // Start heartbeat
      heartbeatInterval = setInterval(() => {
        if (!clientDisconnected) {
          try {
            controller.enqueue(
              new TextEncoder().encode(
                `: heartbeat ${new Date().toISOString()}\n\n`,
              ),
            )
          } catch {
            // client disconnected, ignore error
          }
        }
      }, 30000)

      try {
        let done = false
        while (!done) {
          const result = await reader.read()
          done = result.done
          const value = result.value

          if (done) {
            break
          }

          buffer += decoder.decode(value, { stream: true })
          let lineEnd = buffer.indexOf('\n')

          while (lineEnd !== -1) {
            const line = buffer.slice(0, lineEnd + 1)
            buffer = buffer.slice(lineEnd + 1)

            const lineResult = await handleLine({
              userId,
              stripeCustomerId,
              agentId,
              clientId,
              clientRequestId,
              costMode,
              byok,
              startTime,
              request: body,
              line,
              state,
              logger,
              insertMessage: insertMessageBigquery,
            })
            state = lineResult.state

            if (!clientDisconnected) {
              try {
                // Overwrite cost in final chunk so SDK calculates exact credits we charged
                const lineToSend = lineResult.billedCredits !== undefined
                  ? overwriteCostWithBilledCredits(line, lineResult.billedCredits)
                  : line
                controller.enqueue(new TextEncoder().encode(lineToSend))
              } catch (error) {
                logger.warn(
                  'Client disconnected during stream, continuing for billing',
                )
                clientDisconnected = true
              }
            }

            lineEnd = buffer.indexOf('\n')
          }
        }

        if (!clientDisconnected) {
          controller.close()
        }
      } catch (error) {
        if (!clientDisconnected) {
          controller.error(error)
        } else {
          logger.warn(
            getErrorObject(error),
            'Error after client disconnect in OpenRouter stream',
          )
        }
      } finally {
        clearInterval(heartbeatInterval)
      }
    },
    cancel() {
      clearInterval(heartbeatInterval)
      clientDisconnected = true
      // Log truncated state to prevent OOM during logging (state can be up to 2MB)
      logger.warn(
        {
          clientDisconnected,
          responseTextLength: state.responseText.length,
          reasoningTextLength: state.reasoningText.length,
        },
        'Client cancelled stream, continuing OpenRouter consumption for billing',
      )
    },
  })

  return stream
}

/**
 * Attempt to parse and recover from truncated/malformed JSON responses.
 * Some models like kimi-k2 may send incomplete JSON at newline boundaries.
 * This function tries to recover common truncation patterns.
 */
function attemptJSONParse(raw: string): unknown | null {
  // First attempt: parse as-is
  try {
    return JSON.parse(raw)
  } catch (e) {
    // Silent fail, will try recovery below
  }

  // Recovery attempt 1: Remove trailing newline if present
  const trimmed = raw.trimEnd()
  if (trimmed !== raw) {
    try {
      return JSON.parse(trimmed)
    } catch (e) {
      // Continue to next recovery attempt
    }
  }

  // Recovery attempt 2: Try to close incomplete JSON structures
  // This handles cases where JSON is truncated mid-object or mid-array
  const recoveryAttempts = [
    trimmed + '}',      // Close single object
    trimmed + ']}',     // Close nested array in object
    trimmed + '}]}',    // Close nested structures
    trimmed + '[]',     // Complete empty array
  ]

  for (const attempt of recoveryAttempts) {
    try {
      return JSON.parse(attempt)
    } catch (e) {
      // Continue to next attempt
    }
  }

  // All recovery attempts failed
  return null
}

async function handleLine({
  userId,
  stripeCustomerId,
  agentId,
  clientId,
  clientRequestId,
  costMode,
  byok,
  startTime,
  request,
  line,
  state,
  logger,
  insertMessage,
}: {
  userId: string
  stripeCustomerId?: string | null
  agentId: string
  clientId: string | null
  clientRequestId: string | null
  costMode: string | undefined
  byok: boolean
  startTime: Date
  request: unknown
  line: string
  state: StreamState
  logger: Logger
  insertMessage: InsertMessageBigqueryFn
}): Promise<LineResult> {
  if (!line.startsWith('data: ')) {
    return { state }
  }

  const raw = line.slice('data: '.length)
  if (raw === '[DONE]\n') {
    return { state }
  }

  // Parse the string into an object with defensive recovery
  let obj = attemptJSONParse(raw)
  if (obj === null) {
    // All parsing attempts failed - log with detailed context for debugging
    logger.debug(
      {
        rawLength: raw.length,
        rawPreview: raw.slice(0, 200),
        error: 'JSON parsing failed after recovery attempts',
      },
      'Could not parse OpenRouter response - may be truncated chunk from model like kimi-k2',
    )
    return { state }
  }

  // Validate against schema, but be lenient with model quirks
  const parsed = OpenRouterStreamChatCompletionChunkSchema.safeParse(obj)
  if (!parsed.success) {
    // Schema validation failed - check if it's an error response or just malformed
    // Some models send slightly different formats that we should still attempt to handle
    const isErrorLike = obj && typeof obj === 'object' && 'error' in obj

    if (isErrorLike) {
      // Try to handle as error even if schema doesn't match perfectly
      logger.warn(
        {
          error: getErrorObject(parsed.error, { includeRawError: true }),
          rawObject: JSON.stringify(obj).slice(0, 500),
        },
        'OpenRouter response matches error pattern but schema validation failed',
      )
      // handleResponse already returns { state } for error data, so skip processing
      return { state }
    }

    // Not an error, likely a malformed chunk - log and skip
    logger.debug(
      {
        error: getErrorObject(parsed.error, { includeRawError: true }),
        rawPreview: JSON.stringify(obj).slice(0, 300),
      },
      'OpenRouter response failed schema validation - skipping malformed chunk (may be truncated from streaming)',
    )
    return { state }
  }

  return handleResponse({
    userId,
    stripeCustomerId,
    agentId,
    clientId,
    clientRequestId,
    costMode,
    byok,
    startTime,
    request,
    data: parsed.data,
    state,
    logger,
    insertMessage,
  })
}

async function handleResponse({
  userId,
  stripeCustomerId,
  agentId,
  clientId,
  clientRequestId,
  costMode,
  byok,
  startTime,
  request,
  data,
  state,
  logger,
  insertMessage,
}: {
  userId: string
  stripeCustomerId?: string | null
  agentId: string
  clientId: string | null
  clientRequestId: string | null
  costMode: string | undefined
  byok: boolean
  startTime: Date
  request: unknown
  data: OpenRouterStreamChatCompletionChunk
  state: StreamState
  logger: Logger
  insertMessage: InsertMessageBigqueryFn
}): Promise<LineResult> {
  const model = 'model' in data ? data.model : undefined
  state = await handleStreamChunk({
    data,
    state,
    startTime,
    logger,
    userId,
    agentId,
    model,
  })

  if ('error' in data || !data.usage) {
    // Stream not finished
    return { state }
  }

  const usageData = extractUsageAndCost(data.usage)

  // Insert into BigQuery (don't await)
  insertMessageToBigQuery({
    messageId: data.id,
    userId,
    startTime,
    request,
    reasoningText: state.reasoningText,
    responseText: state.responseText,
    usageData,
    logger,
    insertMessageBigquery: insertMessage,
  }).catch((error) => {
    logger.error({ error }, 'Failed to insert message into BigQuery')
  })

  // Consume credits and get the actual billed amount
  const billedCredits = await consumeCreditsForMessage({
    messageId: data.id,
    userId,
    stripeCustomerId,
    agentId,
    clientId,
    clientRequestId,
    startTime,
    model: data.model,
    reasoningText: state.reasoningText,
    responseText: state.responseText,
    usageData,
    byok,
    logger,
    costMode,
    ttftMs: state.ttftMs,
  })

  return { state, billedCredits }
}

async function handleStreamChunk({
  data,
  state,
  startTime,
  logger,
  userId,
  agentId,
  model,
}: {
  data: OpenRouterStreamChatCompletionChunk
  state: StreamState
  startTime: Date
  logger: Logger
  userId: string
  agentId: string
  model: string | undefined
}): Promise<StreamState> {
  // Define a safe buffer limit to prevent OOM errors on the server while
  // still storing enough data for logging and billing. 1MB is a generous limit.
  const MAX_BUFFER_SIZE = 1 * 1024 * 1024 // 1MB

  if ('error' in data) {
    // Log detailed error information for stream errors (e.g., Forbidden from Anthropic)
    const errorData = data.error as {
      code?: string | number | null
      type?: string | null
      message: string
      param?: unknown
      metadata?: { raw?: string; provider_name?: string }
    }
    logger.error(
      {
        userId,
        agentId,
        model,
        errorCode: errorData.code,
        errorType: errorData.type,
        errorMessage: errorData.message,
        errorParam: errorData.param,
        // Provider-specific error details (e.g., from Anthropic via OpenRouter)
        providerName: errorData.metadata?.provider_name,
        providerRawError: errorData.metadata?.raw,
      },
      'Received error chunk in OpenRouter stream',
    )
    return state
  }

  if (!data.choices || !Array.isArray(data.choices) || !data.choices.length) {
    logger.debug(
      {
        hasChoices: 'choices' in data,
        choicesLength: Array.isArray(data.choices) ? data.choices.length : 'N/A',
        streamChunk: JSON.stringify(data).slice(0, 500),
      },
      'Received empty/missing choices from OpenRouter - likely truncated streaming chunk',
    )
    return state
  }
  const choice = data.choices[0]

  // Track time to first token (TTFT) - set on first meaningful delta (content, reasoning, or tool_calls)
  const hasContentDelta = choice?.delta?.content != null && choice?.delta?.content !== ''
  const hasReasoningDelta = choice?.delta?.reasoning != null && choice?.delta?.reasoning !== ''
  const hasToolCallsDelta = choice?.delta?.tool_calls != null && (choice?.delta?.tool_calls as unknown[])?.length > 0
  if (state.ttftMs === null && (hasContentDelta || hasReasoningDelta || hasToolCallsDelta)) {
    state.ttftMs = Date.now() - startTime.getTime()
  }

  // Append content and reasoning, but only up to the buffer limit.
  const contentDelta = choice.delta?.content ?? ''
  if (state.responseText.length < MAX_BUFFER_SIZE) {
    state.responseText += contentDelta
    if (state.responseText.length >= MAX_BUFFER_SIZE) {
      state.responseText =
        state.responseText.slice(0, MAX_BUFFER_SIZE) + '\n---[TRUNCATED]---'
      logger.warn(
        { userId, agentId, model },
        'Response text buffer truncated at 1MB',
      )
    }
  }

  const reasoningDelta = choice.delta?.reasoning ?? ''
  if (state.reasoningText.length < MAX_BUFFER_SIZE) {
    state.reasoningText += reasoningDelta
    if (state.reasoningText.length >= MAX_BUFFER_SIZE) {
      state.reasoningText =
        state.reasoningText.slice(0, MAX_BUFFER_SIZE) + '\n---[TRUNCATED]---'
      logger.warn(
        { userId, agentId, model },
        'Reasoning text buffer truncated at 1MB',
      )
    }
  }

  return state
}

/**
 * Custom error class for OpenRouter API errors that preserves provider-specific details.
 */
export class OpenRouterError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    public readonly errorBody: {
      error: {
        message: string
        code: string | number | null
        type?: string | null
        param?: unknown
        metadata?: {
          raw?: string
          provider_name?: string
        }
      }
    },
  ) {
    super(errorBody.error.message)
    this.name = 'OpenRouterError'
  }

  /**
   * Returns the error in a format suitable for API responses.
   */
  toJSON() {
    return {
      error: {
        message: this.errorBody.error.message,
        code: this.errorBody.error.code,
        type: this.errorBody.error.type,
        param: this.errorBody.error.param,
        metadata: this.errorBody.error.metadata,
      },
    }
  }
}

/**
 * Builds an enhanced error message that includes provider metadata when available.
 */
function buildEnhancedErrorMessage(
  baseMessage: string,
  metadata?: { raw?: string; provider_name?: string },
): string {
  if (!metadata?.raw) {
    return baseMessage
  }
  const providerLabel = metadata.provider_name ?? 'Provider details'
  const maxRawLength = 1000
  const truncatedRaw =
    metadata.raw.length > maxRawLength
      ? metadata.raw.slice(0, maxRawLength) + '...'
      : metadata.raw
  return `${baseMessage} [${providerLabel}: ${truncatedRaw}]`
}

/**
 * Parses an error response from OpenRouter and returns an OpenRouterError.
 */
async function parseOpenRouterError(
  response: Response,
): Promise<OpenRouterError> {
  const errorText = await response.text()
  let errorBody: OpenRouterError['errorBody']
  try {
    const parsed = JSON.parse(errorText)
    const validated = OpenRouterErrorResponseSchema.safeParse(parsed)
    if (validated.success) {
      // metadata is not in the schema but OpenRouter includes it for provider errors
      const metadata = (parsed as any).error?.metadata as
        | { raw?: string; provider_name?: string }
        | undefined
      const enhancedMessage = buildEnhancedErrorMessage(
        validated.data.error.message,
        metadata,
      )
      errorBody = {
        error: {
          message: enhancedMessage,
          code: validated.data.error.code ?? null,
          type: validated.data.error.type,
          param: validated.data.error.param,
          metadata,
        },
      }
    } else {
      errorBody = {
        error: {
          message: errorText || response.statusText,
          code: response.status,
        },
      }
    }
  } catch {
    errorBody = {
      error: {
        message: errorText || response.statusText,
        code: response.status,
      },
    }
  }
  return new OpenRouterError(response.status, response.statusText, errorBody)
}

/**
 * Convert credits (integer cents) back to a cost value that will result in the same
 * credits when the SDK applies its formula: credits = Math.round(cost * (1 + PROFIT_MARGIN) * 100)
 */
function creditsToFakeCost(credits: number): number {
  return credits / ((1 + PROFIT_MARGIN) * 100)
}

/**
 * Overwrite the cost field in the final SSE chunk to reflect actual billed credits.
 * This ensures the SDK calculates the exact credits value we stored in the database,
 * making the server the single source of truth for credit tracking.
 */
function overwriteCostWithBilledCredits(line: string, billedCredits: number): string {
  if (!line.startsWith('data: ')) {
    return line
  }

  const raw = line.slice('data: '.length)
  if (raw === '[DONE]\n' || raw === '[DONE]') {
    return line
  }

  try {
    const obj = JSON.parse(raw)
    // Only modify if there's usage data (final chunk)
    if (obj.usage) {
      obj.usage.cost = creditsToFakeCost(billedCredits)
      obj.usage.cost_details = { upstream_inference_cost: 0 }
      return `data: ${JSON.stringify(obj)}\n`
    }
  } catch {
    // If parsing fails, return original line
  }

  return line
}
