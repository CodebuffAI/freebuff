import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import { jsonToolResult } from '@codebuff/common/util/messages'
import {
  isDestructiveToolBlocked,
  DESTRUCTIVE_TOOLS_DISABLED_MESSAGE,
} from '../../../util/destructive-tool-gate'

type ToolName = 'run_terminal_command'
export const handleRunTerminalCommand = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  agentTemplate: AgentTemplate
  requestClientToolCall: (
    toolCall: ClientToolCall<ToolName>,
  ) => Promise<CodebuffToolOutput<ToolName>>
}): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const { previousToolCallFinished, toolCall, agentTemplate, requestClientToolCall } =
    params

  if (isDestructiveToolBlocked(agentTemplate, 'run_terminal_command')) {
    await previousToolCallFinished
    return {
      output: jsonToolResult({
        command: toolCall.input.command,
        errorMessage: DESTRUCTIVE_TOOLS_DISABLED_MESSAGE,
      }),
    }
  }

  const clientToolCall: ClientToolCall<ToolName> = {
    toolName: 'run_terminal_command',
    toolCallId: toolCall.toolCallId,
    input: {
      command: toolCall.input.command,
      mode: 'assistant',
      process_type: toolCall.input.process_type,
      timeout_seconds: toolCall.input.timeout_seconds,
      cwd: toolCall.input.cwd,
    },
  }
  await previousToolCallFinished
  return { output: await requestClientToolCall(clientToolCall) }
}) satisfies CodebuffToolHandlerFunction<ToolName>
