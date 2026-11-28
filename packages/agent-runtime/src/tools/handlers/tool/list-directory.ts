import { jsonToolResult } from '@codebuff/common/util/messages'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import { isPathConfined, isPathConfinedEnabled } from '../../../util/path-confinement'
import { PATH_OUTSIDE_PROJECT_MESSAGE } from '../../../util/path-confinement'

type ToolName = 'list_directory'
export const handleListDirectory = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
  agentTemplate: AgentTemplate
  requestClientToolCall: (
    toolCall: ClientToolCall<ToolName>,
  ) => Promise<CodebuffToolOutput<ToolName>>
}): Promise<{
  output: CodebuffToolOutput<ToolName>
}> => {
  const { previousToolCallFinished, toolCall, agentTemplate, requestClientToolCall } =
    params

  await previousToolCallFinished

  const confined = isPathConfinedEnabled(agentTemplate)
  if (confined && !isPathConfined(toolCall.input.path)) {
    return { output: jsonToolResult({ errorMessage: PATH_OUTSIDE_PROJECT_MESSAGE }) }
  }

  return { output: await requestClientToolCall(toolCall) }
}) satisfies CodebuffToolHandlerFunction<ToolName>
