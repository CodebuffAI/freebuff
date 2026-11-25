import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  ClientToolCall,
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'

import { jsonToolResult } from '@codebuff/common/util/messages'
import { isPathConfined, isPathConfinedEnabled } from '../../../util/path-confinement'
import { PATH_OUTSIDE_PROJECT_MESSAGE } from '../../../util/path-confinement'

const WINDOWED_GLOB_RESULTS = 100

type ToolName = 'glob'
export const handleGlob = (async (params: {
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
  if (confined) {
    const { pattern, cwd } = toolCall.input
    if (!isPathConfined(pattern) || (cwd !== undefined && !isPathConfined(cwd))) {
      return { output: jsonToolResult({ errorMessage: PATH_OUTSIDE_PROJECT_MESSAGE }) }
    }
  }

  const finalToolCall =
    agentTemplate.windowedFileReads === true &&
    toolCall.input.max_results === undefined
      ? {
          ...toolCall,
          input: { ...toolCall.input, max_results: WINDOWED_GLOB_RESULTS },
        }
      : toolCall
  return { output: await requestClientToolCall(finalToolCall) }
}) satisfies CodebuffToolHandlerFunction<ToolName>
