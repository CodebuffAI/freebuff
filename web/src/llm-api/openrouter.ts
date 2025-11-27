import { getErrorObject } from '@codebuff/common/util/error'
import { env } from '@codebuff/internal/env'

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
import type { InsertMessageBigqueryFn } from '@codebuff/common/types/contracts/bigquery'
import type { Logger } from '@codebuff/common/types/contracts/logger'

type StreamState = { responseText: string; reasoningText: string }
function createOpenRouterRequest(params: {
  body: any
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
  const { clientId, clientRequestId } = extractRequestMetadata({ body, logger })
  const n = (body as any)?.codebuff_metadata?.n
  return { clientId, clientRequestId, ...(n && { n }) }
}

export async function handleOpenRouterNonStream({
  body,
  userId,
  agentId,
  openrouterApiKey,
  fetch,
  logger,
  insertMessageBigquery,
}: {
  body: any
  userId: string
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
  const { clientId, clientRequestId, n } = extractRequestMetadataWithN({
    body,
    logger,
  })
  const byok = openrouterApiKey !== null

  // If n > 1, make n parallel requests
  if (n > 1) {
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

    // Consume credits
    await consumeCreditsForMessage({
      messageId: firstData.id,
      userId,
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
        cost: aggregatedUsage.cost,
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

  // Consume credits
  await consumeCreditsForMessage({
    messageId: data.id,
    userId,
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
  })

  return data
}

export async function handleOpenRouterStream({
  body,
  userId,
  agentId,
  openrouterApiKey,
  fetch,
  logger,
  insertMessageBigquery,
}: {
  body: any
  userId: string
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
  const { clientId, clientRequestId } = extractRequestMetadata({ body, logger })

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
  let state: StreamState = { responseText: '', reasoningText: '' }
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
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            break
          }

          buffer += decoder.decode(value, { stream: true })
          let lineEnd = buffer.indexOf('\n')

          while (lineEnd !== -1) {
            const line = buffer.slice(0, lineEnd + 1)
            buffer = buffer.slice(lineEnd + 1)

            state = await handleLine({
              userId,
              agentId,
              clientId,
              clientRequestId,
              byok,
              startTime,
              request: body,
              line,
              state,
              logger,
              insertMessage: insertMessageBigquery,
            })

            if (!clientDisconnected) {
              try {
                controller.enqueue(new TextEncoder().encode(line))
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
      logger.warn(
        { clientDisconnected, state },
        'Client cancelled stream, continuing OpenRouter consumption for billing',
      )
    },
  })

  return stream
}

async function handleLine({
  userId,
  agentId,
  clientId,
  clientRequestId,
  byok,
  startTime,
  request,
  line,
  state,
  logger,
  insertMessage,
}: {
  userId: string
  agentId: string
  clientId: string | null
  clientRequestId: string | null
  byok: boolean
  startTime: Date
  request: unknown
  line: string
  state: StreamState
  logger: Logger
  insertMessage: InsertMessageBigqueryFn
}): Promise<StreamState> {
  if (!line.startsWith('data: ')) {
    return state
  }

  const raw = line.slice('data: '.length)
  if (raw === '[DONE]\n') {
    return state
  }

  // Parse the string into an object
  let obj
  try {
    obj = JSON.parse(raw)
  } catch (error) {
    logger.warn(
      `Received non-JSON OpenRouter response: ${JSON.stringify(getErrorObject(error), null, 2)}`,
    )
    return state
  }

  // Extract usage
  const parsed = OpenRouterStreamChatCompletionChunkSchema.safeParse(obj)
  if (!parsed.success) {
    logger.warn(
      `Unable to parse OpenRotuer response: ${JSON.stringify(getErrorObject(parsed.error), null, 2)}`,
    )
    return state
  }

  return await handleResponse({
    userId,
    agentId,
    clientId,
    clientRequestId,
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
  agentId,
  clientId,
  clientRequestId,
  byok,
  startTime,
  request,
  data,
  state,
  logger,
  insertMessage,
}: {
  userId: string
  agentId: string
  clientId: string | null
  clientRequestId: string | null
  byok: boolean
  startTime: Date
  request: unknown
  data: OpenRouterStreamChatCompletionChunk
  state: StreamState
  logger: Logger
  insertMessage: InsertMessageBigqueryFn
}): Promise<StreamState> {
  state = await handleStreamChunk({ data, state, logger })

  if ('error' in data || !data.usage) {
    // Stream not finished
    return state
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

  await consumeCreditsForMessage({
    messageId: data.id,
    userId,
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
  })

  return state
}

async function handleStreamChunk({
  data,
  state,
  logger,
}: {
  data: OpenRouterStreamChatCompletionChunk
  state: StreamState
  logger: Logger
}): Promise<StreamState> {
  if ('error' in data) {
    logger.warn({ streamChunk: data }, 'Received error from OpenRouter')
    return state
  }

  if (!data.choices.length) {
    logger.warn({ streamChunk: data }, 'Received empty choices from OpenRouter')
  }
  const choice = data.choices[0]
  state.responseText += choice.delta?.content ?? ''
  state.reasoningText += choice.delta?.reasoning ?? ''
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
      errorBody = {
        error: {
          message: validated.data.error.message,
          code: validated.data.error.code ?? null,
          type: validated.data.error.type,
          param: validated.data.error.param,
          // metadata is not in the schema but OpenRouter includes it for provider errors
          metadata: (parsed as any).error?.metadata,
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
