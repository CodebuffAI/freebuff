import { waitForAsyncSubagentReport } from '../../../async-subagents'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentState } from '@codebuff/common/types/session-state'

/**
 * Blocks until a subagent started with spawn_agent_async has a report
 * waiting, or none is running. The loop delivers the report as the next
 * message once the step ends. A reply with no tool call waits the same way,
 * but a model taught that such a reply ends its turn will not send one, so
 * waiting needs a call of its own.
 */
export const handleWaitForSubagents = (async ({
  previousToolCallFinished,
  agentState,
  signal,
}: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<'wait_for_subagents'>
  agentState: AgentState
  signal: AbortSignal
}): Promise<{ output: CodebuffToolOutput<'wait_for_subagents'> }> => {
  await previousToolCallFinished
  const reported = await waitForAsyncSubagentReport(agentState.runId, signal)
  return {
    output: [
      {
        type: 'json',
        value: {
          message: reported
            ? 'A subagent finished: its report follows.'
            : 'No subagents are running.',
        },
      },
    ],
  }
}) satisfies CodebuffToolHandlerFunction<'wait_for_subagents'>
