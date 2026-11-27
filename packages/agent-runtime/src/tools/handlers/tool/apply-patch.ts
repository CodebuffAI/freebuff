import { jsonToolResult } from '@codebuff/common/util/messages'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import { isPathConfined, isPathConfinedEnabled } from '../../../util/path-confinement'
import { PATH_OUTSIDE_PROJECT_MESSAGE } from '../../../util/path-confinement'
import {
  isDestructiveToolBlocked,
  DESTRUCTIVE_TOOLS_DISABLED_MESSAGE,
} from '../../../util/destructive-tool-gate'

export const handleApplyPatch = (async ({
  previousToolCallFinished,
  toolCall,
  agentTemplate,
  requestClientToolCall,
}) => {
  await previousToolCallFinished

  const confined = isPathConfinedEnabled(agentTemplate)
  if (confined) {
    const operation = (toolCall.input as { operation?: { path?: string } }).operation
    const path = operation?.path
    if (typeof path === 'string' && !isPathConfined(path)) {
      return { output: jsonToolResult({ errorMessage: PATH_OUTSIDE_PROJECT_MESSAGE }) }
    }
  }

  if (isDestructiveToolBlocked(agentTemplate, 'apply_patch')) {
    return {
      output: jsonToolResult({ errorMessage: DESTRUCTIVE_TOOLS_DISABLED_MESSAGE }),
    }
  }

  const clientToolCall = {
    toolCallId: toolCall.toolCallId,
    toolName: 'apply_patch' as const,
    input: toolCall.input,
  }
  return {
    output: await requestClientToolCall(clientToolCall),
  }
}) satisfies CodebuffToolHandlerFunction<'apply_patch'>
