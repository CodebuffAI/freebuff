import { endsAgentStepParam } from '@codebuff/common/tools/constants'
import { toolParams } from '@codebuff/common/tools/list'
import { jsonToolResult } from '@codebuff/common/util/messages'
import { generateCompactId } from '@codebuff/common/util/string'
import { cloneDeep } from 'lodash'

import { checkLiveUserInput } from '../live-user-inputs'
import { getMCPToolData } from '../mcp'
import { codebuffToolHandlers } from './handlers/list'

import type { AgentTemplate } from '../templates/types'
import type { CodebuffToolHandlerFunction } from './handlers/handler-function-type'
import type { FileProcessingState } from './handlers/tool/write-file'
import type { ToolName } from '@codebuff/common/tools/constants'
import type {
  ClientToolCall,
  ClientToolName,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ToolMessage } from '@codebuff/common/types/messages/codebuff-message'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { AgentState, Subgoal } from '@codebuff/common/types/session-state'
import type {
  CustomToolDefinitions,
  ProjectFileContext,
} from '@codebuff/common/util/file'
import type { ToolCallPart } from 'ai'

export type CustomToolCall = {
  toolName: string
  input: Record<string, unknown>
} & Omit<ToolCallPart, 'type'>

export type ToolCallError = {
  toolName?: string
  input: Record<string, unknown>
  error: string
} & Pick<CodebuffToolCall, 'toolCallId'>

export function parseRawToolCall<T extends ToolName = ToolName>(params: {
  rawToolCall: {
    toolName: T
    toolCallId: string
    input: Record<string, unknown>
  }
  autoInsertEndStepParam?: boolean
}): CodebuffToolCall<T> | ToolCallError {
  const { rawToolCall, autoInsertEndStepParam = false } = params
  const toolName = rawToolCall.toolName

  if (!(toolName in toolParams)) {
    return {
      toolName,
      toolCallId: rawToolCall.toolCallId,
      input: rawToolCall.input,
      error: `Tool ${toolName} not found`,
    }
  }
  const validName = toolName as T

  // const processedParameters: Record<string, any> = {}
  // for (const [param, val] of Object.entries(rawToolCall.input ?? {})) {
  //   processedParameters[param] = val
  // }

  // Add the required codebuff_end_step parameter with the correct value for this tool if requested
  // if (autoInsertEndStepParam) {
  //   processedParameters[endsAgentStepParam] =
  //     toolParams[validName].endsAgentStep
  // }

  // const paramsSchema = toolParams[validName].endsAgentStep
  //   ? (
  //       toolParams[validName].inputSchema satisfies z.ZodObject as z.ZodObject
  //     ).extend({
  //       [endsAgentStepParam]: z.literal(toolParams[validName].endsAgentStep),
  //     })
  //   : toolParams[validName].inputSchema

  const processedParameters = rawToolCall.input
  const paramsSchema = toolParams[validName].inputSchema

  const result = paramsSchema.safeParse(processedParameters)

  if (!result.success) {
    return {
      toolName: validName,
      toolCallId: rawToolCall.toolCallId,
      input: rawToolCall.input,
      error: `Invalid parameters for ${validName}: ${JSON.stringify(
        result.error.issues,
        null,
        2,
      )}`,
    }
  }

  if (endsAgentStepParam in result.data) {
    delete result.data[endsAgentStepParam]
  }

  return {
    toolName: validName,
    input: result.data,
    toolCallId: rawToolCall.toolCallId,
  } as CodebuffToolCall<T>
}

export type ExecuteToolCallParams<T extends string = ToolName> = {
  toolName: T
  input: Record<string, unknown>
  autoInsertEndStepParam?: boolean
  excludeToolFromMessageHistory?: boolean

  agentContext: Record<string, Subgoal>
  agentState: AgentState
  agentStepId: string
  ancestorRunIds: string[]
  agentTemplate: AgentTemplate
  clientSessionId: string
  fileContext: ProjectFileContext
  fileProcessingState: FileProcessingState
  fingerprintId: string
  fromHandleSteps?: boolean
  fullResponse: string
  localAgentTemplates: Record<string, AgentTemplate>
  logger: Logger
  previousToolCallFinished: Promise<void>
  prompt: string | undefined
  repoId: string | undefined
  repoUrl: string | undefined
  runId: string
  signal: AbortSignal
  system: string
  toolCallId: string | undefined
  toolCalls: (CodebuffToolCall | CustomToolCall)[]
  toolResults: ToolMessage[]
  toolResultsToAddAfterStream: ToolMessage[]
  userId: string | undefined
  userInputId: string

  fetch: typeof globalThis.fetch
  onCostCalculated: (credits: number) => Promise<void>
  onResponseChunk: (chunk: string | PrintModeEvent) => void
} & AgentRuntimeDeps &
  AgentRuntimeScopedDeps

export function executeToolCall<T extends ToolName>(
  params: ExecuteToolCallParams<T>,
): Promise<void> {
  const {
    toolName,
    input,
    autoInsertEndStepParam = false,
    excludeToolFromMessageHistory = false,
    fromHandleSteps = false,

    agentState,
    agentTemplate,
    logger,
    previousToolCallFinished,
    toolCalls,
    toolResults,
    toolResultsToAddAfterStream,
    userInputId,

    onCostCalculated,
    onResponseChunk,
    requestToolCall,
  } = params
  const toolCallId = params.toolCallId ?? generateCompactId()
  onResponseChunk({
    type: 'tool_call',
    toolCallId,
    toolName,
    input,
    agentId: agentState.agentId,
    parentAgentId: agentState.parentId,
    includeToolCall: !excludeToolFromMessageHistory,
  })

  const toolCall: CodebuffToolCall<T> | ToolCallError = parseRawToolCall<T>({
    rawToolCall: {
      toolName,
      toolCallId,
      input,
    },
    autoInsertEndStepParam,
  })
  if ('error' in toolCall) {
    const toolResult: ToolMessage = {
      role: 'tool',
      toolName,
      toolCallId: toolCall.toolCallId,
      content: jsonToolResult({
        errorMessage: toolCall.error,
      }),
    }
    toolResults.push(cloneDeep(toolResult))
    toolResultsToAddAfterStream.push(cloneDeep(toolResult))
    logger.debug(
      { toolCall, error: toolCall.error },
      `${toolName} error: ${toolCall.error}`,
    )
    return previousToolCallFinished
  }

  toolCalls.push(toolCall)

  // Filter out restricted tools
  if (
    !agentTemplate.toolNames.includes(toolCall.toolName) &&
    !fromHandleSteps
  ) {
    const toolResult: ToolMessage = {
      role: 'tool',
      toolName,
      toolCallId: toolCall.toolCallId,
      content: jsonToolResult({
        errorMessage: `Tool \`${toolName}\` is not currently available. Make sure to only use tools listed in the system instructions.`,
      }),
    }
    toolResults.push(cloneDeep(toolResult))
    toolResultsToAddAfterStream.push(cloneDeep(toolResult))
    return previousToolCallFinished
  }

  // Cast to any to avoid type errors
  const handler = codebuffToolHandlers[
    toolName
  ] as unknown as CodebuffToolHandlerFunction<T>
  const toolResultPromise = handler({
    ...params,
    previousToolCallFinished,
    writeToClient: onResponseChunk,
    requestClientToolCall: (async (
      clientToolCall: ClientToolCall<T extends ClientToolName ? T : never>,
    ) => {
      if (!checkLiveUserInput(params)) {
        return []
      }

      const clientToolResult = await requestToolCall({
        userInputId,
        toolName: clientToolCall.toolName,
        input: clientToolCall.input,
      })
      return clientToolResult.output as CodebuffToolOutput<T>
    }) as any,
    toolCall,
  })

  return toolResultPromise.then(async ({ output, creditsUsed }) => {
    const toolResult: ToolMessage = {
      role: 'tool',
      toolName,
      toolCallId: toolCall.toolCallId,
      content: output,
    }
    logger.debug(
      { input, toolResult },
      `${toolName} tool call & result (${toolResult.toolCallId})`,
    )

    onResponseChunk({
      type: 'tool_result',
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      output: toolResult.content,
    })

    toolResults.push(toolResult)

    if (!excludeToolFromMessageHistory) {
      agentState.messageHistory.push(toolResult)
    }

    // After tool completes, resolve any pending creditsUsed promise
    if (creditsUsed) {
      onCostCalculated(creditsUsed)
      logger.debug(
        { credits: creditsUsed, totalCredits: agentState.creditsUsed },
        `Added ${creditsUsed} credits from ${toolName} to agent state`,
      )
    }
  })
}

export function parseRawCustomToolCall(params: {
  customToolDefs: CustomToolDefinitions
  rawToolCall: {
    toolName: string
    toolCallId: string
    input: Record<string, unknown>
  }
  autoInsertEndStepParam?: boolean
}): CustomToolCall | ToolCallError {
  const { customToolDefs, rawToolCall, autoInsertEndStepParam = false } = params
  const toolName = rawToolCall.toolName

  if (
    !(customToolDefs && toolName in customToolDefs) &&
    !toolName.includes('/')
  ) {
    return {
      toolName,
      toolCallId: rawToolCall.toolCallId,
      input: rawToolCall.input,
      error: `Tool ${toolName} not found`,
    }
  }

  const processedParameters: Record<string, any> = {}
  for (const [param, val] of Object.entries(rawToolCall.input ?? {})) {
    processedParameters[param] = val
  }

  // Add the required codebuff_end_step parameter with the correct value for this tool if requested
  if (autoInsertEndStepParam) {
    processedParameters[endsAgentStepParam] =
      customToolDefs?.[toolName]?.endsAgentStep
  }

  const paramsSchema = customToolDefs?.[toolName]?.inputSchema
  const result = paramsSchema?.safeParse(processedParameters)

  if (result && !result.success) {
    return {
      toolName: toolName,
      toolCallId: rawToolCall.toolCallId,
      input: rawToolCall.input,
      error: `Invalid parameters for ${toolName}: ${JSON.stringify(
        result.error.issues,
        null,
        2,
      )}`,
    }
  }

  const input = JSON.parse(JSON.stringify(rawToolCall.input))
  if (endsAgentStepParam in input) {
    delete input[endsAgentStepParam]
  }
  return {
    toolName: toolName,
    input,
    toolCallId: rawToolCall.toolCallId,
  }
}

export async function executeCustomToolCall(
  params: ExecuteToolCallParams<string>,
): Promise<void> {
  const {
    toolName,
    input,
    autoInsertEndStepParam = false,
    excludeToolFromMessageHistory = false,
    fromHandleSteps = false,

    agentState,
    agentTemplate,
    fileContext,
    logger,
    onResponseChunk,
    previousToolCallFinished,
    requestToolCall,
    toolCallId,
    toolCalls,
    toolResults,
    toolResultsToAddAfterStream,
    userInputId,
  } = params
  const toolCall: CustomToolCall | ToolCallError = parseRawCustomToolCall({
    customToolDefs: await getMCPToolData({
      ...params,
      toolNames: agentTemplate.toolNames,
      mcpServers: agentTemplate.mcpServers,
      writeTo: cloneDeep(fileContext.customToolDefinitions),
    }),
    rawToolCall: {
      toolName,
      toolCallId: toolCallId ?? generateCompactId(),
      input,
    },
    autoInsertEndStepParam,
  })
  if ('error' in toolCall) {
    const toolResult: ToolMessage = {
      role: 'tool',
      toolName,
      toolCallId: toolCall.toolCallId,
      content: jsonToolResult({
        errorMessage: toolCall.error,
      }),
    }
    toolResults.push(cloneDeep(toolResult))
    toolResultsToAddAfterStream.push(cloneDeep(toolResult))
    logger.debug(
      { toolCall, error: toolCall.error },
      `${toolName} error: ${toolCall.error}`,
    )
    return previousToolCallFinished
  }

  onResponseChunk({
    type: 'tool_call',
    toolCallId: toolCall.toolCallId,
    toolName,
    input: toolCall.input,
    // Only include agentId for subagents (agents with a parent)
    ...(agentState?.parentId && { agentId: agentState.agentId }),
    // Include includeToolCall flag if explicitly set to false
    ...(excludeToolFromMessageHistory && { includeToolCall: false }),
  })

  toolCalls.push(toolCall)

  // Filter out restricted tools in ask mode unless exporting summary
  if (
    !(agentTemplate.toolNames as string[]).includes(toolCall.toolName) &&
    !fromHandleSteps &&
    !(
      toolCall.toolName.includes('/') &&
      toolCall.toolName.split('/')[0] in agentTemplate.mcpServers
    )
  ) {
    const toolResult: ToolMessage = {
      role: 'tool',
      toolName,
      toolCallId: toolCall.toolCallId,
      content: jsonToolResult({
        errorMessage: `Tool \`${toolName}\` is not currently available. Make sure to only use tools listed in the system instructions.`,
      }),
    }
    toolResults.push(cloneDeep(toolResult))
    toolResultsToAddAfterStream.push(cloneDeep(toolResult))
    return previousToolCallFinished
  }

  return previousToolCallFinished
    .then(async () => {
      if (!checkLiveUserInput(params)) {
        return null
      }

      const toolName = toolCall.toolName.includes('/')
        ? toolCall.toolName.split('/').slice(1).join('/')
        : toolCall.toolName
      const clientToolResult = await requestToolCall({
        userInputId,
        toolName,
        input: toolCall.input,
        mcpConfig: toolCall.toolName.includes('/')
          ? agentTemplate.mcpServers[toolCall.toolName.split('/')[0]]
          : undefined,
      })
      return clientToolResult.output satisfies ToolResultOutput[]
    })
    .then((result) => {
      if (result === null) {
        return
      }
      const toolResult = {
        role: 'tool',
        toolName,
        toolCallId: toolCall.toolCallId,
        content: result,
      } satisfies ToolMessage
      logger.debug(
        { input, toolResult },
        `${toolName} custom tool call & result (${toolResult.toolCallId})`,
      )
      if (result === undefined) {
        return
      }

      onResponseChunk({
        type: 'tool_result',
        toolName: toolResult.toolName,
        toolCallId: toolResult.toolCallId,
        output: toolResult.content,
      })

      toolResults.push(toolResult)

      if (!excludeToolFromMessageHistory) {
        agentState.messageHistory.push(toolResult)
      }
      return
    })
}
