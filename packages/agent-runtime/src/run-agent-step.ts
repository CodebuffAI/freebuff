import { contextPrunerBudgetForModel } from '@codebuff/common/constants/model-config'
import {
  supportsAssistantPrefill,
  supportsCacheControl,
} from '@codebuff/common/old-constants'
import { TOOLS_WHICH_WONT_FORCE_NEXT_STEP } from '@codebuff/common/tools/constants'
import { buildArray } from '@codebuff/common/util/array'
import {
  AbortError,
  FETCH_IDLE_TIMEOUT_USER_MESSAGE,
  TRANSIENT_NETWORK_ERROR_USER_MESSAGE,
  extractApiErrorDetails,
  getErrorObject,
  isAbortError,
  isFetchIdleTimeoutError,
  isTransientNetworkError,
} from '@codebuff/common/util/error'
import { serializeCacheDebugCorrelation } from '@codebuff/common/util/cache-debug'
import {
  dropUnansweredToolCalls,
  systemMessage,
  userMessage,
} from '@codebuff/common/util/messages'
import { type ToolSet } from 'ai'
import { cloneDeep, mapValues } from 'lodash'
import z from 'zod/v4'

import { maybeCompactHistory } from './compact-history'
import { CACHE_DEBUG_FULL_LOGGING } from './constants'
import { getMCPToolData } from './mcp'
import { getAgentStreamFromTemplate } from './prompt-agent-stream'
import { isThinkOnlyResponse } from './util/think-tags'
import {
  clearProgrammaticRunState,
  runProgrammaticStep,
} from './run-programmatic-step'
import {
  additionalSystemPrompts,
  isCompactCommandPrompt,
} from './system-prompt/prompts'
import { getAgentTemplate } from './templates/agent-registry'
import { buildAgentToolSet } from './templates/prompts'
import { getAgentPrompt } from './templates/strings'
import { getToolSet } from './tools/prompts'
import { processStream } from './tools/stream-parser'
import { getAgentOutput } from './util/agent-output'
import {
  createCacheDebugSnapshot,
  enrichCacheDebugSnapshotWithProviderRequest,
  enrichCacheDebugSnapshotWithUsage,
} from './util/cache-debug'
import {
  withSystemInstructionTags,
  withSystemTags as withSystemTags,
  buildUserMessageContent,
  expireMessages,
} from './util/messages'
import { recountContextTokens } from './util/context-token-count'
import {
  countTokens,
  countTokensJson,
  countTokensMessages,
} from './util/token-counter'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type {
  AddAgentStepFn,
  FinishAgentRunFn,
  StartAgentRunFn,
} from '@codebuff/common/types/contracts/database'
import type {
  AgentUsageData,
  CacheDebugUsageData,
  ContextCompactionData,
  ModelUsageData,
  PromptAiSdkFn,
} from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { TraceWriter } from '@codebuff/common/types/contracts/trace'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type {
  TextPart,
  ImagePart,
} from '@codebuff/common/types/messages/content-part'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type {
  AgentTemplateType,
  AgentState,
  AgentOutput,
} from '@codebuff/common/types/session-state'
import type {
  CustomToolDefinitions,
  ProjectFileContext,
} from '@codebuff/common/util/file'

// Convert a tool's stored inputSchema into JSON Schema suitable for Anthropic's
// count_tokens API. Built-in and MCP tools store a Zod schema here; serializing
// it raw ships Zod internals (`def`/`shape`) instead of JSON Schema, so token
// counts are computed against garbage and any schema whose top-level isn't an
// object (e.g. a union → `anyOf`) arrives without `type`, which the API rejects
// with `tools.N.custom.input_schema.type: Field required`. We convert to JSON
// Schema and guarantee a top-level `type: 'object'`.
export function toTokenCountInputSchema(
  inputSchema: unknown,
): Record<string, unknown> | undefined {
  if (inputSchema == null) return undefined

  let jsonSchema: Record<string, unknown>
  if (
    typeof (inputSchema as { safeParse?: unknown }).safeParse === 'function'
  ) {
    try {
      jsonSchema = z.toJSONSchema(inputSchema as z.ZodType, {
        io: 'input',
      }) as Record<string, unknown>
    } catch {
      jsonSchema = { type: 'object', properties: {} }
    }
  } else if (typeof inputSchema === 'object' && !Array.isArray(inputSchema)) {
    // Already a plain object (e.g. a pre-serialized JSON Schema) — copy it.
    jsonSchema = { ...(inputSchema as Record<string, unknown>) }
  } else {
    return undefined
  }

  // `$schema` is meaningless to count_tokens; drop it to keep the payload lean.
  delete jsonSchema['$schema']
  // Anthropic requires a top-level `type: 'object'`. Object schemas already
  // carry it; union/intersection schemas (anyOf/allOf) don't — backfill it.
  // Treat missing / null / empty-string as absent (valid JSON Schema `type` is
  // always a non-empty string or array).
  if (jsonSchema.type == null || jsonSchema.type === '') {
    jsonSchema.type = 'object'
  }
  return jsonSchema
}

async function additionalToolDefinitions(
  params: {
    agentTemplate: AgentTemplate
    fileContext: ProjectFileContext
  } & ParamsExcluding<
    typeof getMCPToolData,
    'toolNames' | 'mcpServers' | 'writeTo'
  >,
): Promise<CustomToolDefinitions> {
  const { agentTemplate, fileContext } = params

  const defs = cloneDeep(
    Object.fromEntries(
      Object.entries(fileContext.customToolDefinitions).filter(([toolName]) =>
        agentTemplate!.toolNames.includes(toolName),
      ),
    ),
  )
  return getMCPToolData({
    ...params,
    toolNames: agentTemplate!.toolNames,
    mcpServers: agentTemplate!.mcpServers,
    writeTo: defs,
  })
}

/** Run-id prefix for runs that skip the run-tracking ledger (context-pruner).
 *  These ids exist only in-process and must never be sent to the web API. */
export const UNTRACKED_RUN_ID_PREFIX = 'untracked-'

export const runAgentStep = async (
  params: {
    userId: string | undefined
    userInputId: string
    clientSessionId: string
    costMode?: string
    fingerprintId: string
    repoId: string | undefined
    onResponseChunk: (chunk: string | PrintModeEvent) => void

    agentType: AgentTemplateType
    agentTemplate: AgentTemplate
    fileContext: ProjectFileContext
    agentState: AgentState
    localAgentTemplates: Record<string, AgentTemplate>

    prompt: string | undefined
    spawnParams: Record<string, any> | undefined
    system: string
    n?: number

    trackEvent: TrackEventFn
    promptAiSdk: PromptAiSdkFn
    traceWriter?: TraceWriter
    onAgentUsageReceived?: (usage: AgentUsageData) => void
    onAgentUsageIncomplete?: () => void
    onCompaction?: (data: ContextCompactionData) => void
  } & ParamsExcluding<
    typeof processStream,
    | 'agentContext'
    | 'agentState'
    | 'agentStepId'
    | 'agentTemplate'
    | 'fullResponse'
    | 'messages'
    | 'onCostCalculated'
    | 'repoId'
    | 'stream'
  > &
    ParamsExcluding<
      typeof getAgentStreamFromTemplate,
      | 'agentId'
      | 'includeCacheControl'
      | 'messages'
      | 'onCostCalculated'
      | 'template'
    > &
    ParamsExcluding<typeof getAgentTemplate, 'agentId'> &
    ParamsExcluding<
      typeof getAgentPrompt,
      'agentTemplate' | 'promptType' | 'agentState' | 'agentTemplates'
    > &
    ParamsExcluding<
      typeof getMCPToolData,
      'toolNames' | 'mcpServers' | 'writeTo'
    > &
    ParamsExcluding<
      PromptAiSdkFn,
      'messages' | 'model' | 'onCostCalculated' | 'n'
    >,
): Promise<{
  agentState: AgentState
  fullResponse: string
  shouldEndTurn: boolean
  messageId: string | null
  nResponses?: string[]
}> => {
  const {
    agentType,
    fileContext,
    agentTemplate,
    localAgentTemplates,
    logger,
    prompt,
    repoId,
    spawnParams,
    system,
    userId,
    userInputId,
    onResponseChunk,
    promptAiSdk,
    additionalToolDefinitions,
  } = params
  let agentState = params.agentState

  const { agentContext } = agentState

  const startTime = Date.now()

  // Links logs within a single step of the agent loop.
  const agentStepId = crypto.randomUUID()

  if (agentState.stepsRemaining <= 0) {
    logger.warn(
      `Detected too many consecutive assistant messages without user prompt`,
    )

    onResponseChunk(`${STEP_WARNING_MESSAGE}\n\n`)

    // Update message history to include the warning
    agentState = {
      ...agentState,
      messageHistory: [
        ...expireMessages(agentState.messageHistory, 'userPrompt'),
        userMessage(
          withSystemTags(
            `The assistant has responded too many times in a row. The assistant's turn has automatically been ended. The maximum number of responses can be configured via maxAgentSteps.`,
          ),
        ),
      ],
    }
    return {
      agentState,
      fullResponse: STEP_WARNING_MESSAGE,
      shouldEndTurn: true,
      messageId: null,
    }
  }

  const stepPrompt = await getAgentPrompt({
    ...params,
    agentTemplate,
    promptType: { type: 'stepPrompt' },
    fileContext,
    agentState,
    agentTemplates: localAgentTemplates,
    logger,
    additionalToolDefinitions,
  })

  // An interrupted turn can leave a tool call with no result behind, which
  // strict providers (DeepSeek) reject with a 400. Since history is persisted
  // and replayed, that one orphan would fail every later turn, so drop it here
  // — the single point every step's request is built — and assign the cleaned
  // history back so the checkpointed state is valid too.
  const history = dropUnansweredToolCalls(
    expireMessages(agentState.messageHistory, 'agentStep'),
  )

  const agentMessagesUntruncated = buildArray<Message>(
    ...history,

    stepPrompt &&
      userMessage({
        content: stepPrompt,
        tags: ['STEP_PROMPT'],

        // James: Deprecate the below, only use tags, which are not prescriptive.
        timeToLive: 'agentStep' as const,
        keepDuringTruncation: true,
      }),
  )

  agentState.messageHistory = agentMessagesUntruncated

  const { model } = agentTemplate

  // A step can start with the history ending on an assistant message — e.g. a
  // continuation after a think-only response for an agent with no stepPrompt.
  // Claude 4.6+ rejects such requests as unsupported assistant prefill, so end
  // the conversation with a user message instead.
  const lastMessage =
    agentState.messageHistory[agentState.messageHistory.length - 1]
  if (lastMessage?.role === 'assistant' && !supportsAssistantPrefill(model)) {
    agentState.messageHistory = [
      ...agentState.messageHistory,
      userMessage({
        content: withSystemTags('Continue from where you left off.'),
        timeToLive: 'agentStep' as const,
        keepDuringTruncation: true,
      }),
    ]
  }

  let stepCreditsUsed = 0

  const onCostCalculated = async (credits: number) => {
    stepCreditsUsed += credits
    agentState.creditsUsed += credits
    agentState.directCreditsUsed += credits
  }

  const iterationNum = agentState.messageHistory.length
  // system is a plain string; count it directly rather than JSON-stringifying
  // it (which would add quotes and escape every newline).
  const systemTokens = countTokens(system)

  let cacheDebugCorrelation:
    | ReturnType<typeof createCacheDebugSnapshot>
    | undefined
  if (CACHE_DEBUG_FULL_LOGGING) {
    try {
      cacheDebugCorrelation = createCacheDebugSnapshot({
        agentType: String(agentType),
        system,
        toolDefinitions: params.tools
          ? Object.fromEntries(
              Object.entries(params.tools).map(([name, tool]) => [
                name,
                {
                  description: tool.description,
                  inputSchema: tool.inputSchema as {},
                },
              ]),
            )
          : {},
        messages: [systemMessage(system), ...agentState.messageHistory],
        logger,
        projectRoot: fileContext.projectRoot,
        runId: agentState.runId,
        userInputId,
        agentStepId,
        model,
      })
    } catch (err) {
      logger.warn({ error: err }, '[Cache Debug] Failed to create snapshot')
    }
  }

  const onCacheDebugProviderRequestBuilt = cacheDebugCorrelation
    ? ({
        provider,
        rawBody,
        normalizedBody,
      }: {
        provider: string
        rawBody: unknown
        normalizedBody?: unknown
      }) => {
        enrichCacheDebugSnapshotWithProviderRequest({
          correlation: cacheDebugCorrelation,
          provider,
          rawBody,
          normalized: normalizedBody ?? rawBody,
          logger,
        })
      }
    : undefined

  const onCacheDebugUsageReceived = cacheDebugCorrelation
    ? (usage: CacheDebugUsageData) => {
        enrichCacheDebugSnapshotWithUsage({
          correlation: cacheDebugCorrelation,
          usage,
          logger,
        })
      }
    : undefined

  // Full message histories go to the trace writer, which appends each message
  // exactly once (see TraceWriter).
  params.traceWriter?.recordStep({
    agentId: agentState.agentId,
    agentType: String(agentType),
    runId: agentState.runId,
    userInputId,
    step: iterationNum,
    system,
    messages: agentState.messageHistory,
  })

  // Log a summary only: the full message history, system prompt, and agent
  // template are large and logging them every step bloats log files
  // quadratically over the course of a chat.
  logger.debug(
    {
      iteration: iterationNum,
      runId: agentState.runId,
      model,
      duration: Date.now() - startTime,
      contextTokenCount: agentState.contextTokenCount,
      messageCount: agentState.messageHistory.length,
      prompt,
      params: spawnParams,
      systemTokens,
      agentTemplateId: agentTemplate.id,
      toolNames: params.tools ? Object.keys(params.tools) : undefined,
    },
    `Start agent ${agentType} step ${iterationNum} (${userInputId}${prompt ? ` - Prompt: ${prompt.slice(0, 20)}` : ''})`,
  )

  // Handle n parameter for generating multiple responses
  if (params.n !== undefined) {
    const result = await promptAiSdk({
      ...params,
      messages: agentState.messageHistory,
      model,
      n: params.n,
      onCostCalculated,
      cacheDebugCorrelation: cacheDebugCorrelation
        ? serializeCacheDebugCorrelation(cacheDebugCorrelation)
        : undefined,
      onCacheDebugProviderRequestBuilt,
      onCacheDebugUsageReceived,
    })

    if (result.aborted) {
      return {
        agentState,
        fullResponse: '',
        shouldEndTurn: true,
        messageId: null,
        nResponses: undefined,
      }
    }

    const responsesString = result.value
    let nResponses: string[]
    try {
      nResponses = JSON.parse(responsesString) as string[]
      if (!Array.isArray(nResponses)) {
        if (params.n > 1) {
          throw new Error(
            `Expected JSON array response from LLM when n > 1, got non-array: ${responsesString.slice(0, 50)}`,
          )
        }
        // If it parsed but isn't an array, treat as single response
        nResponses = [responsesString]
      }
    } catch (e) {
      if (params.n > 1) {
        throw e
      }
      // If parsing fails, treat as single raw response (common for n=1)
      nResponses = [responsesString]
    }

    return {
      agentState,
      fullResponse: responsesString,
      shouldEndTurn: false,
      messageId: null,
      nResponses,
    }
  }

  let fullResponse = ''
  const toolResults: ToolMessage[] = []

  // Raw stream from AI SDK
  const stream = getAgentStreamFromTemplate({
    ...params,
    agentId: agentState.parentId ? agentState.agentId : undefined,
    costMode: params.costMode,
    cacheDebugCorrelation: cacheDebugCorrelation
      ? serializeCacheDebugCorrelation(cacheDebugCorrelation)
      : undefined,
    includeCacheControl: supportsCacheControl(agentTemplate.model),
    messages: [systemMessage(system), ...agentState.messageHistory],
    onCacheDebugProviderRequestBuilt,
    onCacheDebugUsageReceived,
    onUsageReceived: params.onAgentUsageReceived
      ? (usage: ModelUsageData) =>
          params.onAgentUsageReceived?.({
            ...usage,
            isRoot: !agentState.parentId,
            agentId: agentState.agentId,
          })
      : undefined,
    onUsageIncomplete: params.onAgentUsageIncomplete,
    template: agentTemplate,
    onCostCalculated,
  })

  const {
    fullResponse: fullResponseAfterStream,
    hadToolCallError,
    messageId,
    toolCalls,
    toolResults: newToolResults,
  } = await processStream({
    ...params,
    agentContext,
    agentState,
    agentStepId,
    agentTemplate,
    fullResponse,
    messages: agentState.messageHistory,
    repoId,
    stream,
    onCostCalculated,
  })

  toolResults.push(...newToolResults)

  fullResponse = fullResponseAfterStream

  agentState.messageHistory = expireMessages(
    agentState.messageHistory,
    'agentStep',
  )

  // Handle the compact command: replace message history with the summary. The
  // trigger is COUPLED to the instruction injection (isCompactCommandPrompt
  // reads the same map that injected compactPrompt above), so it cannot match
  // a prompt that never received the summarize instruction — a divergence
  // (the old lowercased comparison matched `/Compact`, which the exact-key
  // injection did not) replaced the whole history with an ordinary answer.
  const wasCompacted = isCompactCommandPrompt(prompt)
  if (wasCompacted) {
    if (fullResponse.trim().length > 0 && !isThinkOnlyResponse(fullResponse)) {
      agentState.messageHistory = [
        userMessage(
          withSystemTags(
            `The following is a summary of the conversation between you and the user. The conversation continues after this summary:\n\n${fullResponse}`,
          ),
        ),
      ]
      logger.debug({ summary: fullResponse }, 'Compacted messages')
    } else {
      // An interrupted, tool-only, or think-only response would replace the
      // history with a non-summary — total, unrecoverable amnesia. Keep the
      // history instead.
      logger.warn(
        { messageCount: agentState.messageHistory.length },
        'Skipped compact: model returned no summary text',
      )
    }
  }

  const hasNoToolResults =
    toolCalls.filter(
      (call) => !TOOLS_WHICH_WONT_FORCE_NEXT_STEP.includes(call.toolName),
    ).length === 0 &&
    toolResults.filter(
      (result) => !TOOLS_WHICH_WONT_FORCE_NEXT_STEP.includes(result.toolName),
    ).length === 0 &&
    !hadToolCallError // Tool call errors should also force another step so the agent can retry

  const hasTaskCompleted = toolCalls.some(
    (call) =>
      call.toolName === 'task_completed' || call.toolName === 'end_turn',
  )

  // If the response is only <think>...</think> scaffolding (including orphan
  // </think> closes that native-reasoning providers sometimes leak into
  // content), the model was just thinking and should continue rather than end.
  const isThinkOnly = hasNoToolResults && isThinkOnlyResponse(fullResponse)

  // If the agent has the task_completed tool, it must be called to end its turn.
  const requiresExplicitCompletion =
    agentTemplate.toolNames.includes('task_completed')

  let shouldEndTurn: boolean
  if (requiresExplicitCompletion) {
    // For models requiring explicit completion, only end turn when:
    // - task_completed is called, OR
    // - end_turn is called (backward compatibility)
    shouldEndTurn = !hadToolCallError && hasTaskCompleted
  } else {
    // For other models, also end turn when there are no tool calls
    // Exception: if the response is only <think> tags, continue the turn
    shouldEndTurn =
      !hadToolCallError &&
      (hasTaskCompleted || (hasNoToolResults && !isThinkOnly))
  }

  agentState = {
    ...agentState,
    stepsRemaining: agentState.stepsRemaining - 1,
    agentContext,
  }

  // Capture the assistant response and tool results added during this step
  params.traceWriter?.recordStep({
    agentId: agentState.agentId,
    agentType: String(agentType),
    runId: agentState.runId,
    userInputId,
    step: iterationNum,
    system,
    messages: agentState.messageHistory,
  })

  logger.debug(
    {
      iteration: iterationNum,
      agentId: agentState.agentId,
      model,
      prompt,
      shouldEndTurn,
      duration: Date.now() - startTime,
      fullResponse,
      // Summarize instead of logging the full message history: logging it
      // every step bloats log files quadratically over the course of a chat.
      messageCount: agentState.messageHistory.length,
      toolCalls,
      toolResults,
      stepCreditsUsed,
    },
    `End agent ${agentType} step ${iterationNum} (${userInputId}${prompt ? ` - Prompt: ${prompt.slice(0, 20)}` : ''})`,
  )

  return {
    agentState,
    fullResponse,
    shouldEndTurn,
    messageId,
    nResponses: undefined,
  }
}

/**
 * Runs the agent loop.
 *
 * IMPORTANT: This function mutates `params.agentState` in place throughout the
 * run (not just at return time). Fields like `messageHistory`, `systemPrompt`,
 * `toolDefinitions`, `creditsUsed`, and `output` are updated as work progresses
 * so that callers holding a reference to the same object (e.g. the SDK's
 * `sessionState.mainAgentState`) see in-progress work immediately — which
 * matters when an error is thrown mid-run and the normal return path is
 * skipped.
 */
export async function loopAgentSteps(
  params: {
    addAgentStep: AddAgentStepFn
    agentState: AgentState
    agentType: string
    clearUserPromptMessagesAfterResponse?: boolean
    clientSessionId: string
    content?: Array<TextPart | ImagePart>
    costMode?: string
    fileContext: ProjectFileContext
    finishAgentRun: FinishAgentRunFn
    localAgentTemplates: Record<string, AgentTemplate>
    logger: Logger
    parentSystemPrompt?: string
    parentTools?: ToolSet
    prompt: string | undefined
    signal: AbortSignal
    /** Optional steering hook. Drained at each step boundary (after a step's LLM
     * call + tools complete, before the next one). Any returned texts are appended
     * to the message history as user prompts and keep the turn going, letting a
     * host "steer" a running agent without aborting or losing the current step. */
    drainSteeringMessages?: () => string[]
    spawnParams: Record<string, any> | undefined
    startAgentRun: StartAgentRunFn
    userId: string | undefined
    userInputId: string
    agentTemplate?: AgentTemplate
  } & ParamsExcluding<typeof additionalToolDefinitions, 'agentTemplate'> &
    ParamsExcluding<
      typeof runProgrammaticStep,
      | 'agentState'
      | 'onCostCalculated'
      | 'prompt'
      | 'runId'
      | 'stepNumber'
      | 'stepsComplete'
      | 'system'
      | 'template'
      | 'toolCallParams'
      | 'tools'
    > &
    ParamsExcluding<typeof getAgentTemplate, 'agentId'> &
    ParamsExcluding<
      typeof getAgentPrompt,
      | 'agentTemplate'
      | 'promptType'
      | 'agentTemplates'
      | 'additionalToolDefinitions'
    > &
    ParamsExcluding<
      typeof getMCPToolData,
      'toolNames' | 'mcpServers' | 'writeTo'
    > &
    ParamsExcluding<StartAgentRunFn, 'agentId' | 'ancestorRunIds'> &
    ParamsExcluding<
      FinishAgentRunFn,
      'runId' | 'status' | 'totalSteps' | 'directCredits' | 'totalCredits'
    > &
    ParamsExcluding<
      typeof runAgentStep,
      | 'additionalToolDefinitions'
      | 'agentState'
      | 'agentTemplate'
      | 'prompt'
      | 'runId'
      | 'spawnParams'
      | 'system'
      | 'tools'
    > &
    ParamsExcluding<
      AddAgentStepFn,
      | 'agentRunId'
      | 'stepNumber'
      | 'credits'
      | 'childRunIds'
      | 'messageId'
      | 'status'
      | 'startTime'
    >,
): Promise<{
  agentState: AgentState
  output: AgentOutput
}> {
  let agentTemplate = params.agentTemplate
  if (!agentTemplate) {
    agentTemplate =
      (await getAgentTemplate({
        ...params,
        agentId: params.agentType,
      })) ?? undefined
  }
  if (!agentTemplate) {
    throw new Error(`Agent template not found for type: ${params.agentType}`)
  }

  // The context pruner is a programmatic no-model-call agent spawned before
  // every main-agent step. Recording its runs in the ledger cost three awaited
  // web-API round trips (start/step/finish) per main-agent step, so it mints a
  // local run id and skips run tracking entirely. Matches bundled and
  // publisher-qualified ids ('context-pruner', 'codebuff/context-pruner@1.0.0').
  if (agentTemplate.id.includes('context-pruner')) {
    params = {
      ...params,
      startAgentRun: async () =>
        `${UNTRACKED_RUN_ID_PREFIX}${crypto.randomUUID()}`,
      addAgentStep: async () => null,
      finishAgentRun: async () => {},
    }
  }

  const {
    addAgentStep,
    agentState: initialAgentState,
    agentType,
    clearUserPromptMessagesAfterResponse = true,
    clientSessionId,
    content,
    fileContext,
    finishAgentRun,
    localAgentTemplates,
    logger,
    parentSystemPrompt,
    parentTools,
    prompt,
    signal,
    spawnParams,
    startAgentRun,
    userId,
    userInputId,
    clientEnv,
    ciEnv,
  } = params

  if (signal.aborted) {
    return {
      agentState: initialAgentState,
      output: {
        type: 'error',
        message: 'Run cancelled by user',
      },
    }
  }

  const runId = await startAgentRun({
    ...params,
    agentId: agentTemplate.id,
    ancestorRunIds: initialAgentState.ancestorRunIds,
  })
  if (!runId) {
    // registration ends on the run's signal; an abort landing there is a cancel, not a failure
    if (signal.aborted) {
      return {
        agentState: initialAgentState,
        output: {
          type: 'error',
          message: 'Run cancelled by user',
        },
      }
    }
    throw new Error('Failed to start agent run')
  }
  initialAgentState.runId = runId

  let cachedAdditionalToolDefinitions: CustomToolDefinitions | undefined
  // Use parent's tools for prompt caching when inheritParentSystemPrompt is true
  const useParentTools =
    agentTemplate.inheritParentSystemPrompt && parentTools !== undefined

  // Initialize message history with user prompt and instructions on first iteration
  const instructionsPrompt = await getAgentPrompt({
    ...params,
    agentTemplate,
    promptType: { type: 'instructionsPrompt' },
    agentTemplates: localAgentTemplates,
    useParentTools,
    additionalToolDefinitions: async () => {
      if (!cachedAdditionalToolDefinitions) {
        cachedAdditionalToolDefinitions = await additionalToolDefinitions({
          ...params,
          agentTemplate,
        })
      }
      return cachedAdditionalToolDefinitions
    },
  })

  // Build the initial message history with user prompt and instructions
  // Generate system prompt once, using parent's if inheritParentSystemPrompt is true
  let system: string
  if (agentTemplate.inheritParentSystemPrompt && parentSystemPrompt) {
    system = parentSystemPrompt
  } else {
    const systemPrompt = await getAgentPrompt({
      ...params,
      agentTemplate,
      promptType: { type: 'systemPrompt' },
      agentTemplates: localAgentTemplates,
      additionalToolDefinitions: async () => {
        if (!cachedAdditionalToolDefinitions) {
          cachedAdditionalToolDefinitions = await additionalToolDefinitions({
            ...params,
            agentTemplate,
          })
        }
        return cachedAdditionalToolDefinitions
      },
    })
    system = systemPrompt ?? ''
  }

  // Build agent tools (agents as direct tool calls) for non-inherited tools
  const agentTools = useParentTools
    ? {}
    : await buildAgentToolSet({
        ...params,
        spawnableAgents: agentTemplate.spawnableAgents,
        agentTemplates: localAgentTemplates,
      })

  const tools = useParentTools
    ? parentTools
    : await getToolSet({
        toolNames: agentTemplate.toolNames,
        windowedFileReads: agentTemplate.windowedFileReads === true,
        suppressCommitAttribution:
          agentTemplate.suppressCommitAttribution === true,
        additionalToolDefinitions: async () => {
          if (!cachedAdditionalToolDefinitions) {
            cachedAdditionalToolDefinitions = await additionalToolDefinitions({
              ...params,
              agentTemplate,
            })
          }
          return cachedAdditionalToolDefinitions
        },
        agentTools,
        skills: fileContext.skills ?? {},
      })

  const hasUserMessage = Boolean(
    prompt ||
    (spawnParams && Object.keys(spawnParams).length > 0) ||
    (content && content.length > 0),
  )

  const initialMessages = buildArray<Message>(
    ...initialAgentState.messageHistory,

    hasUserMessage && [
      {
        // Actual user message!
        role: 'user' as const,
        content: buildUserMessageContent(prompt, spawnParams, content),
        tags: ['USER_PROMPT'],
        sentAt: Date.now(),

        // James: Deprecate the below, only use tags, which are not prescriptive.
        keepDuringTruncation: true,
      },
      prompt &&
        prompt in additionalSystemPrompts &&
        userMessage(
          withSystemInstructionTags(
            additionalSystemPrompts[
              prompt as keyof typeof additionalSystemPrompts
            ],
          ),
        ),
      ,
    ],

    instructionsPrompt &&
      userMessage({
        content: instructionsPrompt,
        tags: ['INSTRUCTIONS_PROMPT'],

        // James: Deprecate the below, only use tags, which are not prescriptive.
        keepLastTags: ['INSTRUCTIONS_PROMPT'],
      }),
  )

  // Convert tools to a serializable format for context-pruner token counting
  const toolDefinitions = mapValues(tools, (tool) => ({
    description:
      typeof tool.description === 'string' ? tool.description : undefined,
    inputSchema: tool.inputSchema as {},
  }))

  const additionalToolDefinitionsWithCache = async () => {
    if (!cachedAdditionalToolDefinitions) {
      cachedAdditionalToolDefinitions = await additionalToolDefinitions({
        ...params,
        agentTemplate,
      })
    }
    return cachedAdditionalToolDefinitions
  }

  // Mutate initialAgentState so that in-progress work propagates back to the
  // caller's shared reference (e.g. SDK's sessionState.mainAgentState) even if
  // an error is thrown before we return.
  initialAgentState.messageHistory = initialMessages
  initialAgentState.systemPrompt = system
  initialAgentState.toolDefinitions = toolDefinitions
  let currentAgentState: AgentState = initialAgentState

  // Convert tool definitions to Anthropic format for accurate token counting.
  // Tool definitions are stored as { [name]: { description, inputSchema } },
  // where inputSchema is a Zod schema. Anthropic's count_tokens API expects
  // [{ name, description, input_schema }] with input_schema being real JSON
  // Schema (with a top-level `type: 'object'`) — see toTokenCountInputSchema.
  const toolsForTokenCount = Object.entries(toolDefinitions).map(
    ([name, def]) => {
      const input_schema = toTokenCountInputSchema(def.inputSchema)
      return {
        name,
        ...(def.description && { description: def.description }),
        ...(input_schema && { input_schema }),
      }
    },
  )

  // Recount against the history the turn actually ends with.
  //
  // Inside the loop the count is taken BEFORE the model call, so the last
  // step's assistant response and every tool result it produced are missing
  // from it — systematically the most recently added content, and on a step
  // that read several files easily tens of thousands of tokens. That was
  // harmless while the number only fed the compaction check, which runs again
  // at the top of the next step anyway. It stops being harmless now that hosts
  // persist it and show it to the user between turns.
  //
  // Same formula as estimateContextTokensLocally below, minus the step prompt:
  // `system` and `toolsForTokenCount` are loop-invariant, and the step prompt
  // is per-step scaffolding rather than part of the history the next turn is
  // sent on top of. Once per turn against once per step is not a hot-path cost.
  //
  // Root agents only, which is the whole reason the count lives in its own
  // module with a test: a subagent's final count is discarded with the
  // subagent, and recounting it tokenizes that agent's entire history for
  // nobody.
  const recountContextTokensForTurnEnd = () => {
    currentAgentState.contextTokenCount = recountContextTokens({
      agentState: {
        // `initialAgentState` is the same object `currentAgentState` points at
        // (every reassignment below assigns it), so this is exactly the
        // predicate the compaction callback already uses two hundred lines
        // down: nothing a subagent computes here leaves the subagent.
        parentId: initialAgentState.parentId,
        messageHistory: currentAgentState.messageHistory,
        contextTokenCount: currentAgentState.contextTokenCount,
      },
      systemPrompt: system,
      toolsForTokenCount,
    })
  }

  let shouldEndTurn = false
  let hasRetriedOutputSchema = false
  let currentPrompt = prompt
  let currentParams = spawnParams
  let totalSteps = 0
  let llmStepNumber = 0
  let nResponses: string[] | undefined = undefined

  try {
    while (true) {
      totalSteps++
      if (signal.aborted) {
        throw new AbortError()
      }

      const startTime = new Date()

      const stepPrompt = await getAgentPrompt({
        ...params,
        agentTemplate,
        promptType: { type: 'stepPrompt' },
        fileContext,
        agentState: currentAgentState,
        agentTemplates: localAgentTemplates,
        logger,
        additionalToolDefinitions: additionalToolDefinitionsWithCache,
      })
      const messagesWithStepPrompt = buildArray(
        ...currentAgentState.messageHistory,
        stepPrompt &&
          userMessage({
            content: stepPrompt,
          }),
      )

      // Count structured message content (not JSON.stringify, which inflates the
      // count and counts image base64 as text); system is a plain string; tool
      // schemas stay JSON since that's roughly how the model sees them.
      const estimateContextTokensLocally = () =>
        countTokensMessages(messagesWithStepPrompt) +
        countTokens(system) +
        countTokensJson(toolsForTokenCount)

      // Always count locally. The token-count web API round-trip (full
      // history + tools shipped to the server, which relays to Anthropic)
      // added seconds of serial overhead to every step; there is no paid mode
      // anymore that needs Anthropic-exact counts, and context-limit checks
      // only need an estimate.
      currentAgentState.contextTokenCount = estimateContextTokensLocally()

      // Mechanical compaction: no model call, so it costs nothing but the
      // prompt-cache break that rewriting the history forces anyway. The
      // budget is sized to the model in use (see contextPrunerBudgetForModel),
      // which is the same budget base2 hands the context-pruner agent.
      //
      // Fires once per turn at most: compaction stamps every surviving message
      // with a fresh sentAt and drops the assistant messages that preceded the
      // live prompt, so the cache gap it measured is gone on the next step.
      if (agentTemplate.compactContext) {
        const compacted = maybeCompactHistory({
          // The option object is exactly the tunable subset, so it forwards
          // whole. Spread first: the fields below are not the agent's to set.
          ...(typeof agentTemplate.compactContext === 'object'
            ? agentTemplate.compactContext
            : {}),
          messages: currentAgentState.messageHistory,
          contextTokenCount: currentAgentState.contextTokenCount,
          maxContextLength:
            (typeof agentTemplate.compactContext === 'object'
              ? agentTemplate.compactContext.maxContextLength
              : undefined) ?? contextPrunerBudgetForModel(agentTemplate.model),
          logger,
          runId,
          onCompaction: (trigger) => {
            if (initialAgentState.parentId) return
            params.onCompaction?.({
              trigger,
              thresholdTokens:
                (typeof agentTemplate.compactContext === 'object'
                  ? agentTemplate.compactContext.maxContextLength
                  : undefined) ??
                contextPrunerBudgetForModel(agentTemplate.model),
            })
          },
        })
        if (compacted) {
          currentAgentState.messageHistory = compacted
          currentAgentState.contextTokenCount =
            countTokensMessages(compacted) +
            countTokens(system) +
            countTokensJson(toolsForTokenCount)
        }
      }

      // 1. Run programmatic step first if it exists
      let n: number | undefined = undefined

      if (agentTemplate.handleSteps) {
        const programmaticResult = await runProgrammaticStep({
          ...params,

          agentState: currentAgentState,
          localAgentTemplates,
          nResponses,
          onCostCalculated: async (credits: number) => {
            currentAgentState.creditsUsed += credits
            currentAgentState.directCreditsUsed += credits
          },
          prompt: currentPrompt,
          runId,
          stepNumber: totalSteps,
          stepsComplete: shouldEndTurn,
          system,
          tools,
          template: agentTemplate,
          toolCallParams: currentParams,
        })
        const {
          agentState: programmaticAgentState,
          endTurn,
          stepNumber,
          generateN,
        } = programmaticResult
        n = generateN

        Object.assign(initialAgentState, programmaticAgentState)
        currentAgentState = initialAgentState
        totalSteps = stepNumber

        shouldEndTurn = endTurn
      }

      // Check if output is required but missing
      if (
        agentTemplate.outputSchema &&
        currentAgentState.output === undefined &&
        shouldEndTurn &&
        !hasRetriedOutputSchema
      ) {
        hasRetriedOutputSchema = true
        logger.warn(
          {
            agentType,
            agentId: currentAgentState.agentId,
            runId,
          },
          'Agent finished without setting required output, restarting loop',
        )

        // Add system message instructing to use set_output
        const outputSchemaMessage = withSystemTags(
          `You must use the "set_output" tool to provide a result that matches the output schema before ending your turn. The output schema is required for this agent.`,
        )

        currentAgentState.messageHistory = [
          ...currentAgentState.messageHistory,
          userMessage({
            content: outputSchemaMessage,
            keepDuringTruncation: true,
          }),
        ]

        // Reset shouldEndTurn to continue the loop
        shouldEndTurn = false
      }

      // End turn if programmatic step ended turn, or if the previous runAgentStep ended turn
      if (shouldEndTurn) {
        break
      }

      const creditsBefore = currentAgentState.directCreditsUsed
      const childrenBefore = currentAgentState.childRunIds.length
      llmStepNumber++
      const {
        agentState: newAgentState,
        shouldEndTurn: llmShouldEndTurn,
        messageId,
        nResponses: generatedResponses,
      } = await runAgentStep({
        ...params,

        agentState: currentAgentState,
        agentTemplate,
        extraCodebuffMetadata: {
          ...(params.extraCodebuffMetadata ?? {}),
          llm_step_number: String(llmStepNumber),
        },
        n,
        prompt: currentPrompt,
        runId,
        spawnParams: currentParams,
        system,
        tools,
        additionalToolDefinitions: additionalToolDefinitionsWithCache,
      })

      if (newAgentState.runId) {
        await addAgentStep({
          ...params,
          agentRunId: newAgentState.runId,
          stepNumber: totalSteps,
          credits: newAgentState.directCreditsUsed - creditsBefore,
          childRunIds: newAgentState.childRunIds.slice(childrenBefore),
          messageId,
          status: 'completed',
          startTime,
        })
      } else {
        logger.error('No runId found for agent state after finishing agent run')
      }

      Object.assign(initialAgentState, newAgentState)
      currentAgentState = initialAgentState
      shouldEndTurn = llmShouldEndTurn
      nResponses = generatedResponses

      currentPrompt = undefined
      currentParams = undefined

      // Steering: if the host fed user messages while this step ran, append them
      // now (the step's LLM call + tools have completed, so history is in a clean
      // state) and keep the turn going so the agent responds to them next step,
      // rather than waiting for the whole turn to finish.
      const steered = params.drainSteeringMessages?.()
      if (steered?.length) {
        currentAgentState.messageHistory = [
          ...currentAgentState.messageHistory,
          ...steered.map((text) =>
            userMessage({
              content: buildUserMessageContent(text, undefined, undefined),
              tags: ['USER_PROMPT'],
              keepDuringTruncation: true,
            }),
          ),
        ]
        shouldEndTurn = false
      }
    }

    if (clearUserPromptMessagesAfterResponse) {
      currentAgentState.messageHistory = expireMessages(
        currentAgentState.messageHistory,
        'userPrompt',
      )
    }

    recountContextTokensForTurnEnd()

    await finishAgentRun({
      ...params,
      runId,
      status: 'completed',
      totalSteps,
      directCredits: currentAgentState.directCreditsUsed,
      totalCredits: currentAgentState.creditsUsed,
    })

    return {
      agentState: currentAgentState,
      output: getAgentOutput(currentAgentState, agentTemplate),
    }
  } catch (error) {
    // Handle user-initiated aborts separately - don't log as errors
    if (isAbortError(error)) {
      if (clearUserPromptMessagesAfterResponse) {
        currentAgentState.messageHistory = expireMessages(
          currentAgentState.messageHistory,
          'userPrompt',
        )
      }

      currentAgentState.messageHistory = [
        ...currentAgentState.messageHistory,
        userMessage(
          withSystemTags(
            "User interrupted the response. The assistant's previous work has been preserved.",
          ),
        ),
      ]

      logger.info(
        {
          agentType,
          agentId: currentAgentState.agentId,
          runId,
          totalSteps,
          messageHistory: currentAgentState.messageHistory,
        },
        'Agent run cancelled by user (abort error)',
      )

      // Same reason as the success path, and it matters more here: the branch
      // above just appended another message to the history the caller keeps.
      // Not the last edit, though — the SDK's buildCancelledSessionState drops
      // unanswered tool calls and appends again at the persistence boundary,
      // and carries this count across those edits itself.
      recountContextTokensForTurnEnd()

      await finishAgentRun({
        ...params,
        runId,
        status: 'cancelled',
        totalSteps,
        directCredits: currentAgentState.directCreditsUsed,
        totalCredits: currentAgentState.creditsUsed,
      })

      return {
        agentState: currentAgentState,
        output: {
          type: 'error',
          message: 'Run cancelled by user',
        },
      }
    }

    logger.error(
      {
        error: getErrorObject(error),
        agentType,
        agentId: currentAgentState.agentId,
        runId,
        totalSteps,
        directCreditsUsed: currentAgentState.directCreditsUsed,
        creditsUsed: currentAgentState.creditsUsed,
        messageHistory: currentAgentState.messageHistory,
        systemPrompt: system,
      },
      'Agent execution failed',
    )

    const apiErrorDetails = extractApiErrorDetails(error)
    const isIdleTimeout = isFetchIdleTimeoutError(error)
    const isNetworkError = !isIdleTimeout && isTransientNetworkError(error)
    const hasServerMessage = apiErrorDetails.message !== undefined
    let fallbackMessage: string
    if (isIdleTimeout) {
      fallbackMessage = FETCH_IDLE_TIMEOUT_USER_MESSAGE
    } else if (isNetworkError) {
      fallbackMessage = TRANSIENT_NETWORK_ERROR_USER_MESSAGE
    } else if (error instanceof Error) {
      const includeStack =
        apiErrorDetails.statusCode === undefined && error.stack
      fallbackMessage =
        error.message + (includeStack ? `\n\n${error.stack}` : '')
    } else {
      fallbackMessage = String(error)
    }
    const errorMessage = apiErrorDetails.message ?? fallbackMessage
    const statusCode = apiErrorDetails.statusCode

    const status = signal.aborted ? 'cancelled' : 'failed'
    // A failed turn still leaves history behind, and the host still shows the
    // user a context reading before their next message.
    recountContextTokensForTurnEnd()
    await finishAgentRun({
      ...params,
      runId,
      status,
      totalSteps,
      directCredits: currentAgentState.directCreditsUsed,
      totalCredits: currentAgentState.creditsUsed,
      errorMessage,
    })

    // Payment required errors (402) should propagate
    if (statusCode === 402) {
      throw error
    }

    return {
      agentState: currentAgentState,
      output: {
        type: 'error',
        message:
          hasServerMessage || isIdleTimeout || isNetworkError
            ? errorMessage
            : 'Agent run error: ' + errorMessage,
        ...(statusCode !== undefined && { statusCode }),
        ...(apiErrorDetails.errorCode !== undefined && {
          error: apiErrorDetails.errorCode,
        }),
        ...(apiErrorDetails.countryCode !== undefined && {
          countryCode: apiErrorDetails.countryCode,
        }),
        ...(apiErrorDetails.countryBlockReason !== undefined && {
          countryBlockReason: apiErrorDetails.countryBlockReason,
        }),
        ...(apiErrorDetails.ipPrivacySignals !== undefined && {
          ipPrivacySignals: apiErrorDetails.ipPrivacySignals,
        }),
      },
    }
  } finally {
    // The endTurn path inside runProgrammaticStep handles normal completion,
    // but abort/error exits (e.g. chat SSE disconnects) would otherwise leak
    // the run's generator, STEP_ALL flag, and proposed file content forever.
    clearProgrammaticRunState(runId)
  }
}

const STEP_WARNING_MESSAGE = [
  "I've made quite a few responses in a row.",
  "Let me pause here to make sure we're still on the right track.",
  "Please let me know if you'd like me to continue or if you'd like to guide me in a different direction.",
].join(' ')
