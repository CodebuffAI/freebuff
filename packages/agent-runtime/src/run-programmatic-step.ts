import { getErrorObject } from '@codebuff/common/util/error'
import { assistantMessage } from '@codebuff/common/util/messages'
import { cloneDeep } from 'lodash'

import { executeToolCall } from './tools/tool-executor'
import { parseTextWithToolCalls } from './util/parse-tool-calls-from-text'

import type { ParsedSegment } from './util/parse-tool-calls-from-text'

import type { FileProcessingState } from './tools/handlers/tool/write-file'
import type { ExecuteToolCallParams } from './tools/tool-executor'
import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import { HandleStepsYieldValueSchema } from '@codebuff/common/types/agent-template'

import type {
  AgentTemplate,
  StepGenerator,
  PublicAgentState,
} from '@codebuff/common/types/agent-template'
import type {
  HandleStepsLogChunkFn,
  SendActionFn,
} from '@codebuff/common/types/contracts/client'
import type { AddAgentStepFn } from '@codebuff/common/types/contracts/database'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { ToolMessage } from '@codebuff/common/types/messages/codebuff-message'
import type {
  ToolCallPart,
  ToolResultOutput,
} from '@codebuff/common/types/messages/content-part'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { AgentState } from '@codebuff/common/types/session-state'
// Maintains generator state for all agents. Generator state can't be serialized, so we store it in memory.
const runIdToGenerator: Record<string, StepGenerator | undefined> = {}
export const runIdToStepAll: Set<string> = new Set()

// Function to clear the generator cache for testing purposes
export function clearAgentGeneratorCache(params: { logger: Logger }) {
  for (const key in runIdToGenerator) {
    delete runIdToGenerator[key]
  }
  runIdToStepAll.clear()
}

// Function to handle programmatic agents
export async function runProgrammaticStep(
  params: {
    addAgentStep: AddAgentStepFn
    agentState: AgentState
    clientSessionId: string
    fingerprintId: string
    handleStepsLogChunk: HandleStepsLogChunkFn
    localAgentTemplates: Record<string, AgentTemplate>
    logger: Logger
    nResponses?: string[]
    onResponseChunk: (chunk: string | PrintModeEvent) => void
    prompt: string | undefined
    repoId: string | undefined
    repoUrl: string | undefined
    stepNumber: number
    stepsComplete: boolean
    template: AgentTemplate
    toolCallParams: Record<string, any> | undefined
    sendAction: SendActionFn
    system: string | undefined
    userId: string | undefined
    userInputId: string
  } & Omit<
    ExecuteToolCallParams,
    | 'toolName'
    | 'input'
    | 'autoInsertEndStepParam'
    | 'excludeToolFromMessageHistory'
    | 'agentContext'
    | 'agentStepId'
    | 'agentTemplate'
    | 'fullResponse'
    | 'previousToolCallFinished'
    | 'fileProcessingState'
    | 'toolCallId'
    | 'toolCalls'
    | 'toolResults'
    | 'toolResultsToAddAfterStream'
  > &
    ParamsExcluding<
      AddAgentStepFn,
      | 'agentRunId'
      | 'stepNumber'
      | 'credits'
      | 'childRunIds'
      | 'status'
      | 'startTime'
      | 'messageId'
    >,
): Promise<{
  agentState: AgentState
  endTurn: boolean
  stepNumber: number
  generateN?: number
}> {
  const {
    agentState,
    template,
    clientSessionId,
    prompt,
    toolCallParams,
    nResponses,
    system,
    userId,
    userInputId,
    repoId,
    fingerprintId,
    onResponseChunk,
    localAgentTemplates,
    stepsComplete,
    handleStepsLogChunk,
    sendAction,
    addAgentStep,
    logger,
  } = params
  let { stepNumber } = params

  if (!template.handleSteps) {
    throw new Error('No step handler found for agent template ' + template.id)
  }

  if (!agentState.runId) {
    throw new Error('Agent state has no run ID')
  }

  // Run with either a generator or a sandbox.
  let generator = runIdToGenerator[agentState.runId]

  // Check if we need to initialize a generator
  if (!generator) {
    const createLogMethod =
      (level: 'debug' | 'info' | 'warn' | 'error') =>
      (data: any, msg?: string) => {
        logger[level](data, msg) // Log to backend
        handleStepsLogChunk({
          userInputId,
          runId: agentState.runId ?? 'undefined',
          level,
          data,
          message: msg,
        })
      }

    const streamingLogger = {
      debug: createLogMethod('debug'),
      info: createLogMethod('info'),
      warn: createLogMethod('warn'),
      error: createLogMethod('error'),
    }

    const generatorFn =
      typeof template.handleSteps === 'string'
        ? eval(`(${template.handleSteps})`)
        : template.handleSteps

    // Initialize native generator
    generator = generatorFn({
      agentState,
      prompt,
      params: toolCallParams,
      logger: streamingLogger,
    })
    runIdToGenerator[agentState.runId] = generator
  }

  // Check if we're in STEP_ALL mode
  if (runIdToStepAll.has(agentState.runId)) {
    if (stepsComplete) {
      // Clear the STEP_ALL mode. Stepping can continue if handleSteps doesn't return.
      runIdToStepAll.delete(agentState.runId)
    } else {
      return { agentState, endTurn: false, stepNumber }
    }
  }

  const agentStepId = crypto.randomUUID()

  // Initialize state for tool execution
  const toolCalls: CodebuffToolCall[] = []
  const toolResults: ToolMessage[] = []
  const fileProcessingState: FileProcessingState = {
    promisesByPath: {},
    allPromises: [],
    fileChangeErrors: [],
    fileChanges: [],
    firstFileProcessed: false,
  }
  const agentContext = cloneDeep(agentState.agentContext)
  const sendSubagentChunk = (data: {
    userInputId: string
    agentId: string
    agentType: string
    chunk: string
    prompt?: string
    forwardToPrompt?: boolean
  }) => {
    sendAction({
      action: {
        type: 'subagent-response-chunk',
        ...data,
      },
    })
  }

  let toolResult: ToolResultOutput[] | undefined = undefined
  let endTurn = false
  let generateN: number | undefined = undefined

  let startTime = new Date()
  let creditsBefore = agentState.directCreditsUsed
  let childrenBefore = agentState.childRunIds.length

  try {
    // Execute tools synchronously as the generator yields them
    do {
      startTime = new Date()
      creditsBefore = agentState.directCreditsUsed
      childrenBefore = agentState.childRunIds.length

      const result = generator!.next({
        agentState: getPublicAgentState(
          agentState as AgentState & Required<Pick<AgentState, 'runId'>>,
        ),
        toolResult: toolResult ?? [],
        stepsComplete,
        nResponses,
      })

      if (result.done) {
        endTurn = true
        break
      }

      // Validate the yield value from handleSteps
      const parseResult = HandleStepsYieldValueSchema.safeParse(result.value)
      if (!parseResult.success) {
        throw new Error(
          `Invalid yield value from handleSteps in agent ${template.id}: ${parseResult.error.message}. ` +
            `Received: ${JSON.stringify(result.value)}`,
        )
      }

      if (result.value === 'STEP') {
        break
      }
      if (result.value === 'STEP_ALL') {
        runIdToStepAll.add(agentState.runId)
        break
      }

      if ('type' in result.value && result.value.type === 'STEP_TEXT') {
        // Parse text and tool calls, preserving interleaved order
        const segments = parseTextWithToolCalls(result.value.text)

        if (segments.length > 0) {
          // Execute segments (text and tool calls) in order
          toolResult = await executeSegmentsArray(segments, {
            ...params,
            agentContext,
            agentStepId,
            agentTemplate: template,
            agentState,
            fileProcessingState,
            fullResponse: '',
            previousToolCallFinished: Promise.resolve(),
            toolCalls,
            toolResults,
            onResponseChunk,
          })
        }
        break
      }

      if ('type' in result.value && result.value.type === 'GENERATE_N') {
        logger.info({ resultValue: result.value }, 'GENERATE_N yielded')
        // Handle GENERATE_N: generate n responses using the LLM
        generateN = result.value.n
        endTurn = false
        break
      }

      // Process tool calls yielded by the generator
      const toolCall = result.value as ToolCallToExecute

      toolResult = await executeSingleToolCall(toolCall, {
        ...params,
        agentContext,
        agentStepId,
        agentTemplate: template,
        agentState,
        fileProcessingState,
        fullResponse: '',
        previousToolCallFinished: Promise.resolve(),
        toolCalls,
        toolResults,
        onResponseChunk,
      })

      if (agentState.runId) {
        await addAgentStep({
          ...params,
          agentRunId: agentState.runId,
          stepNumber,
          credits: agentState.directCreditsUsed - creditsBefore,
          childRunIds: agentState.childRunIds.slice(childrenBefore),
          status: 'completed',
          startTime,
          messageId: null,
        })
      } else {
        logger.error('No runId found for agent state after finishing agent run')
      }
      stepNumber++

      if (toolCall.toolName === 'end_turn') {
        endTurn = true
        break
      }
    } while (true)

    return {
      agentState,
      endTurn,
      stepNumber,
      generateN,
    }
  } catch (error) {
    endTurn = true

    const errorMessage = `Error executing handleSteps for agent ${template.id}: ${
      error instanceof Error ? error.message : 'Unknown error'
    }`
    logger.error(
      { error: getErrorObject(error), template: template.id },
      errorMessage,
    )

    onResponseChunk(errorMessage)

    agentState.messageHistory.push(assistantMessage(errorMessage))
    agentState.output = {
      ...agentState.output,
      error: errorMessage,
    }

    if (agentState.runId) {
      await addAgentStep({
        ...params,
        agentRunId: agentState.runId,
        stepNumber,
        credits: agentState.directCreditsUsed - creditsBefore,
        childRunIds: agentState.childRunIds.slice(childrenBefore),
        status: 'skipped',
        startTime,
        errorMessage,
        messageId: null,
        logger,
      })
    } else {
      logger.error('No runId found for agent state after failed agent run')
    }
    stepNumber++

    return {
      agentState,
      endTurn,
      stepNumber,
      generateN: undefined,
    }
  } finally {
    if (endTurn) {
      delete runIdToGenerator[agentState.runId]
      runIdToStepAll.delete(agentState.runId)
    }
  }
}

export const getPublicAgentState = (
  agentState: AgentState & Required<Pick<AgentState, 'runId'>>,
): PublicAgentState => {
  const { agentId, runId, parentId, messageHistory, output } = agentState
  return {
    agentId,
    runId,
    parentId,
    messageHistory: messageHistory as any as PublicAgentState['messageHistory'],
    output,
  }
}

/**
 * Represents a tool call to be executed.
 * Can optionally include `includeToolCall: false` to exclude from message history.
 */
type ToolCallToExecute = {
  toolName: string
  input: Record<string, unknown>
  includeToolCall?: boolean
}

/**
 * Parameters for executing an array of tool calls.
 */
type ExecuteToolCallsArrayParams = Omit<
  ExecuteToolCallParams,
  | 'toolName'
  | 'input'
  | 'autoInsertEndStepParam'
  | 'excludeToolFromMessageHistory'
  | 'toolCallId'
  | 'toolResultsToAddAfterStream'
> & {
  agentState: AgentState
  onResponseChunk: (chunk: string | PrintModeEvent) => void
}

/**
 * Executes a single tool call.
 * Adds the tool call as an assistant message and then executes it.
 *
 * @returns The tool result from the executed tool call.
 */
async function executeSingleToolCall(
  toolCallToExecute: ToolCallToExecute,
  params: ExecuteToolCallsArrayParams,
): Promise<ToolResultOutput[] | undefined> {
  const { agentState, onResponseChunk, toolResults } = params

  // Note: We don't check if the tool is available for the agent template anymore.
  // You can run any tool from handleSteps now!
  // if (!template.toolNames.includes(toolCall.toolName)) {
  //   throw new Error(
  //     `Tool ${toolCall.toolName} is not available for agent ${template.id}. Available tools: ${template.toolNames.join(', ')}`,
  //   )
  // }

  const toolCallId = crypto.randomUUID()
  const excludeToolFromMessageHistory =
    toolCallToExecute.includeToolCall === false

  // Add assistant message with the tool call before executing it
  if (!excludeToolFromMessageHistory) {
    const toolCallPart: ToolCallPart = {
      type: 'tool-call',
      toolCallId,
      toolName: toolCallToExecute.toolName,
      input: toolCallToExecute.input,
    }
    // onResponseChunk({
    //   ...toolCallPart,
    //   type: 'tool_call',
    //   agentId: agentState.agentId,
    //   parentAgentId: agentState.parentId,
    // })
    // NOTE(James): agentState.messageHistory is readonly for some reason (?!). Recreating the array is a workaround.
    agentState.messageHistory = [...agentState.messageHistory]
    agentState.messageHistory.push(assistantMessage(toolCallPart))
    // Optional call handles both top-level and nested agents
    // sendSubagentChunk({
    //   userInputId,
    //   agentId: agentState.agentId,
    //   agentType: agentState.agentType!,
    //   chunk: toolCallString,
    //   forwardToPrompt: !agentState.parentId,
    // })
  }

  // Execute the tool call
  await executeToolCall({
    ...params,
    toolName: toolCallToExecute.toolName as any,
    input: toolCallToExecute.input,
    autoInsertEndStepParam: true,
    excludeToolFromMessageHistory,
    fromHandleSteps: true,
    toolCallId,
    toolResultsToAddAfterStream: [],

    onResponseChunk: (chunk: string | PrintModeEvent) => {
      if (typeof chunk === 'string') {
        onResponseChunk(chunk)
        return
      }

      // Only add parentAgentId if this programmatic agent has a parent (i.e., it's nested)
      // This ensures we don't add parentAgentId to top-level spawns
      if (agentState.parentId) {
        const parentAgentId = agentState.agentId

        switch (chunk.type) {
          case 'subagent_start':
          case 'subagent_finish':
            if (!chunk.parentAgentId) {
              onResponseChunk({
                ...chunk,
                parentAgentId,
              })
              return
            }
            break
          case 'tool_call':
          case 'tool_result': {
            if (!chunk.parentAgentId) {
              onResponseChunk({
                ...chunk,
                parentAgentId,
              })
              return
            }
            break
          }
          default:
            break
        }
      }

      // For other events or top-level spawns, send as-is
      onResponseChunk(chunk)
    },
  })

  // Get the latest tool result
  return toolResults[toolResults.length - 1]?.content
}

/**
 * Executes an array of segments (text and tool calls) sequentially.
 * Text segments are added as assistant messages.
 * Tool calls are added as assistant messages and then executed.
 *
 * @returns The tool result from the last executed tool call.
 */
async function executeSegmentsArray(
  segments: ParsedSegment[],
  params: ExecuteToolCallsArrayParams,
): Promise<ToolResultOutput[] | undefined> {
  const { agentState } = params

  let toolResults: ToolResultOutput[] = []

  for (const segment of segments) {
    if (segment.type === 'text') {
      // Add text as an assistant message
      agentState.messageHistory = [...agentState.messageHistory]
      agentState.messageHistory.push(assistantMessage(segment.text))
    } else {
      // Handle tool call segment
      const toolResult = await executeSingleToolCall(segment, params)
      if (toolResult) {
        toolResults.push(...toolResult)
      }
    }
  }

  return toolResults
}
