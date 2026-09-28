import { jsonToolResult } from '@codebuff/common/util/messages'

import { outputForParent } from '../../../util/agent-output'
import {
  validateAndGetAgentTemplate,
  validateAgentInput,
  createAgentState,
  executeSubagent,
  extractSubagentContextParams,
} from './spawn-agent-utils'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { ToolSet } from 'ai'

export type SendSubagentChunk = (data: {
  userInputId: string
  agentId: string
  agentType: string
  chunk: string
  prompt?: string
  forwardToPrompt?: boolean
}) => void

type ToolName = 'spawn_agents'
export const handleSpawnAgents = (async (
  params: {
    previousToolCallFinished: Promise<void>
    toolCall: CodebuffToolCall<ToolName>

    agentState: AgentState
    agentTemplate: AgentTemplate
    currentAssistantMessages?: readonly Message[]
    fingerprintId: string
    localAgentTemplates: Record<string, AgentTemplate>
    logger: Logger
    system: string
    tools?: ToolSet
    userId: string | undefined
    userInputId: string
    sendSubagentChunk: SendSubagentChunk
    writeToClient: (chunk: string | PrintModeEvent) => void
  } & ParamsExcluding<
    typeof validateAndGetAgentTemplate,
    'agentTypeStr' | 'parentAgentTemplate'
  > &
    ParamsExcluding<
      typeof executeSubagent,
      | 'userInputId'
      | 'prompt'
      | 'spawnParams'
      | 'agentTemplate'
      | 'parentAgentState'
      | 'agentState'
      | 'fingerprintId'
      | 'isOnlyChild'
      | 'parentSystemPrompt'
      | 'parentTools'
      | 'onResponseChunk'
    >,
): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const {
    previousToolCallFinished,
    toolCall,

    agentState: parentAgentState,
    agentTemplate: parentAgentTemplate,
    currentAssistantMessages = [],
    fingerprintId,
    system: parentSystemPrompt,
    tools: parentTools = {},
    userInputId,
    sendSubagentChunk,
    writeToClient,
  } = params
  const { agents } = toolCall.input
  const { logger } = params

  await previousToolCallFinished

  const results = await Promise.allSettled(
    agents.map(
      async ({ agent_type: agentTypeStr, prompt, params: spawnParams }) => {
        const { agentTemplate, agentType } = await validateAndGetAgentTemplate({
          ...params,
          agentTypeStr,
          parentAgentTemplate,
        })

        validateAgentInput(agentTemplate, agentType, prompt, spawnParams)

        const subAgentState = createAgentState(
          agentType,
          agentTemplate,
          parentAgentState,
          {},
          {
            toolCallId: toolCall.toolCallId,
            currentAssistantMessages,
          },
        )

        // Extract common context params to avoid bugs from spreading all params
        const contextParams = extractSubagentContextParams(params)

        const result = await executeSubagent({
          ...contextParams,

          // Spawn-specific params
          ancestorRunIds: parentAgentState.ancestorRunIds,
          userInputId: `${userInputId}-${agentType}${subAgentState.agentId}`,
          prompt: prompt || '',
          spawnParams,
          agentTemplate,
          parentAgentState,
          agentState: subAgentState,
          fingerprintId,
          isOnlyChild: agents.length === 1,
          excludeToolFromMessageHistory: false,
          fromHandleSteps: false,
          parentSystemPrompt,
          parentTools: agentTemplate.inheritParentSystemPrompt
            ? parentTools
            : undefined,
          onResponseChunk: (chunk: string | PrintModeEvent) => {
            if (typeof chunk === 'string') {
              sendSubagentChunk({
                userInputId,
                agentId: subAgentState.agentId,
                agentType,
                chunk,
                prompt,
              })
              return
            }

            if (chunk.type === 'text') {
              if (chunk.text) {
                writeToClient({
                  type: 'text' as const,
                  agentId: subAgentState.agentId,
                  text: chunk.text,
                })
              }
              return
            }

            // Add parentAgentId for proper nesting in UI
            const ensureParentAgentId = () => {
              if (
                chunk.type === 'subagent_start' ||
                chunk.type === 'subagent_finish'
              ) {
                return (
                  chunk.parentAgentId ??
                  subAgentState.parentId ??
                  parentAgentState?.agentId
                )
              }
              if (chunk.type === 'tool_call' || chunk.type === 'tool_result') {
                return (chunk as any).parentAgentId ?? subAgentState.agentId
              }
              return undefined
            }

            const parentAgentId = ensureParentAgentId()
            if (
              parentAgentId !== undefined &&
              (chunk.type === 'subagent_start' ||
                chunk.type === 'subagent_finish' ||
                chunk.type === 'tool_call' ||
                chunk.type === 'tool_result')
            ) {
              writeToClient({ ...chunk, parentAgentId })
              return
            }

            const eventWithAgent = {
              ...chunk,
              agentId: subAgentState.agentId,
            }
            writeToClient(eventWithAgent)
          },
        })
        return { ...result, agentType, agentName: agentTemplate.displayName }
      },
    ),
  )

  const reports = await Promise.all(
    results.map(async (result, index) => {
      if (result.status === 'fulfilled') {
        const { output, agentType, agentName } = result.value
        return {
          agentName,
          agentType,
          value: outputForParent(output),
        }
      } else {
        const agentTypeStr = agents[index].agent_type
        return {
          agentType: agentTypeStr,
          agentName: agentTypeStr,
          value: { errorMessage: `Error spawning agent: ${result.reason}` },
        }
      }
    }),
  )

  // Aggregate costs from subagents
  results.forEach((result, index) => {
    const agentInfo = agents[index]
    let subAgentCredits = 0

    if (result.status === 'fulfilled') {
      subAgentCredits = result.value.agentState.creditsUsed || 0
      // Note (James): Try not to include frequent logs with narrow debugging value.
      // logger.debug(
      //   {
      //     parentAgentId: validatedState.agentState.agentId,
      //     subAgentType: agentInfo.agent_type,
      //     subAgentCredits,
      //   },
      //   'Aggregating successful subagent cost',
      // )
    } else if (result.reason?.agentState?.creditsUsed) {
      // Even failed agents may have incurred partial costs
      subAgentCredits = result.reason.agentState.creditsUsed || 0
      logger.debug(
        {
          parentAgentId: parentAgentState.agentId,
          subAgentType: agentInfo.agent_type,
          subAgentCredits,
        },
        'Aggregating failed subagent partial cost',
      )
    }

    if (subAgentCredits > 0) {
      parentAgentState.creditsUsed += subAgentCredits
      // Note (James): Try not to include frequent logs with narrow debugging value.
      // logger.debug(
      //   {
      //     parentAgentId: validatedState.agentState.agentId,
      //     addedCredits: subAgentCredits,
      //     totalCredits: validatedState.agentState.creditsUsed,
      //   },
      //   'Updated parent agent total cost',
      // )
    }
  })

  return { output: jsonToolResult(reports) }
}) satisfies CodebuffToolHandlerFunction<ToolName>
