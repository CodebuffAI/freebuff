import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { isFreeMode } from '@codebuff/common/constants/free-agents'
import { models, PROFIT_MARGIN } from '@codebuff/common/old-constants'
import { buildArray } from '@codebuff/common/util/array'
import { normalizeProviderRequestBodyForCacheDebug } from '@codebuff/common/util/cache-debug'
import { getErrorObject, promptAborted, promptSuccess } from '@codebuff/common/util/error'
import { convertCbToModelMessages } from '@codebuff/common/util/messages'
import { isExplicitlyDefinedModel } from '@codebuff/common/util/model-utils'
import { StopSequenceHandler } from '@codebuff/common/util/stop-sequence'
import {
  streamText,
  generateText,
  generateObject,
  NoSuchToolError,
  APICallError,
  ToolCallRepairError,
  InvalidToolInputError,
  TypeValidationError,
} from 'ai'

import {
  getModelForRequest,
  markChatGptOAuthRateLimited,
} from './model-provider'
import { refreshChatGptOAuthToken } from '../credentials'
import {
  getCustomProviderApiKeyFromEnv,
  getCustomProviderBaseUrlFromEnv,
  getCustomProviderModelFromEnv,
} from '../env'
import { getErrorStatusCode } from '../error-utils'

import type { ModelRequestParams } from './model-provider'
import type { OpenRouterProviderRoutingOptions } from '@codebuff/common/types/agent-template'
import type {
  PromptAiSdkFn,
  PromptAiSdkStreamFn,
  PromptAiSdkStructuredInput,
  PromptAiSdkStructuredOutput,
} from '@codebuff/common/types/contracts/llm'
import type { ParamsOf } from '@codebuff/common/types/function-params'
import type { JSONObject } from '@codebuff/common/types/json'
import type { OpenRouterProviderOptions } from '@codebuff/internal/openrouter-ai-sdk'
import type { LanguageModel } from 'ai'
import type z from 'zod/v4'

// Provider routing documentation: https://openrouter.ai/docs/features/provider-routing
const providerOrder = {
  [models.openrouter_claude_sonnet_4]: [
    'Google',
    'Anthropic',
    'Amazon Bedrock',
  ],
  [models.openrouter_claude_sonnet_4_5]: [
    'Google',
    'Anthropic',
    'Amazon Bedrock',
  ],
  [models.openrouter_claude_opus_4]: ['Google', 'Anthropic'],
}

function calculateUsedCredits(params: { costDollars: number }): number {
  const { costDollars } = params

  return Math.round(costDollars * (1 + PROFIT_MARGIN) * 100)
}

export function getProviderOptions(params: {
  model: string
  runId: string
  clientSessionId: string
  providerOptions?: Record<string, JSONObject>
  agentProviderOptions?: OpenRouterProviderRoutingOptions
  n?: number
  costMode?: string
  cacheDebugCorrelation?: string
  extraCodebuffMetadata?: Record<string, string>
}): { codebuff: JSONObject } {
  const {
    model,
    runId,
    clientSessionId,
    providerOptions,
    agentProviderOptions,
    n,
    costMode,
    cacheDebugCorrelation,
    extraCodebuffMetadata,
  } = params

  let providerConfig: Record<string, any>

  // Use agent's provider options if provided, otherwise use defaults
  if (agentProviderOptions) {
    providerConfig = agentProviderOptions
  } else {
    // Set allow_fallbacks based on whether model is explicitly defined
    const isExplicitlyDefined = isExplicitlyDefinedModel(model)

    providerConfig = {
      order: providerOrder[model as keyof typeof providerOrder],
      allow_fallbacks: !isExplicitlyDefined,
    }
  }

  return {
    ...providerOptions,
    // Could either be "codebuff" or "openaiCompatible"
    codebuff: {
      ...providerOptions?.codebuff,
      // All values here get appended to the request body
      codebuff_metadata: {
        // Caller-supplied keys go first so they can't override reserved
        // identifiers like run_id/client_id/cost_mode that the server trusts.
        ...(extraCodebuffMetadata ?? {}),
        run_id: runId,
        client_id: clientSessionId,
        ...(n && { n }),
        ...(costMode && { cost_mode: costMode }),
        ...(cacheDebugCorrelation && {
          cache_debug_correlation: cacheDebugCorrelation,
        }),
      },
      provider: providerConfig,
    },
  }
}

// Usage accounting type for OpenRouter/Codebuff backend responses
// Forked from https://github.com/OpenRouterTeam/ai-sdk-provider/
type OpenRouterUsageAccounting = {
  cost: number | null
  costDetails: {
    upstreamInferenceCost: number | null
  }
}

/**
 * Retry count for direct calls to a custom OpenAI-compatible provider.
 * One retry absorbs brief model-load stalls on first call. We deliberately
 * don't retry more — local failures are usually deterministic (provider down,
 * wrong URL, model not pulled) and extra retries only make errors slower.
 */
const CUSTOM_PROVIDER_MAX_RETRIES = 1

/**
 * Wrap raw errors from a custom OpenAI-compatible endpoint in a friendly,
 * actionable message. Distinguishes connection failures (provider down,
 * wrong URL) from model-not-found errors.
 */
function buildCustomProviderError(args: {
  baseUrl: string
  model: string
  rawMessage: string
  rawCode?: string
}): string {
  const lower = args.rawMessage.toLowerCase()
  const codeLower = (args.rawCode ?? '').toLowerCase()
  const isConnectionError =
    lower.includes('econnrefused') ||
    lower.includes('connectionrefused') ||
    lower.includes('connection refused') ||
    lower.includes('unable to connect') ||
    lower.includes('fetch failed') ||
    lower.includes('etimedout') ||
    lower.includes('enotfound') ||
    lower.includes('socket hang up') ||
    codeLower === 'connectionrefused' ||
    codeLower === 'econnrefused' ||
    codeLower === 'enotfound' ||
    codeLower === 'etimedout'
  const isModelNotFound =
    lower.includes('model not found') ||
    lower.includes('does not exist') ||
    (lower.includes('404') && lower.includes(args.model.toLowerCase()))

  if (isConnectionError) {
    return [
      `Cannot reach LLM provider at ${args.baseUrl}.`,
      ``,
      `Check:`,
      `  • Is the provider running? (e.g. \`ollama serve\` or LM Studio's Local Server)`,
      `  • Is the URL correct? Currently configured: ${args.baseUrl}`,
      `  • Is the model '${args.model}' loaded? (e.g. \`ollama list\`)`,
      ``,
      `Original error: ${args.rawMessage}`,
    ].join('\n')
  }
  if (isModelNotFound) {
    return [
      `Model '${args.model}' not found at ${args.baseUrl}.`,
      ``,
      `Check:`,
      `  • Pull the model first: \`ollama pull ${args.model}\``,
      `  • Verify the exact tag with \`ollama list\``,
      ``,
      `Original error: ${args.rawMessage}`,
    ].join('\n')
  }
  return args.rawMessage
}

/**
 * Check if an error is an OAuth rate limit error that should trigger fallback.
 */
function isOAuthRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  // Check status code (handles both 'status' from AI SDK and 'statusCode' from our errors)
  const statusCode = getErrorStatusCode(error)
  if (statusCode === 429) return true

  // Check error message for rate limit indicators
  const err = error as {
    message?: string
    responseBody?: string
  }
  const message = (err.message || '').toLowerCase()
  const responseBody = (err.responseBody || '').toLowerCase()

  if (message.includes('rate_limit') || message.includes('rate limit'))
    return true
  if (
    responseBody.includes('rate_limit') ||
    responseBody.includes('rate limit')
  )
    return true

  return false
}

/**
 * Check if an error is an OAuth authentication error (expired/invalid token).
 * This indicates we should try refreshing the token.
 */
function isOAuthAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  // Check status code (handles both 'status' from AI SDK and 'statusCode' from our errors)
  const statusCode = getErrorStatusCode(error)
  if (statusCode === 401 || statusCode === 403) return true

  // Check error message for auth indicators
  const err = error as {
    message?: string
    responseBody?: string
  }
  const message = (err.message || '').toLowerCase()
  const responseBody = (err.responseBody || '').toLowerCase()

  if (message.includes('unauthorized') || message.includes('invalid_token'))
    return true
  if (message.includes('authentication') || message.includes('expired'))
    return true
  if (
    responseBody.includes('unauthorized') ||
    responseBody.includes('invalid_token')
  )
    return true
  if (
    responseBody.includes('authentication') ||
    responseBody.includes('expired')
  )
    return true

  return false
}

function getModelProvider(model: LanguageModel): string {
  if (typeof model === 'string') return model
  return model.provider
}

function emitCacheDebugProviderRequest(params: {
  callback?: (params: {
    provider: string
    rawBody: unknown
    normalizedBody?: unknown
  }) => void
  provider: string
  rawBody: unknown
}) {
  if (!params.callback) return

  const normalized = normalizeProviderRequestBodyForCacheDebug({
    provider: params.provider,
    body: params.rawBody,
  })

  params.callback({
    provider: params.provider,
    rawBody: params.rawBody,
    normalizedBody: normalized,
  })
}

function emitCacheDebugUsage(params: {
  callback?: (usage: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    totalTokens: number
  }) => void
  usage: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedInputTokens?: number
  }
}) {
  if (!params.callback) return

  params.callback({
    inputTokens: params.usage.inputTokens ?? 0,
    outputTokens: params.usage.outputTokens ?? 0,
    cachedInputTokens: params.usage.cachedInputTokens ?? 0,
    totalTokens: params.usage.totalTokens ?? 0,
  })
}

export type ChatGptOAuthStreamErrorPolicy =
  | 'fallback-rate-limit'
  | 'fail-auth-reconnect'
  | 'fail-fast'
  | 'ignore'

export function classifyChatGptOAuthStreamError(params: {
  isChatGptOAuth: boolean
  skipChatGptOAuth?: boolean
  hasYieldedContent: boolean
  error: unknown
}): ChatGptOAuthStreamErrorPolicy {
  const { isChatGptOAuth, skipChatGptOAuth, hasYieldedContent, error } = params

  if (!isChatGptOAuth || skipChatGptOAuth || hasYieldedContent) {
    return 'ignore'
  }

  if (isOAuthRateLimitError(error)) {
    return 'fallback-rate-limit'
  }

  if (isOAuthAuthError(error)) {
    return 'fail-auth-reconnect'
  }

  return 'fail-fast'
}

export async function* promptAiSdkStream(
  params: ParamsOf<PromptAiSdkStreamFn> & {
    skipChatGptOAuth?: boolean
    chatGptOAuthRetried?: boolean
  },
): ReturnType<PromptAiSdkStreamFn> {
  const {
    providerOptions: originalProviderOptions,
    ...streamParams
  } = params

  const { logger, trackEvent, userId, userInputId, model: requestedModel } = params
  const agentChunkMetadata =
    params.agentId != null ? { agentId: params.agentId } : undefined

  if (params.signal.aborted) {
    logger.info(
      {
        userId: params.userId,
        userInputId: params.userInputId,
      },
      'Skipping stream due to canceled user input',
    )
    return promptAborted('User cancelled input')
  }

  // Resolve custom-provider precedence: agent > client option > env.
  // First non-empty baseUrl wins; its apiKey comes along to avoid mixing
  // credentials with the wrong endpoint.
  const customSources = [
    params.agentProviderOptions,
    params.clientCustomProvider,
    {
      baseUrl: getCustomProviderBaseUrlFromEnv(),
      apiKey: getCustomProviderApiKeyFromEnv(),
    },
  ]
  const winningSource = customSources.find((s) => s?.baseUrl)
  const resolvedBaseUrl = winningSource?.baseUrl
  const resolvedApiKey = winningSource?.apiKey

  // Model override: substitute the agent's declared model with the env-configured
  // local model when the custom provider is active. Skipped when an agent
  // explicitly sets its own providerOptions.baseUrl — that agent is assumed to
  // have declared a matching model. See PROVIDER_MODEL_ENV_VAR JSDoc.
  const agentBaseUrl = params.agentProviderOptions?.baseUrl
  const envModelOverride =
    resolvedBaseUrl && !agentBaseUrl
      ? getCustomProviderModelFromEnv()
      : undefined
  const effectiveModel = envModelOverride ?? params.model

  // Surface the substitution so users can confirm in logs that their /local
  // model override is actually being applied to outbound requests.
  if (envModelOverride && envModelOverride !== params.model) {
    logger.info(
      {
        requestedModel: params.model,
        effectiveModel,
        baseUrl: resolvedBaseUrl,
      },
      'Custom provider active: substituting agent model with /local override',
    )
  }

  const modelParams: ModelRequestParams = {
    apiKey: params.apiKey,
    model: effectiveModel,
    skipChatGptOAuth: params.skipChatGptOAuth,
    costMode: params.costMode,
    ...(resolvedBaseUrl
      ? { customProvider: { baseUrl: resolvedBaseUrl, apiKey: resolvedApiKey } }
      : {}),
  }
  const { model: aiSDKModel, isChatGptOAuth, isCustomProvider } =
    await getModelForRequest(modelParams)

  if (isChatGptOAuth) {
    trackEvent({
      event: AnalyticsEvent.CHATGPT_OAUTH_REQUEST,
      userId: userId ?? '',
      properties: {
        model: requestedModel,
        userInputId,
      },
      logger,
    })
  }

  const response = streamText({
    ...streamParams,
    prompt: undefined,
    model: aiSDKModel,
    messages: convertCbToModelMessages(params),
    // ChatGPT OAuth: no retries (we fall back to Codebuff on first failure).
    // Custom provider: see CUSTOM_PROVIDER_MAX_RETRIES.
    ...(isChatGptOAuth ? { maxRetries: 0 } : {}),
    ...(isCustomProvider ? { maxRetries: CUSTOM_PROVIDER_MAX_RETRIES } : {}),
    // Direct routes (ChatGPT OAuth, custom provider): skip codebuff_metadata
    // and OpenRouter routing keys — neither belongs in those request bodies.
    ...(isChatGptOAuth || isCustomProvider
      ? {}
      : {
        providerOptions: getProviderOptions({
          ...params,
          providerOptions: originalProviderOptions,
          agentProviderOptions: params.agentProviderOptions,
        }),
      }),
    // Handle tool call errors gracefully by passing them through to our validation layer
    // instead of throwing (which would halt the agent). The only special case is when
    // the tool name matches a spawnable agent - transform those to spawn_agents calls.
    experimental_repairToolCall: async ({ toolCall, tools, error }) => {
      const { spawnableAgents = [], localAgentTemplates = {} } = params
      const toolName = toolCall.toolName

      // Check if this is a NoSuchToolError for a spawnable agent
      // If so, transform to spawn_agents call
      if (NoSuchToolError.isInstance(error) && 'spawn_agents' in tools) {
        // Also check for underscore variant (e.g., "file_picker" -> "file-picker")
        const toolNameWithHyphens = toolName.replace(/_/g, '-')

        const matchingAgentId = spawnableAgents.find((agentId) => {
          const withoutVersion = agentId.split('@')[0]
          const parts = withoutVersion.split('/')
          const agentName = parts[parts.length - 1]
          return (
            agentName === toolName ||
            agentName === toolNameWithHyphens ||
            agentId === toolName
          )
        })
        const isSpawnableAgent = matchingAgentId !== undefined
        const isLocalAgent =
          toolName in localAgentTemplates ||
          toolNameWithHyphens in localAgentTemplates

        if (isSpawnableAgent || isLocalAgent) {
          // Transform agent tool call to spawn_agents
          const deepParseJson = (value: unknown): unknown => {
            if (typeof value === 'string') {
              try {
                return deepParseJson(JSON.parse(value))
              } catch {
                return value
              }
            }
            if (Array.isArray(value)) return value.map(deepParseJson)
            if (value !== null && typeof value === 'object') {
              return Object.fromEntries(
                Object.entries(value).map(([k, v]) => [k, deepParseJson(v)]),
              )
            }
            return value
          }

          let input: Record<string, unknown> = {}
          try {
            const rawInput =
              typeof toolCall.input === 'string'
                ? JSON.parse(toolCall.input)
                : (toolCall.input as Record<string, unknown>)
            input = deepParseJson(rawInput) as Record<string, unknown>
          } catch {
            // If parsing fails, use empty object
          }

          const prompt =
            typeof input.prompt === 'string' ? input.prompt : undefined
          const agentParams = Object.fromEntries(
            Object.entries(input).filter(
              ([key, value]) =>
                !(key === 'prompt' && typeof value === 'string'),
            ),
          )

          // Use the matching agent ID or corrected name with hyphens
          const correctedAgentType =
            matchingAgentId ??
            (toolNameWithHyphens in localAgentTemplates
              ? toolNameWithHyphens
              : toolName)

          const spawnAgentsInput = {
            agents: [
              {
                agent_type: correctedAgentType,
                ...(prompt !== undefined && { prompt }),
                ...(Object.keys(agentParams).length > 0 && {
                  params: agentParams,
                }),
              },
            ],
          }

          logger.info(
            { originalToolName: toolName, transformedInput: spawnAgentsInput },
            'Transformed agent tool call to spawn_agents',
          )

          return {
            ...toolCall,
            toolName: 'spawn_agents',
            input: JSON.stringify(spawnAgentsInput),
          }
        }
      }

      // For all other cases (invalid args, unknown tools, etc.), pass through
      // the original tool call.
      logger.info(
        {
          toolName,
          errorType: error.name,
          error: error.message,
        },
        'Tool error - passing through for graceful error handling',
      )
      return toolCall
    },
  })

  const stopSequenceHandler = new StopSequenceHandler(params.stopSequences)

  // Track if we've yielded any content - if so, we can't safely fall back
  let hasYieldedContent = false

  // For custom-provider streams, a connection refusal at request init throws
  // from the iterator before any error chunk is emitted. Rewrap into a
  // friendly message so users see "is Ollama running?" not raw "fetch failed".
  const stream = isCustomProvider && resolvedBaseUrl
    ? (async function* () {
        try {
          yield* response.fullStream
        } catch (e) {
          const rawMessage = e instanceof Error ? e.message : String(e)
          const rawCode =
            e && typeof e === 'object' && 'code' in e
              ? String((e as { code?: unknown }).code ?? '')
              : undefined
          throw new Error(
            buildCustomProviderError({
              baseUrl: resolvedBaseUrl,
              model: effectiveModel,
              rawMessage,
              rawCode,
            }),
          )
        }
      })()
    : response.fullStream

  for await (const chunkValue of stream) {
    if (chunkValue.type !== 'text-delta') {
      const flushed = stopSequenceHandler.flush()
      if (flushed) {
        hasYieldedContent = true
        yield {
          type: 'text',
          text: flushed,
          ...(agentChunkMetadata ?? {}),
        }
      }
    }
    if (chunkValue.type === 'error') {
      // Error chunks from fullStream are non-network errors (tool failures, model issues, rate limits, etc.)
      // Network errors which cannot be recovered from are thrown, not yielded as chunks.

      const errorBody = APICallError.isInstance(chunkValue.error)
        ? chunkValue.error.responseBody
        : undefined
      const mainErrorMessage =
        chunkValue.error instanceof Error
          ? chunkValue.error.message
          : typeof chunkValue.error === 'string'
            ? chunkValue.error
            : JSON.stringify(chunkValue.error)
      const errorMessage = buildArray([mainErrorMessage, errorBody]).join('\n')

      // Pass these errors back to the agent so it can see what went wrong and retry.
      // Note: If you find any other error types that should be passed through to the agent, add them here!
      if (
        NoSuchToolError.isInstance(chunkValue.error) ||
        InvalidToolInputError.isInstance(chunkValue.error) ||
        ToolCallRepairError.isInstance(chunkValue.error) ||
        TypeValidationError.isInstance(chunkValue.error)
      ) {
        logger.warn(
          {
            chunk: { ...chunkValue, error: undefined },
            error: getErrorObject(chunkValue.error),
            model: params.model,
          },
          'Tool call error in AI SDK stream - passing through to agent to retry',
        )
        yield {
          type: 'error',
          message: errorMessage,
        }
        continue
      }

      const chatGptErrorPolicy = classifyChatGptOAuthStreamError({
        isChatGptOAuth,
        skipChatGptOAuth: params.skipChatGptOAuth,
        hasYieldedContent,
        error: chunkValue.error,
      })

      if (chatGptErrorPolicy === 'fallback-rate-limit') {
        const rateLimitErrorDetails = chunkValue.error instanceof Error ? chunkValue.error.message : String(chunkValue.error)
        logger.warn(
          { error: getErrorObject(chunkValue.error) },
          'ChatGPT OAuth rate limited during stream',
        )

        trackEvent({
          event: AnalyticsEvent.CHATGPT_OAUTH_RATE_LIMITED,
          userId: userId ?? '',
          properties: {
            model: requestedModel,
            userInputId,
          },
          logger,
        })

        markChatGptOAuthRateLimited()

        // In free mode, don't fall back to Codebuff backend — fail instead
        if (isFreeMode(params.costMode)) {
          throw new Error(
            `ChatGPT rate limit reached. Please wait a few minutes and try again. (${rateLimitErrorDetails})`,
          )
        }

        const fallbackResult = yield* promptAiSdkStream({
          ...params,
          skipChatGptOAuth: true,
        })
        return fallbackResult
      }

      if (chatGptErrorPolicy === 'fail-auth-reconnect') {
        logger.info(
          { error: getErrorObject(chunkValue.error) },
          'ChatGPT OAuth auth error during stream, attempting token refresh',
        )

        trackEvent({
          event: AnalyticsEvent.CHATGPT_OAUTH_AUTH_ERROR,
          userId: userId ?? '',
          properties: {
            model: requestedModel,
            userInputId,
          },
          logger,
        })

        // Try refreshing the token and retrying once before failing/falling back
        if (!params.chatGptOAuthRetried) {
          const refreshed = await refreshChatGptOAuthToken()
          if (refreshed) {
            logger.info({ model: requestedModel }, 'ChatGPT OAuth token refreshed, retrying request')
            const retryResult = yield* promptAiSdkStream({
              ...params,
              chatGptOAuthRetried: true,
            })
            return retryResult
          }
          logger.warn({ model: requestedModel }, 'ChatGPT OAuth token refresh failed, unable to recover')
        }

        // Refresh failed or already retried
        // In free mode, don't fall back to Codebuff backend — fail instead
        if (isFreeMode(params.costMode)) {
          throw new Error(
            'ChatGPT OAuth authentication failed. Please reconnect with /connect:chatgpt and try again.',
          )
        }

        // Fall back to Codebuff backend
        const fallbackResult = yield* promptAiSdkStream({
          ...params,
          skipChatGptOAuth: true,
        })
        return fallbackResult
      }

      logger.error(
        {
          chunk: { ...chunkValue, error: undefined },
          error: getErrorObject(chunkValue.error),
          model: params.model,
        },
        'Error in AI SDK stream',
      )

      // For custom-provider failures, rewrap with a friendly, actionable message
      // before throwing so users see "is Ollama running?" not raw "fetch failed".
      if (isCustomProvider && resolvedBaseUrl) {
        const rawCode =
          chunkValue.error &&
          typeof chunkValue.error === 'object' &&
          'code' in chunkValue.error
            ? String((chunkValue.error as { code?: unknown }).code ?? '')
            : undefined
        throw new Error(
          buildCustomProviderError({
            baseUrl: resolvedBaseUrl,
            model: effectiveModel,
            rawMessage: errorMessage,
            rawCode,
          }),
        )
      }

      // For all other errors, throw them -- they are fatal.
      throw chunkValue.error
    }
    if (chunkValue.type === 'reasoning-delta') {
      const reasoningExcluded = (['openrouter', 'codebuff'] as const).some(
        (p) =>
          (
            params.providerOptions?.[p] as
            | OpenRouterProviderOptions
            | undefined
          )?.reasoning?.exclude,
      )
      if (!reasoningExcluded) {
        yield {
          type: 'reasoning',
          text: chunkValue.text,
        }
      }
    }
    if (chunkValue.type === 'text-delta') {
      if (!params.stopSequences) {
        if (chunkValue.text) {
          hasYieldedContent = true
          yield {
            type: 'text',
            text: chunkValue.text,
            ...(agentChunkMetadata ?? {}),
          }
        }
        continue
      }

      const stopSequenceResult = stopSequenceHandler.process(chunkValue.text)
      if (stopSequenceResult.text) {
        hasYieldedContent = true
        yield {
          type: 'text',
          text: stopSequenceResult.text,
          ...(agentChunkMetadata ?? {}),
        }
      }
    }
    if (chunkValue.type === 'tool-call') {
      yield chunkValue
    }
  }
  const flushed = stopSequenceHandler.flush()
  if (flushed) {
    yield {
      type: 'text',
      text: flushed,
      ...(agentChunkMetadata ?? {}),
    }
  }

  const responseValue = await response.response
  const messageId = responseValue.id

  const requestMetadata = await response.request
  emitCacheDebugProviderRequest({
    callback: params.onCacheDebugProviderRequestBuilt,
    provider: getModelProvider(aiSDKModel),
    rawBody: requestMetadata.body,
  })

  const usageResult = await response.usage
  emitCacheDebugUsage({
    callback: params.onCacheDebugUsageReceived,
    usage: usageResult,
  })

  // Skip cost tracking for ChatGPT OAuth (user is on their own subscription)
  if (!isChatGptOAuth) {
    const providerMetadataResult = await response.providerMetadata
    const providerMetadata = providerMetadataResult ?? {}

    let costOverrideDollars: number | undefined
    if (providerMetadata.codebuff) {
      if (providerMetadata.codebuff.usage) {
        const openrouterUsage = providerMetadata.codebuff
          .usage as OpenRouterUsageAccounting

        costOverrideDollars =
          (openrouterUsage.cost ?? 0) +
          (openrouterUsage.costDetails?.upstreamInferenceCost ?? 0)
      }
    }

    // Call the cost callback if provided
    if (params.onCostCalculated && costOverrideDollars) {
      await params.onCostCalculated(
        calculateUsedCredits({ costDollars: costOverrideDollars }),
      )
    }
  }

  return promptSuccess(messageId)
}

export async function promptAiSdk(
  params: ParamsOf<PromptAiSdkFn>,
): ReturnType<PromptAiSdkFn> {
  const { logger } = params

  if (params.signal.aborted) {
    logger.info(
      {
        userId: params.userId,
        userInputId: params.userInputId,
      },
      'Skipping prompt due to canceled user input',
    )
    return promptAborted('User cancelled input')
  }

  const modelParams: ModelRequestParams = {
    apiKey: params.apiKey,
    model: params.model,
    skipChatGptOAuth: true, // Always use Codebuff backend for non-streaming
  }
  const { model: aiSDKModel } = await getModelForRequest(modelParams)

  const response = await generateText({
    ...params,
    prompt: undefined,
    model: aiSDKModel,
    messages: convertCbToModelMessages(params),
    providerOptions: getProviderOptions({
      ...params,
      agentProviderOptions: params.agentProviderOptions,
      cacheDebugCorrelation: params.cacheDebugCorrelation,
    }),
  })
  emitCacheDebugProviderRequest({
    callback: params.onCacheDebugProviderRequestBuilt,
    provider: getModelProvider(aiSDKModel),
    rawBody: response.request?.body,
  })
  emitCacheDebugUsage({
    callback: params.onCacheDebugUsageReceived,
    usage: response.usage,
  })
  const content = response.text

  const providerMetadata = response.providerMetadata ?? {}
  let costOverrideDollars: number | undefined
  if (providerMetadata.codebuff) {
    if (providerMetadata.codebuff.usage) {
      const openrouterUsage = providerMetadata.codebuff
        .usage as OpenRouterUsageAccounting

      costOverrideDollars =
        (openrouterUsage.cost ?? 0) +
        (openrouterUsage.costDetails?.upstreamInferenceCost ?? 0)
    }
  }

  // Call the cost callback if provided
  if (params.onCostCalculated && costOverrideDollars) {
    await params.onCostCalculated(
      calculateUsedCredits({ costDollars: costOverrideDollars }),
    )
  }

  return promptSuccess(content)
}

export async function promptAiSdkStructured<T>(
  params: PromptAiSdkStructuredInput<T>,
): PromptAiSdkStructuredOutput<T> {
  const { logger } = params

  if (params.signal.aborted) {
    logger.info(
      {
        userId: params.userId,
        userInputId: params.userInputId,
      },
      'Skipping structured prompt due to canceled user input',
    )
    return promptAborted('User cancelled input')
  }
  const modelParams: ModelRequestParams = {
    apiKey: params.apiKey,
    model: params.model,
    skipChatGptOAuth: true, // Always use Codebuff backend for non-streaming
  }
  const { model: aiSDKModel } = await getModelForRequest(modelParams)

  const response = await generateObject<z.ZodType<T>, 'object'>({
    ...params,
    prompt: undefined,
    model: aiSDKModel,
    output: 'object',
    messages: convertCbToModelMessages(params),
    providerOptions: getProviderOptions({
      ...params,
      agentProviderOptions: params.agentProviderOptions,
      cacheDebugCorrelation: params.cacheDebugCorrelation,
    }),
  })

  emitCacheDebugProviderRequest({
    callback: params.onCacheDebugProviderRequestBuilt,
    provider: getModelProvider(aiSDKModel),
    rawBody: response.request?.body,
  })
  emitCacheDebugUsage({
    callback: params.onCacheDebugUsageReceived,
    usage: response.usage,
  })

  const content = response.object

  const providerMetadata = response.providerMetadata ?? {}
  let costOverrideDollars: number | undefined
  if (providerMetadata.codebuff) {
    if (providerMetadata.codebuff.usage) {
      const openrouterUsage = providerMetadata.codebuff
        .usage as OpenRouterUsageAccounting

      costOverrideDollars =
        (openrouterUsage.cost ?? 0) +
        (openrouterUsage.costDetails?.upstreamInferenceCost ?? 0)
    }
  }

  // Call the cost callback if provided
  if (params.onCostCalculated && costOverrideDollars) {
    await params.onCostCalculated(
      calculateUsedCredits({ costDollars: costOverrideDollars }),
    )
  }

  return promptSuccess(content)
}
