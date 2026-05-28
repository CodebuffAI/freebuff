import { Agent } from 'undici'

import { PROFIT_MARGIN } from '@codebuff/common/constants/limits'
import { deepseekModels } from '@codebuff/common/constants/model-config'
import { getErrorObject } from '@codebuff/common/util/error'
import { env } from '@codebuff/internal/env'

import {
  consumeCreditsForMessage,
  createRequestAuditRecord,
  extractRequestMetadata,
  insertMessageToBigQuery,
} from './helpers'
import {
  buildDeepSeekRequestBody,
  DEEPSEEK_MODEL_IDS,
} from './deepseek-request-body'
import {
  isLikelyDeepSeekOutage,
  recordDeepSeekFailure,
  recordDeepSeekSuccess,
} from './deepseek-health'

import type { UsageData } from './helpers'
import type { InsertMessageBigqueryFn } from '@codebuff/common/types/contracts/bigquery'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ChatCompletionRequestBody } from './types'

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

// Extended timeout for deep-thinking models that can take
// a long time to start streaming.
const DEEPSEEK_HEADERS_TIMEOUT_MS = 30 * 60 * 1000

// Tighter TTFB timeout for the non-reasoning Flash model so that when DeepSeek
// is unreachable we surface a failure within seconds instead of holding the
// connection open for half an hour. This feeds the circuit breaker which then
// fails open to Fireworks for subsequent requests.
const DEEPSEEK_FLASH_HEADERS_TIMEOUT_MS = 60 * 1000

const deepseekAgent = new Agent({
  headersTimeout: DEEPSEEK_HEADERS_TIMEOUT_MS,
  bodyTimeout: 0,
})

const deepseekFlashAgent = new Agent({
  headersTimeout: DEEPSEEK_FLASH_HEADERS_TIMEOUT_MS,
  bodyTimeout: 0,
})

function getDeepSeekDispatcher(model: string): Agent {
  return isDeepSeekV4FlashModel(model) ? deepseekFlashAgent : deepseekAgent
}

// DeepSeek per-token pricing (dollars per token)
interface DeepSeekPricing {
  inputCostPerToken: number
  cachedInputCostPerToken: number
  outputCostPerToken: number
}

const DEEPSEEK_V4_PRO_PRICING: DeepSeekPricing = {
  inputCostPerToken: 0.435 / 1_000_000,
  cachedInputCostPerToken: 0.003625 / 1_000_000,
  outputCostPerToken: 0.87 / 1_000_000,
}

const DEEPSEEK_V4_FLASH_PRICING: DeepSeekPricing = {
  inputCostPerToken: 0.14 / 1_000_000,
  cachedInputCostPerToken: 0.0028 / 1_000_000,
  outputCostPerToken: 0.28 / 1_000_000,
}

const DEEPSEEK_PRICING_BY_DIRECT_MODEL_ID: Record<string, DeepSeekPricing> = {
  [deepseekModels.deepseekV4ProDirect]: DEEPSEEK_V4_PRO_PRICING,
  [deepseekModels.deepseekV4FlashDirect]: DEEPSEEK_V4_FLASH_PRICING,
}

const DEEPSEEK_MODELS: Record<
  string,
  { deepseekId: string; pricing: DeepSeekPricing }
> = Object.fromEntries(
  Object.entries(DEEPSEEK_MODEL_IDS).map(([model, deepseekId]) => [
    model,
    {
      deepseekId,
      pricing: getPricingForDeepSeekId(deepseekId),
    },
  ]),
)

const DEEPSEEK_ROUTED_MODELS = new Set<string>(Object.keys(DEEPSEEK_MODELS))

export function isDeepSeekModel(model: string): boolean {
  return DEEPSEEK_ROUTED_MODELS.has(model)
}

function isDeepSeekV4FlashModel(model: string): boolean {
  return (
    model === deepseekModels.deepseekV4Flash ||
    model === deepseekModels.deepseekV4FlashDirect
  )
}

/** Wraps createDeepSeekRequest so that transient outages (network, timeout,
 *  5xx) feed the circuit breaker and a healthy response resets it. 4xx
 *  request errors (bad input, auth) are NOT counted as outages. */
async function createDeepSeekRequestTracked(params: {
  body: ChatCompletionRequestBody
  originalModel: string
  fetch: typeof globalThis.fetch
}): Promise<Response> {
  let response: Response
  try {
    response = await createDeepSeekRequest(params)
  } catch (error) {
    if (isLikelyDeepSeekOutage(error)) {
      recordDeepSeekFailure({
        model: params.originalModel,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  }
  if (isLikelyDeepSeekOutage(undefined, response.status)) {
    recordDeepSeekFailure({
      model: params.originalModel,
      reason: `HTTP ${response.status}`,
      statusCode: response.status,
    })
  } else if (response.ok) {
    recordDeepSeekSuccess()
  }
  return response
}

function getDeepSeekPricing(model: string): DeepSeekPricing {
  const entry = DEEPSEEK_MODELS[model]
  if (!entry) {
    throw new Error(`No DeepSeek pricing found for model: ${model}`)
  }
  return entry.pricing
}

function getPricingForDeepSeekId(deepseekId: string): DeepSeekPricing {
  const pricing = DEEPSEEK_PRICING_BY_DIRECT_MODEL_ID[deepseekId]
  if (!pricing) {
    throw new Error(`No DeepSeek pricing found for direct model: ${deepseekId}`)
  }
  return pricing
}

type StreamState = {
  responseText: string
  reasoningText: string
  ttftMs: number | null
  billedAlready: boolean
}

type LineResult = {
  state: StreamState
  billedCredits?: number
  patchedLine: string
}

export function createDeepSeekRequest(params: {
  body: ChatCompletionRequestBody
  originalModel: string
  fetch: typeof globalThis.fetch
}) {
  const { body, originalModel, fetch } = params
  const deepseekBody = buildDeepSeekRequestBody(body, originalModel)

  if (!env.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is not configured')
  }

  return fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(deepseekBody),
    // @ts-expect-error - dispatcher is a valid undici option not in fetch types
    dispatcher: getDeepSeekDispatcher(originalModel),
  })
}

function extractUsageAndCost(
  usage: Record<string, unknown> | undefined | null,
  model: string,
): UsageData {
  if (!usage)
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
      cost: 0,
    }
  const completionDetails = usage.completion_tokens_details as
    | Record<string, unknown>
    | undefined
    | null

  const inputTokens =
    typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const outputTokens =
    typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  const cacheReadInputTokens =
    typeof usage.prompt_cache_hit_tokens === 'number'
      ? usage.prompt_cache_hit_tokens
      : 0
  const reasoningTokens =
    typeof completionDetails?.reasoning_tokens === 'number'
      ? completionDetails.reasoning_tokens
      : 0

  const pricing = getDeepSeekPricing(model)
  const nonCachedInputTokens = Math.max(0, inputTokens - cacheReadInputTokens)
  const cost =
    nonCachedInputTokens * pricing.inputCostPerToken +
    cacheReadInputTokens * pricing.cachedInputCostPerToken +
    outputTokens * pricing.outputCostPerToken

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    reasoningTokens,
    cost,
  }
}

export async function handleDeepSeekNonStream({
  body,
  userId,
  stripeCustomerId,
  agentId,
  fetch,
  logger,
  insertMessageBigquery,
}: {
  body: ChatCompletionRequestBody
  userId: string
  stripeCustomerId?: string | null
  agentId: string
  fetch: typeof globalThis.fetch
  logger: Logger
  insertMessageBigquery: InsertMessageBigqueryFn
}) {
  const originalModel = body.model
  const startTime = new Date()
  const { clientId, clientRequestId, costMode } = extractRequestMetadata({
    body,
    logger,
  })
  const auditRequest = createRequestAuditRecord(body)

  const response = await createDeepSeekRequestTracked({
    body,
    originalModel,
    fetch,
  })

  if (!response.ok) {
    throw await parseDeepSeekError(response)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content ?? ''
  const reasoningText =
    data.choices?.[0]?.message?.reasoning_content ??
    data.choices?.[0]?.message?.reasoning ??
    ''
  const usageData = extractUsageAndCost(data.usage, originalModel)

  insertMessageToBigQuery({
    messageId: data.id,
    userId,
    startTime,
    request: auditRequest,
    reasoningText,
    responseText: content,
    usageData,
    logger,
    insertMessageBigquery,
  }).catch((error) => {
    logger.error({ error }, 'Failed to insert message into BigQuery')
  })

  const billedCredits = await consumeCreditsForMessage({
    messageId: data.id,
    userId,
    stripeCustomerId,
    agentId,
    clientId,
    clientRequestId,
    startTime,
    model: originalModel,
    reasoningText,
    responseText: content,
    usageData,
    byok: false,
    logger,
    costMode,
    ttftMs: null, // Non-stream - no TTFT to report
  })

  // Overwrite cost so SDK calculates exact credits we charged
  if (data.usage) {
    data.usage.cost = creditsToFakeCost(billedCredits)
    data.usage.cost_details = { upstream_inference_cost: 0 }
  }

  // Normalise model name back to OpenRouter format for client compatibility
  data.model = originalModel
  if (!data.provider) data.provider = 'DeepSeek'

  return data
}

export async function handleDeepSeekStream({
  body,
  userId,
  stripeCustomerId,
  agentId,
  fetch,
  logger,
  insertMessageBigquery,
}: {
  body: ChatCompletionRequestBody
  userId: string
  stripeCustomerId?: string | null
  agentId: string
  fetch: typeof globalThis.fetch
  logger: Logger
  insertMessageBigquery: InsertMessageBigqueryFn
}) {
  const originalModel = body.model
  const startTime = new Date()
  const { clientId, clientRequestId, costMode } = extractRequestMetadata({
    body,
    logger,
  })
  const auditRequest = createRequestAuditRecord(body)
  const skipDisconnectedBilling = isDeepSeekV4FlashModel(body.model)

  const response = await createDeepSeekRequestTracked({
    body,
    originalModel,
    fetch,
  })

  if (!response.ok) {
    throw await parseDeepSeekError(response)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Failed to get response reader')
  }

  let heartbeatInterval: NodeJS.Timeout
  let state: StreamState = {
    responseText: '',
    reasoningText: '',
    ttftMs: null,
    billedAlready: false,
  }
  let clientDisconnected = false

  const stream = new ReadableStream({
    async start(controller) {
      const decoder = new TextDecoder()
      let buffer = ''

      controller.enqueue(
        new TextEncoder().encode(`: connected ${new Date().toISOString()}\n`),
      )

      heartbeatInterval = setInterval(() => {
        if (!clientDisconnected) {
          try {
            controller.enqueue(
              new TextEncoder().encode(
                `: heartbeat ${new Date().toISOString()}\n\n`,
              ),
            )
          } catch {
            // client disconnected
          }
        }
      }, 30000)

      try {
        let done = false
        while (!done) {
          const result = await reader.read()
          done = result.done
          const value = result.value

          if (done) break

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
              startTime,
              request: auditRequest,
              originalModel,
              line,
              state,
              logger,
              insertMessage: insertMessageBigquery,
            })
            state = lineResult.state

            if (!clientDisconnected) {
              try {
                controller.enqueue(
                  new TextEncoder().encode(lineResult.patchedLine),
                )
              } catch {
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
            'Error after client disconnect in DeepSeek stream',
          )
        }
      } finally {
        clearInterval(heartbeatInterval)
      }
    },
    cancel() {
      clearInterval(heartbeatInterval)
      clientDisconnected = true
      if (skipDisconnectedBilling) {
        reader
          .cancel('client disconnected from DeepSeek V4 Flash stream')
          .catch((error) => {
            logger.warn(
              { error },
              'Failed to cancel disconnected DeepSeek V4 Flash stream',
            )
          })
      }
      logger.warn(
        {
          clientDisconnected,
          responseTextLength: state.responseText.length,
          reasoningTextLength: state.reasoningText.length,
          skippedBilling: skipDisconnectedBilling,
        },
        skipDisconnectedBilling
          ? 'Client cancelled DeepSeek V4 Flash stream, ending without billing'
          : 'Client cancelled stream, continuing DeepSeek consumption for billing',
      )
    },
  })

  return stream
}

async function handleLine({
  userId,
  stripeCustomerId,
  agentId,
  clientId,
  clientRequestId,
  costMode,
  startTime,
  request,
  originalModel,
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
  startTime: Date
  request: unknown
  originalModel: string
  line: string
  state: StreamState
  logger: Logger
  insertMessage: InsertMessageBigqueryFn
}): Promise<LineResult> {
  if (!line.startsWith('data: ')) {
    return { state, patchedLine: line }
  }

  const raw = line.slice('data: '.length)
  if (raw === '[DONE]\n' || raw === '[DONE]') {
    return { state, patchedLine: line }
  }

  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw)
  } catch (error) {
    logger.warn(
      { error: getErrorObject(error, { includeRawError: true }) },
      'Received non-JSON DeepSeek response',
    )
    return { state, patchedLine: line }
  }

  // Patch model and provider for SDK compatibility
  if (obj.model) obj.model = originalModel
  if (!obj.provider) obj.provider = 'DeepSeek'

  // Process the chunk for billing / state tracking
  const result = await handleResponse({
    userId,
    stripeCustomerId,
    agentId,
    clientId,
    clientRequestId,
    costMode,
    startTime,
    request,
    originalModel,
    data: obj,
    state,
    logger,
    insertMessage,
  })

  // If this is the final chunk with billing, overwrite cost in the patched object
  if (result.billedCredits !== undefined && obj.usage) {
    const usage = obj.usage as Record<string, unknown>
    usage.cost = creditsToFakeCost(result.billedCredits)
    usage.cost_details = { upstream_inference_cost: 0 }
  }

  const patchedLine = `data: ${JSON.stringify(obj)}\n`
  return {
    state: result.state,
    billedCredits: result.billedCredits,
    patchedLine,
  }
}

function isFinalChunk(data: Record<string, unknown>): boolean {
  const choices = data.choices as Array<Record<string, unknown>> | undefined
  if (!choices || choices.length === 0) return true
  return choices.some((c) => c.finish_reason != null)
}

async function handleResponse({
  userId,
  stripeCustomerId,
  agentId,
  clientId,
  clientRequestId,
  costMode,
  startTime,
  request,
  originalModel,
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
  startTime: Date
  request: unknown
  originalModel: string
  data: Record<string, unknown>
  state: StreamState
  logger: Logger
  insertMessage: InsertMessageBigqueryFn
}): Promise<{ state: StreamState; billedCredits?: number }> {
  state = handleStreamChunk({
    data,
    state,
    startTime,
    logger,
    userId,
    agentId,
    model: originalModel,
  })

  // Some providers send cumulative usage on EVERY chunk (not just the final one),
  // so we must only bill once on the final chunk to avoid charging N times.
  if (
    'error' in data ||
    !data.usage ||
    state.billedAlready ||
    !isFinalChunk(data)
  ) {
    // Strip usage from non-final chunks and duplicate final chunks
    // so the SDK doesn't see multiple usage objects
    if (data.usage && (!isFinalChunk(data) || state.billedAlready)) {
      delete data.usage
    }
    return { state }
  }

  const usageData = extractUsageAndCost(
    data.usage as Record<string, unknown>,
    originalModel,
  )
  const messageId = typeof data.id === 'string' ? data.id : 'unknown'

  state.billedAlready = true

  insertMessageToBigQuery({
    messageId,
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

  const billedCredits = await consumeCreditsForMessage({
    messageId,
    userId,
    stripeCustomerId,
    agentId,
    clientId,
    clientRequestId,
    startTime,
    model: originalModel,
    reasoningText: state.reasoningText,
    responseText: state.responseText,
    usageData,
    byok: false,
    logger,
    costMode,
    ttftMs: state.ttftMs,
  })

  return { state, billedCredits }
}

function handleStreamChunk({
  data,
  state,
  startTime,
  logger,
  userId,
  agentId,
  model,
}: {
  data: Record<string, unknown>
  state: StreamState
  startTime: Date
  logger: Logger
  userId: string
  agentId: string
  model: string
}): StreamState {
  const MAX_BUFFER_SIZE = 1 * 1024 * 1024

  if ('error' in data) {
    const errorData = data.error as Record<string, unknown>
    logger.error(
      {
        userId,
        agentId,
        model,
        errorCode: errorData?.code,
        errorType: errorData?.type,
        errorMessage: errorData?.message,
      },
      'Received error chunk in DeepSeek stream',
    )
    return state
  }

  const choices = data.choices as Array<Record<string, unknown>> | undefined
  if (!choices?.length) {
    return state
  }
  const choice = choices[0]
  const delta = choice.delta as Record<string, unknown> | undefined

  const contentDelta = typeof delta?.content === 'string' ? delta.content : ''
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

  const reasoningDelta =
    typeof delta?.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta?.reasoning === 'string'
        ? delta.reasoning
        : ''

  // Track time to first token (TTFT) - set on first meaningful delta (content, reasoning, or tool_calls)
  const hasToolCallsDelta =
    delta?.tool_calls != null && (delta.tool_calls as unknown[])?.length > 0
  if (
    state.ttftMs === null &&
    (contentDelta !== '' || reasoningDelta !== '' || hasToolCallsDelta)
  ) {
    state.ttftMs = Date.now() - startTime.getTime()
  }

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

export class DeepSeekError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    public readonly errorBody: {
      error: {
        message: string
        code: string | number | null
        type?: string | null
      }
    },
  ) {
    super(errorBody.error.message)
    this.name = 'DeepSeekError'
  }

  toJSON() {
    return {
      error: {
        message: this.errorBody.error.message,
        code: this.errorBody.error.code,
        type: this.errorBody.error.type,
      },
    }
  }
}

async function parseDeepSeekError(response: Response): Promise<DeepSeekError> {
  const errorText = await response.text()
  let errorBody: DeepSeekError['errorBody']
  try {
    const parsed = JSON.parse(errorText)
    if (parsed?.error?.message) {
      errorBody = {
        error: {
          message: parsed.error.message,
          code: parsed.error.code ?? null,
          type: parsed.error.type ?? null,
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
  return new DeepSeekError(response.status, response.statusText, errorBody)
}

function creditsToFakeCost(credits: number): number {
  return credits / ((1 + PROFIT_MARGIN) * 100)
}
