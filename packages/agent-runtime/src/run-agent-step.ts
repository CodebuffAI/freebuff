import { insertTrace } from '@codebuff/bigquery'
import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { supportsCacheControl } from '@codebuff/common/old-constants'
import { TOOLS_WHICH_WONT_FORCE_NEXT_STEP } from '@codebuff/common/tools/constants'
import { buildArray } from '@codebuff/common/util/array'
import { getErrorObject } from '@codebuff/common/util/error'
import { systemMessage, userMessage } from '@codebuff/common/util/messages'
import { cloneDeep } from 'lodash'

import { checkLiveUserInput } from './live-user-inputs'
import { getMCPToolData } from './mcp'
import { getAgentStreamFromTemplate } from './prompt-agent-stream'
import { runProgrammaticStep } from './run-programmatic-step'
import { additionalSystemPrompts } from './system-prompt/prompts'
import { getAgentTemplate } from './templates/agent-registry'
import { getAgentPrompt } from './templates/strings'
import { getToolSet } from './tools/prompts'
import { processStream } from './tools/stream-parser'
import { getAgentOutput } from './util/agent-output'
import {
  withSystemInstructionTags,
  withSystemTags as withSystemTags,
  buildUserMessageContent,
  expireMessages,
} from './util/messages'
import { countTokensJson } from './util/token-counter'

import type { AgentResponseTrace } from '@codebuff/bigquery'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type {
  AddAgentStepFn,
  FinishAgentRunFn,
  StartAgentRunFn,
} from '@codebuff/common/types/contracts/database'
import type { CheckLiveUserInputFn } from '@codebuff/common/types/contracts/live-user-input'
import type { PromptAiSdkFn } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  ParamsExcluding,
  ParamsOf,
} from '@codebuff/common/types/function-params'
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

export const runAgentStep = async (
  params: {
    userId: string | undefined
    userInputId: string
    clientSessionId: string
    fingerprintId: string
    repoId: string | undefined
    onResponseChunk: (chunk: string | PrintModeEvent) => void

    agentType: AgentTemplateType
    fileContext: ProjectFileContext
    agentState: AgentState
    localAgentTemplates: Record<string, AgentTemplate>

    prompt: string | undefined
    spawnParams: Record<string, any> | undefined
    system: string
    n?: number

    trackEvent: TrackEventFn
    promptAiSdk: PromptAiSdkFn
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
    clientSessionId,
    fileContext,
    fingerprintId,
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
    trackEvent,
  } = params
  let agentState = params.agentState

  const { agentContext } = agentState

  const startTime = Date.now()

  // Generates a unique ID for each main prompt run (ie: a step of the agent loop)
  // This is used to link logs within a single agent loop
  const agentStepId = crypto.randomUUID()
  trackEvent({
    event: AnalyticsEvent.AGENT_STEP,
    userId: userId ?? '',
    properties: {
      agentStepId,
      clientSessionId,
      fingerprintId,
      userInputId,
      userId,
      repoName: repoId,
    },
    logger,
  })

  let messageHistory = agentState.messageHistory

  // Check if we need to warn about too many consecutive responses
  const needsStepWarning = agentState.stepsRemaining <= 0
  let stepWarningMessage = ''

  if (needsStepWarning) {
    logger.warn(
      `Detected too many consecutive assistant messages without user prompt`,
    )

    stepWarningMessage = [
      "I've made quite a few responses in a row.",
      "Let me pause here to make sure we're still on the right track.",
      "Please let me know if you'd like me to continue or if you'd like to guide me in a different direction.",
    ].join(' ')

    onResponseChunk(`${stepWarningMessage}\n\n`)

    // Update message history to include the warning
    agentState = {
      ...agentState,
      messageHistory: [
        ...expireMessages(messageHistory, 'userPrompt'),
        userMessage(
          withSystemTags(
            `The assistant has responded too many times in a row. The assistant's turn has automatically been ended. The number of responses can be changed in codebuff.json.`,
          ),
        ),
      ],
    }
  }

  const agentTemplate = await getAgentTemplate({
    ...params,
    agentId: agentType,
  })
  if (!agentTemplate) {
    throw new Error(
      `Agent template not found for type: ${agentType}. Available types: ${Object.keys(localAgentTemplates).join(', ')}`,
    )
  }

  const stepPrompt = await getAgentPrompt({
    ...params,
    agentTemplate,
    promptType: { type: 'stepPrompt' },
    fileContext,
    agentState,
    agentTemplates: localAgentTemplates,
    logger,
  })

  const agentMessagesUntruncated = buildArray<Message>(
    ...expireMessages(messageHistory, 'agentStep'),

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

  // Early return for step warning case
  if (needsStepWarning) {
    return {
      agentState,
      fullResponse: stepWarningMessage,
      shouldEndTurn: true,
      messageId: null,
    }
  }

  const { model } = agentTemplate

  let stepCreditsUsed = 0

  const onCostCalculated = async (credits: number) => {
    stepCreditsUsed += credits
    agentState.creditsUsed += credits
    agentState.directCreditsUsed += credits
  }

  const iterationNum = agentState.messageHistory.length
  const systemTokens = countTokensJson(system)

  logger.debug(
    {
      iteration: iterationNum,
      agentId: agentState.agentId,
      model,
      duration: Date.now() - startTime,
      agentMessages: agentState.messageHistory,
      system,
      prompt,
      params: spawnParams,
      agentContext,
      systemTokens,
      agentTemplate,
    },
    `Start agent ${agentType} step ${iterationNum} (${userInputId}${prompt ? ` - Prompt: ${prompt.slice(0, 20)}` : ''})`,
  )

  // Handle n parameter for generating multiple responses
  if (params.n !== undefined) {
    const responsesString = await promptAiSdk({
      ...params,
      messages: agentState.messageHistory,
      model,
      n: params.n,
      onCostCalculated,
    })

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
    includeCacheControl: supportsCacheControl(agentTemplate.model),
    messages: [systemMessage(system), ...agentState.messageHistory],
    template: agentTemplate,
    onCostCalculated,
  })

  const {
    fullResponse: fullResponseAfterStream,
    fullResponseChunks,
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

  const agentResponseTrace: AgentResponseTrace = {
    type: 'agent-response',
    created_at: new Date(),
    agent_step_id: agentStepId,
    user_id: userId ?? '',
    id: crypto.randomUUID(),
    payload: {
      output: fullResponse,
      user_input_id: userInputId,
      client_session_id: clientSessionId,
      fingerprint_id: fingerprintId,
    },
  }

  insertTrace({ trace: agentResponseTrace, logger })

  agentState.messageHistory = expireMessages(
    agentState.messageHistory,
    'agentStep',
  )

  // Handle /compact command: replace message history with the summary
  const wasCompacted =
    prompt &&
    (prompt.toLowerCase() === '/compact' || prompt.toLowerCase() === 'compact')
  if (wasCompacted) {
    agentState.messageHistory = [
      userMessage(
        withSystemTags(
          `The following is a summary of the conversation between you and the user. The conversation continues after this summary:\n\n${fullResponse}`,
        ),
      ),
    ]
    logger.debug({ summary: fullResponse }, 'Compacted messages')
  }

  const hasNoToolResults =
    toolCalls.filter(
      (call) => !TOOLS_WHICH_WONT_FORCE_NEXT_STEP.includes(call.toolName),
    ).length === 0 &&
    toolResults.filter(
      (result) => !TOOLS_WHICH_WONT_FORCE_NEXT_STEP.includes(result.toolName),
    ).length === 0

  const hasTaskCompleted = toolCalls.some(
    (call) =>
      call.toolName === 'task_completed' || call.toolName === 'end_turn',
  )

  // If the agent has the task_completed tool, it must be called to end its turn.
  const requiresExplicitCompletion =
    agentTemplate.toolNames.includes('task_completed')

  let shouldEndTurn: boolean
  if (requiresExplicitCompletion) {
    // For models requiring explicit completion, only end turn when:
    // - task_completed is called, OR
    // - end_turn is called (backward compatibility)
    shouldEndTurn = hasTaskCompleted
  } else {
    // For other models, also end turn when there are no tool calls
    shouldEndTurn = hasTaskCompleted || hasNoToolResults
  }

  agentState = {
    ...agentState,
    stepsRemaining: agentState.stepsRemaining - 1,
    agentContext,
  }

  logger.debug(
    {
      iteration: iterationNum,
      agentId: agentState.agentId,
      model,
      prompt,
      shouldEndTurn,
      duration: Date.now() - startTime,
      fullResponse,
      finalMessageHistoryWithToolResults: agentState.messageHistory,
      toolCalls,
      toolResults,
      agentContext,
      fullResponseChunks,
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

export async function loopAgentSteps(
  params: {
    addAgentStep: AddAgentStepFn
    agentState: AgentState
    agentType: AgentTemplateType
    clearUserPromptMessagesAfterResponse?: boolean
    clientSessionId: string
    content?: Array<TextPart | ImagePart>
    fileContext: ProjectFileContext
    finishAgentRun: FinishAgentRunFn
    localAgentTemplates: Record<string, AgentTemplate>
    logger: Logger
    parentSystemPrompt?: string
    prompt: string | undefined
    signal: AbortSignal
    spawnParams: Record<string, any> | undefined
    startAgentRun: StartAgentRunFn
    userId: string | undefined
    userInputId: string
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
    ParamsOf<CheckLiveUserInputFn> &
    ParamsExcluding<StartAgentRunFn, 'agentId' | 'ancestorRunIds'> &
    ParamsExcluding<
      FinishAgentRunFn,
      'runId' | 'status' | 'totalSteps' | 'directCredits' | 'totalCredits'
    > &
    ParamsExcluding<
      typeof runAgentStep,
      | 'additionalToolDefinitions'
      | 'agentState'
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
  const {
    addAgentStep,
    agentState,
    agentType,
    clearUserPromptMessagesAfterResponse = true,
    clientSessionId,
    content,
    fileContext,
    finishAgentRun,
    localAgentTemplates,
    logger,
    parentSystemPrompt,
    prompt,
    signal,
    spawnParams,
    startAgentRun,
    userId,
    userInputId,
  } = params

  const agentTemplate = await getAgentTemplate({
    ...params,
    agentId: agentType,
  })
  if (!agentTemplate) {
    throw new Error(`Agent template not found for type: ${agentType}`)
  }

  if (signal.aborted) {
    return {
      agentState,
      output: {
        type: 'error',
        message: 'Run cancelled by user',
      },
    }
  }

  const runId = await startAgentRun({
    ...params,
    agentId: agentTemplate.id,
    ancestorRunIds: agentState.ancestorRunIds,
  })
  if (!runId) {
    throw new Error('Failed to start agent run')
  }
  agentState.runId = runId

  let cachedAdditionalToolDefinitions: CustomToolDefinitions | undefined
  // Initialize message history with user prompt and instructions on first iteration
  const instructionsPrompt = await getAgentPrompt({
    ...params,
    agentTemplate,
    promptType: { type: 'instructionsPrompt' },
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

  // Build the initial message history with user prompt and instructions
  // Generate system prompt once, using parent's if inheritParentSystemPrompt is true
  const system =
    agentTemplate.inheritParentSystemPrompt && parentSystemPrompt
      ? parentSystemPrompt
      : (await getAgentPrompt({
          ...params,
          agentTemplate,
          promptType: { type: 'systemPrompt' },
          agentTemplates: localAgentTemplates,
          additionalToolDefinitions: async () => {
            if (!cachedAdditionalToolDefinitions) {
              cachedAdditionalToolDefinitions = await additionalToolDefinitions(
                {
                  ...params,
                  agentTemplate,
                },
              )
            }
            return cachedAdditionalToolDefinitions
          },
        })) ?? ''

  const tools = await getToolSet({
    toolNames: agentTemplate.toolNames,
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

  const hasUserMessage = Boolean(
    prompt ||
      (spawnParams && Object.keys(spawnParams).length > 0) ||
      (content && content.length > 0),
  )

  const initialMessages = buildArray<Message>(
    ...agentState.messageHistory,

    hasUserMessage && [
      {
        // Actual user message!
        role: 'user' as const,
        content: buildUserMessageContent(prompt, spawnParams, content),
        tags: ['USER_PROMPT'],

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

  let currentAgentState: AgentState = {
    ...agentState,
    messageHistory: initialMessages,
  }
  let shouldEndTurn = false
  let hasRetriedOutputSchema = false
  let currentPrompt = prompt
  let currentParams = spawnParams
  let totalSteps = 0
  let nResponses: string[] | undefined = undefined

  try {
    while (true) {
      totalSteps++
      if (!checkLiveUserInput(params)) {
        logger.warn(
          {
            userId,
            userInputId,
            clientSessionId,
            totalSteps,
            runId,
            agentState,
          },
          'User input no longer live (likely cancelled)',
        )
        break
      }

      const startTime = new Date()

      // 1. Run programmatic step first if it exists
      let n: number | undefined = undefined

      if (agentTemplate.handleSteps) {
        const programmaticResult = await runProgrammaticStep({
          ...params,

          agentState: currentAgentState,
          localAgentTemplates,
          nResponses,
          onCostCalculated: async (credits: number) => {
            agentState.creditsUsed += credits
            agentState.directCreditsUsed += credits
          },
          prompt: currentPrompt,
          runId,
          stepNumber: totalSteps,
          stepsComplete: shouldEndTurn,
          system,
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

        currentAgentState = programmaticAgentState
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
      const {
        agentState: newAgentState,
        shouldEndTurn: llmShouldEndTurn,
        messageId,
        nResponses: generatedResponses,
      } = await runAgentStep({
        ...params,

        agentState: currentAgentState,
        n,
        prompt: currentPrompt,
        runId,
        spawnParams: currentParams,
        system,
        tools,

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

      currentAgentState = newAgentState
      shouldEndTurn = llmShouldEndTurn
      nResponses = generatedResponses

      currentPrompt = undefined
      currentParams = undefined
    }

    if (clearUserPromptMessagesAfterResponse) {
      currentAgentState.messageHistory = expireMessages(
        currentAgentState.messageHistory,
        'userPrompt',
      )
    }

    const status = checkLiveUserInput(params) ? 'completed' : 'cancelled'
    await finishAgentRun({
      ...params,
      runId,
      status,
      totalSteps,
      directCredits: currentAgentState.directCreditsUsed,
      totalCredits: currentAgentState.creditsUsed,
    })

    return {
      agentState: currentAgentState,
      output: getAgentOutput(currentAgentState, agentTemplate),
    }
  } catch (error) {
    logger.error(
      {
        error: getErrorObject(error),
        agentType,
        agentId: currentAgentState.agentId,
        runId,
        totalSteps,
        directCreditsUsed: currentAgentState.directCreditsUsed,
        creditsUsed: currentAgentState.creditsUsed,
      },
      'Agent execution failed',
    )

    // Re-throw NetworkError and PaymentRequiredError to allow SDK retry wrapper to handle it
    if (error instanceof Error && (error.name === 'NetworkError' || error.name === 'PaymentRequiredError')) {
      throw error
    }

    // Extract clean error message (just the message, not name:message format)
    const errorMessage = error instanceof Error ? error.message : String(error)

    const status = checkLiveUserInput(params) ? 'failed' : 'cancelled'
    await finishAgentRun({
      ...params,
      runId,
      status,
      totalSteps,
      directCredits: currentAgentState.directCreditsUsed,
      totalCredits: currentAgentState.creditsUsed,
      errorMessage,
    })

    return {
      agentState: currentAgentState,
      output: {
        type: 'error',
        message: errorMessage,
      },
    }
  }
}
