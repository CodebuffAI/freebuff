import { models, PROFIT_MARGIN } from '@codebuff/common/old-constants'
import { buildArray } from '@codebuff/common/util/array'
import { STREAM_RECOVERY_EVENT } from '@codebuff/common/util/axiom-only-log'
import { normalizeProviderRequestBodyForCacheDebug } from '@codebuff/common/util/cache-debug'
import {
  getErrorObject,
  promptAborted,
  promptSuccess,
} from '@codebuff/common/util/error'
import { convertCbToModelMessages } from '@codebuff/common/util/messages'
import { isExplicitlyDefinedModel } from '@codebuff/common/util/model-utils'
import { StopSequenceHandler } from '@codebuff/common/util/stop-sequence'
import {
  streamText,
  generateText,
  Output,
  NoSuchToolError,
  APICallError,
  ToolCallRepairError,
  InvalidToolInputError,
  TypeValidationError,
} from 'ai'

import { getModelForRequest } from './model-provider'
import { byokModelLimits } from '../byok'
import type { ResolvedByokConnection } from '../byok'
import {
  classifyStreamEndRecovery,
  classifyThrownStreamRecovery,
  streamFinishInfoOf,
  type StreamEndRecovery,
  type StreamFinishInfo,
} from './stream-interruption'

import type {
  OpenRouterProviderOptions,
  OpenRouterProviderRoutingOptions,
} from '@codebuff/common/types/agent-template'
import type {
  PromptAiSdkFn,
  PromptAiSdkStreamFn,
  PromptAiSdkStructuredInput,
  PromptAiSdkStructuredOutput,
} from '@codebuff/common/types/contracts/llm'
import type { ParamsOf } from '@codebuff/common/types/function-params'
import type { ProviderMetadata } from '@codebuff/common/types/messages/provider-metadata'
import type { LanguageModel } from 'ai'

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
  providerOptions?: ProviderMetadata
  agentProviderOptions?: OpenRouterProviderRoutingOptions
  n?: number
  costMode?: string
  cacheDebugCorrelation?: string
  extraCodebuffMetadata?: Record<string, string>
}): ProviderMetadata {
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
    reasoningOutputTokens?: number
    cachedInputTokens: number
    totalTokens: number
  }) => void
  usage: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    inputTokenDetails?: {
      cacheReadTokens?: number
    }
    outputTokenDetails?: {
      reasoningTokens?: number
    }
  }
}) {
  if (!params.callback) return

  params.callback({
    inputTokens: params.usage.inputTokens ?? 0,
    outputTokens: params.usage.outputTokens ?? 0,
    ...(params.usage.outputTokenDetails?.reasoningTokens !== undefined
      ? {
          reasoningOutputTokens:
            params.usage.outputTokenDetails.reasoningTokens,
        }
      : {}),
    cachedInputTokens: params.usage.inputTokenDetails?.cacheReadTokens ?? 0,
    totalTokens: params.usage.totalTokens ?? 0,
  })
}

export async function* promptAiSdkStream(
  params: ParamsOf<PromptAiSdkStreamFn> & { byok?: ResolvedByokConnection },
): ReturnType<PromptAiSdkStreamFn> {
  const { providerOptions: originalProviderOptions, ...streamParams } = params

  const { logger } = params
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

  const aiSDKModel = getModelForRequest({
    apiKey: params.apiKey,
    model: params.model,
    userId: params.userId,
    byok: params.byok,
  })

  const response = streamText({
    ...streamParams,
    ...(params.byok && {
      maxOutputTokens: Math.min(
        params.maxOutputTokens ?? byokModelLimits(params.byok).maxOutputTokens,
        byokModelLimits(params.byok).maxOutputTokens,
      ),
    }),
    abortSignal: params.signal,
    prompt: undefined,
    model: aiSDKModel,
    messages: convertCbToModelMessages(params),
    allowSystemInMessages: true,
    include: {
      ...streamParams.include,
      requestBody: true,
    },
    providerOptions: params.byok ? originalProviderOptions : getProviderOptions({
      ...params,
      providerOptions: originalProviderOptions,
      agentProviderOptions: params.agentProviderOptions,
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

  let usageReported = false
  let usageIncompleteReported = false
  const reportUsageIncomplete = () => {
    if (usageReported || usageIncompleteReported) return
    usageIncompleteReported = true
    params.onUsageIncomplete?.()
  }
  const reportUsage = (usage: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    inputTokenDetails?: {
      cacheReadTokens?: number
    }
    outputTokenDetails?: {
      reasoningTokens?: number
    }
  }) => {
    if (usageReported || usageIncompleteReported) return
    usageReported = true
    emitCacheDebugUsage({
      callback: params.onCacheDebugUsageReceived,
      usage,
    })
    emitCacheDebugUsage({
      callback: params.onUsageReceived,
      usage,
    })
  }

  let costReported = false
  let finishProviderMetadata: ProviderMetadata | undefined
  const reportCost = async (providerMetadata: ProviderMetadata | undefined) => {
    if (costReported) return
    const openrouterUsage = providerMetadata?.codebuff?.usage as
      | OpenRouterUsageAccounting
      | undefined
    const costOverrideDollars = openrouterUsage
      ? (openrouterUsage.cost ?? 0) +
        (openrouterUsage.costDetails?.upstreamInferenceCost ?? 0)
      : undefined
    if (!params.onCostCalculated || !costOverrideDollars) return
    costReported = true
    await params.onCostCalculated(
      calculateUsedCredits({ costDollars: costOverrideDollars }),
    )
  }

  const stopSequenceHandler = new StopSequenceHandler(params.stopSequences)

  // Track if we've yielded any content - if so, we can't safely fall back
  let hasYieldedContent = false
  // Native reasoning is not visible answer content, but it distinguishes a
  // silent model stop from a legitimate empty completion.
  let hasReceivedReasoning = false
  // Tool calls tracked separately: a step that produced tool calls is
  // actionable even with no text, so it is never a silent stop.
  let hasYieldedToolCall = false

  // A healthy stream always delivers a finish part with a real finishReason
  // (and usage) before ending; its absence after the loop means the
  // connection was cut mid-response. See stream-interruption.ts.
  let finishInfo: StreamFinishInfo | undefined
  // Bun/undici can throw when a response body is severed instead of ending the
  // iterator cleanly. Feed that through the same capped continuation path as a
  // clean end without a finish marker.
  let thrownStreamRecovery: StreamEndRecovery | undefined
  const streamIterator = response.stream[Symbol.asyncIterator]()
  const recoverThrownStream = (error: unknown): StreamEndRecovery | null => {
    const recovery = classifyThrownStreamRecovery({
      aborted: params.signal.aborted,
      error,
    })
    if (!recovery) return null
    // These final-result promises can reject with the same transport error.
    // Observe them now so the recovery yield below cannot leave an unhandled
    // rejection while the consumer starts the continuation step.
    void Promise.allSettled([
      response.response,
      response.request,
      response.usage,
      response.providerMetadata,
    ])
    return recovery
  }

  while (true) {
    let iteration: Awaited<ReturnType<typeof streamIterator.next>>
    try {
      iteration = await streamIterator.next()
    } catch (error) {
      if (params.signal.aborted) reportUsageIncomplete()
      const recovery = recoverThrownStream(error)
      if (!recovery) throw error
      thrownStreamRecovery = recovery
      break
    }
    if (iteration.done) break
    const chunkValue = iteration.value
    if (chunkValue.type === 'finish-step') {
      finishProviderMetadata = chunkValue.providerMetadata as
        | ProviderMetadata
        | undefined
    }
    if (chunkValue.type === 'finish') {
      finishInfo = streamFinishInfoOf(
        chunkValue,
        typeof aiSDKModel !== 'string' &&
          aiSDKModel.specificationVersion === 'v2',
      )
      if (finishInfo.hasUsage) reportUsage(chunkValue.totalUsage)
      await reportCost(finishProviderMetadata)
    }
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
      if (params.signal.aborted) reportUsageIncomplete()
      // Error chunks are usually model/tool/API failures. Some runtimes surface
      // a response-body transport drop here instead of rejecting iterator.next;
      // the final branch below recognizes that one recoverable exception.

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

      // A transport error can also arrive as an AI SDK error chunk instead of
      // making iterator.next() reject. Recover both runtime shapes identically.
      const recovery = recoverThrownStream(chunkValue.error)
      if (recovery) {
        thrownStreamRecovery = recovery
        break
      }

      logger.error(
        {
          chunk: { ...chunkValue, error: undefined },
          error: getErrorObject(chunkValue.error),
          model: params.model,
        },
        'Error in AI SDK stream',
      )

      // For all other errors, throw them -- they are fatal.
      throw chunkValue.error
    }
    if (chunkValue.type === 'reasoning-delta') {
      if (chunkValue.text) {
        hasReceivedReasoning = true
      }
      const reasoningExcluded = (['openrouter', 'codebuff'] as const).some(
        (p) =>
          (params.providerOptions?.[p] as OpenRouterProviderOptions | undefined)
            ?.reasoning?.exclude,
      )
      if (!reasoningExcluded) {
        yield {
          type: 'reasoning',
          text: chunkValue.text,
        }
      }
    }
    if (chunkValue.type === 'reasoning-end') {
      if (chunkValue.providerMetadata) {
        hasReceivedReasoning = true
        yield {
          type: 'reasoning',
          text: '',
          providerOptions: chunkValue.providerMetadata as ProviderMetadata,
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
      hasYieldedToolCall = true
      yield chunkValue
    }
  }
  const flushed = stopSequenceHandler.flush()
  if (flushed) {
    hasYieldedContent = true
    yield {
      type: 'text',
      text: flushed,
      ...(agentChunkMetadata ?? {}),
    }
  }

  if (params.signal.aborted) reportUsageIncomplete()
  if (thrownStreamRecovery && params.signal.aborted) {
    return promptAborted('User cancelled input')
  }
  const recovery =
    thrownStreamRecovery ??
    classifyStreamEndRecovery({
      aborted: params.signal.aborted,
      finish: finishInfo,
      receivedReasoning: hasReceivedReasoning,
      yieldedText: hasYieldedContent,
      yieldedToolCall: hasYieldedToolCall,
    })
  if (recovery) {
    reportUsageIncomplete()
    // The stream ended in a recoverable silent stop (connection cut, or
    // reasoning ended without an answer). Yield an error chunk instead of
    // ending like a normal completion: the agent loop appends the note to
    // the conversation and forces another step (with a consecutive cap), so
    // the model continues rather than the turn silently stopping.
    logger.warn(
      {
        // axiomEvent bypasses the CLI's default redaction of non-error log
        // payloads (see common/src/util/axiom-only-log.ts) — without it,
        // `source`/`model`/etc. below would ship to Axiom as a
        // {kind, keyCount, keys} shape summary instead of real values,
        // since only error/fatal-level CLI logs ship raw data otherwise.
        // Queryable via scripts/logs/stream-interruptions.ts — one event per
        // detection. Outcomes (rescued/gave_up) are emitted by the agent
        // loop, which knows the consecutive streak.
        axiomEvent: STREAM_RECOVERY_EVENT,
        metric: 'stream_recovery_detected',
        source: recovery.source,
        model: params.model,
        userId: params.userId,
        userInputId: params.userInputId,
        finishReason: finishInfo?.finishReason,
        hasYieldedContent,
        hasReceivedReasoning,
      },
      'Completion stream ended without a usable response; forcing a retry step',
    )
    yield {
      type: 'error',
      source: recovery.source,
      message: recovery.message,
    }
  }

  // A thrown response body has no reliable final metadata to collect. The
  // recovery chunk above preserves partial output and forces a fresh agent
  // step, which continues from that saved context.
  if (thrownStreamRecovery) return promptSuccess(null)

  const responseValue = await response.response
  const messageId = responseValue.id

  const requestMetadata = await response.request
  emitCacheDebugProviderRequest({
    callback: params.onCacheDebugProviderRequestBuilt,
    provider: getModelProvider(aiSDKModel),
    rawBody: requestMetadata.body,
  })

  const usageResult = await response.usage
  if (finishInfo?.hasUsage) reportUsage(usageResult)
  else reportUsageIncomplete()

  const providerMetadata = (await response.providerMetadata) ?? {}
  await reportCost(providerMetadata as ProviderMetadata)

  return promptSuccess(messageId)
}

export async function promptAiSdk(
  params: ParamsOf<PromptAiSdkFn> & { byok?: ResolvedByokConnection },
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

  const aiSDKModel = getModelForRequest({
    apiKey: params.apiKey,
    model: params.model,
    userId: params.userId,
    byok: params.byok,
  })

  const response = await generateText({
    ...params,
    ...(params.byok && {
      maxOutputTokens: Math.min(
        params.maxOutputTokens ?? byokModelLimits(params.byok).maxOutputTokens,
        byokModelLimits(params.byok).maxOutputTokens,
      ),
    }),
    prompt: undefined,
    model: aiSDKModel,
    messages: convertCbToModelMessages(params),
    allowSystemInMessages: true,
    include: {
      ...params.include,
      requestBody: true,
    },
    providerOptions: params.byok ? undefined : getProviderOptions({
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
  params: PromptAiSdkStructuredInput<T> & { byok?: ResolvedByokConnection },
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
  const aiSDKModel = getModelForRequest({
    apiKey: params.apiKey,
    model: params.model,
    userId: params.userId,
    byok: params.byok,
  })

  const response = await generateText({
    ...params,
    ...(params.byok && {
      maxOutputTokens: Math.min(
        params.maxTokens ?? byokModelLimits(params.byok).maxOutputTokens,
        byokModelLimits(params.byok).maxOutputTokens,
      ),
    }),
    prompt: undefined,
    model: aiSDKModel,
    output: Output.object({ schema: params.schema }),
    messages: convertCbToModelMessages(params),
    allowSystemInMessages: true,
    include: { requestBody: true },
    providerOptions: params.byok ? undefined : getProviderOptions({
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

  const content = response.output

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
