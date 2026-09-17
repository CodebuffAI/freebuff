import { mapValues } from 'lodash'

import {
  validateAndGetAgentTemplate,
  validateAgentInput,
  executeSubagent,
  createAgentState,
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
import type { ProjectFileContext } from '@codebuff/common/util/file'
import type { ToolSet } from 'ai'

type ToolName = 'spawn_agent_inline'
export const handleSpawnAgentInline = (async (
  params: {
    previousToolCallFinished: Promise<void>
    toolCall: CodebuffToolCall<ToolName>

    agentState: AgentState
    agentTemplate: AgentTemplate
    clientSessionId: string
    currentAssistantMessages?: readonly Message[]
    fileContext: ProjectFileContext
    fingerprintId: string
    localAgentTemplates: Record<string, AgentTemplate>
    logger: Logger
    system: string
    tools: ToolSet
    userId: string | undefined
    userInputId: string
    writeToClient: (chunk: string | PrintModeEvent) => void
  } & ParamsExcluding<
    typeof executeSubagent,
    | 'userInputId'
    | 'prompt'
    | 'spawnParams'
    | 'agentTemplate'
    | 'parentAgentState'
    | 'agentState'
    | 'parentSystemPrompt'
    | 'parentTools'
    | 'onResponseChunk'
    | 'clearUserPromptMessagesAfterResponse'
    | 'fingerprintId'
  >,
): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const {
    previousToolCallFinished,
    toolCall,

    agentState: parentAgentState,
    agentTemplate: parentAgentTemplate,
    currentAssistantMessages = [],
    fingerprintId,
    system,
    tools: parentTools,
    userInputId,
    writeToClient,
    sendSubagentChunk,
    logger,
  } = params
  const {
    agent_type: agentTypeStr,
    prompt,
    params: spawnParams,
  } = toolCall.input

  await previousToolCallFinished

  const { agentTemplate, agentType } = await validateAndGetAgentTemplate({
    agentTypeStr,
    parentAgentTemplate,
    localAgentTemplates: params.localAgentTemplates,
    logger,
    fetchAgentFromDatabase: params.fetchAgentFromDatabase,
    databaseAgentCache: params.databaseAgentCache,
    apiKey: params.apiKey,
  })

  validateAgentInput(agentTemplate, agentType, prompt, spawnParams)

  // Override template for inline agent to share system prompt & message history with parent
  const inlineTemplate = {
    ...agentTemplate,
    includeMessageHistory: true,
    inheritParentSystemPrompt: true,
  }

  // Create child agent state that shares message history with parent
  const childAgentState: AgentState = {
    ...createAgentState(
      agentType,
      inlineTemplate,
      parentAgentState,
      parentAgentState.agentContext,
      {
        toolCallId: toolCall.toolCallId,
        currentAssistantMessages,
      },
    ),
    systemPrompt: system,
    toolDefinitions: mapValues(parentTools, (tool) => ({
      description:
        typeof tool.description === 'string' ? tool.description : undefined,
      inputSchema: tool.inputSchema as {},
    })),
  }

  // Extract common context params to avoid bugs from spreading all params
  const contextParams = extractSubagentContextParams(params)

  const result = await executeSubagent({
    ...contextParams,

    // Spawn-specific params
    ancestorRunIds: parentAgentState.ancestorRunIds,
    userInputId: `${userInputId}-inline-${agentType}${childAgentState.agentId}`,
    prompt: prompt || '',
    spawnParams,
    agentTemplate: inlineTemplate,
    parentAgentState,
    agentState: childAgentState,
    fingerprintId,
    parentSystemPrompt: system,
    parentTools,
    onResponseChunk: (chunk) => {
      // Context pruning is internal and its raw summary would be noisy in the
      // client, but lifecycle events still need to flow so the UI can explain
      // the otherwise silent pause.
      if (typeof chunk === 'string') {
        if (agentType !== 'context-pruner') {
          sendSubagentChunk({
            userInputId,
            agentId: childAgentState.agentId,
            agentType,
            chunk,
            prompt,
          })
        }
        return
      }
      const isLifecycleEvent =
        chunk.type === 'subagent_start' || chunk.type === 'subagent_finish'
      if (agentType === 'context-pruner' && !isLifecycleEvent) return
      if (chunk.type === 'text') {
        if (chunk.text) {
          sendSubagentChunk({
            userInputId,
            agentId: childAgentState.agentId,
            agentType,
            chunk: chunk.text,
            prompt,
          })
        }
        return
      }
      writeToClient(chunk)
    },
    clearUserPromptMessagesAfterResponse: false,
  })

  // Update parent agent state to reflect shared message history
  parentAgentState.messageHistory = result.agentState.messageHistory

  return { output: [{ type: 'json', value: { message: 'Agent spawned.' } }] }
}) satisfies CodebuffToolHandlerFunction<ToolName>
