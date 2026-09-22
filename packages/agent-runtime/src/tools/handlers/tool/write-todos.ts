import { jsonToolResult } from '@codebuff/common/util/messages'

import {
  hasFileEditTool,
  latestRecordedTodoListKey,
  todoListKey,
  writeTodosUnchangedMessage,
} from '../../../util/todo-loop'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { Logger } from '@codebuff/common/types/contracts/logger'

type ToolName = 'write_todos'
export const handleWriteTodos = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  agentState?: AgentState
  agentTemplate?: AgentTemplate
  logger?: Logger
  runId?: string
  userId?: string
}): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const {
    previousToolCallFinished,
    toolCall,
    agentState,
    agentTemplate,
    logger,
    runId,
    userId,
  } = params

  await previousToolCallFinished

  // The history holds earlier steps only; a repeat within this same response
  // is left to the per-step streak detector in run-agent-step.
  const list = todoListKey(toolCall.input)
  if (
    list !== undefined &&
    agentState &&
    list === latestRecordedTodoListKey(agentState.messageHistory)
  ) {
    const toolNames = agentTemplate?.toolNames ?? []
    logger?.info(
      {
        metric: 'write_todos_unchanged',
        model: agentTemplate?.model,
        agentId: agentTemplate?.id,
        fileEditToolsOffered: hasFileEditTool(toolNames),
        todoCount: toolCall.input.todos.length,
        userId,
        runId,
      },
      'write_todos repeated the recorded list unchanged',
    )
    return {
      output: jsonToolResult({
        message: writeTodosUnchangedMessage(toolNames),
      }),
    }
  }

  return { output: jsonToolResult({ message: 'Todos written' }) }
}) satisfies CodebuffToolHandlerFunction<ToolName>
