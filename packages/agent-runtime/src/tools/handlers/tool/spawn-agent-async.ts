import { getErrorObject } from '@codebuff/common/util/error'

import {
  asyncSubagentTaskPrompt,
  asyncSubagentTranscript,
  nextAsyncSpawnId,
  renderAsyncSubagentTranscript,
  trackAsyncSubagent,
} from '../../../async-subagents'
import { startSubagent } from './spawn-agents'

import type { AsyncSubagentReport } from '../../../async-subagents'
import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type { SpawnToolParams } from './spawn-agents'
import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { AgentUsageData } from '@codebuff/common/types/contracts/llm'

type ToolName = 'spawn_agent_async'

/**
 * Starts one subagent in the background and answers at once with its spawn
 * id. The subagent starts exactly as a spawn_agents child does
 * (`startSubagent`); what differs is delivery: its report is queued in
 * async-subagents.ts and the parent's loop adds it to the parent's history
 * between two steps.
 */
export const handleSpawnAgentAsync = (async (
  params: SpawnToolParams<ToolName> & {
    /** Usage receipts for the subagent's own requests (`isRoot: false`). A
     *  synchronous child's cost reaches the host through its parent's tool
     *  result; a background child's would otherwise reach it nowhere. */
    onAgentUsageReceived?: (usage: AgentUsageData) => void
    onAgentUsageIncomplete?: () => void
  },
): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const { toolCall, agentState: parentAgentState, logger, writeToClient } =
    params
  const {
    agent_type: agentTypeStr,
    prompt: task,
    params: spawnParams,
  } = toolCall.input

  await params.previousToolCallFinished

  // A refusal is also reported as a tool error: a reply of only async spawns
  // does not force another step, and the parent must see why one failed.
  const refuse = (errorMessage: string) => {
    writeToClient({
      type: 'error',
      message: `spawn_agent_async (${agentTypeStr}): ${errorMessage}`,
    })
    return {
      output: [
        {
          type: 'json' as const,
          value: { agentType: agentTypeStr, status: 'error', errorMessage },
        },
      ] satisfies CodebuffToolOutput<ToolName>,
    }
  }

  const spawnId = nextAsyncSpawnId(parentAgentState)
  if (!spawnId) {
    return refuse('the agent has no running turn to deliver a report to.')
  }
  // Its own controller, so a parent that exits early (an error, a cancelled
  // turn) stops it rather than leaving it editing files.
  const abort = new AbortController()
  const startedAt = Date.now()
  let child: Awaited<ReturnType<typeof startSubagent>>
  try {
    child = await startSubagent(params, {
      agentTypeStr,
      prompt: task,
      runPrompt: asyncSubagentTaskPrompt(spawnId, task),
      spawnParams,
      isOnlyChild: false,
      whenFull: 'Wait for a report before starting another.',
      background: {
        abort,
        onAgentUsageReceived: params.onAgentUsageReceived,
        onAgentUsageIncomplete: params.onAgentUsageIncomplete,
      },
    })
  } catch (error) {
    return refuse(`Error spawning agent: ${getErrorObject(error).message}`)
  }
  const { agentType, subAgentState, run } = child

  // loopAgentSteps keeps `subAgentState` current as it works, so the
  // transcript survives a run that throws.
  const report = (
    fields: Pick<AsyncSubagentReport, 'status' | 'errorMessage'>,
  ): AsyncSubagentReport => ({
    spawnId,
    agentType,
    task,
    creditsUsed: subAgentState.creditsUsed,
    durationMs: Date.now() - startedAt,
    transcript: renderAsyncSubagentTranscript(
      asyncSubagentTranscript(subAgentState.messageHistory, spawnId),
    ),
    ...fields,
  })

  trackAsyncSubagent(
    parentAgentState.runId,
    spawnId,
    abort,
    run
      .then(({ output }) =>
        output.type === 'error'
          ? report({ status: 'failed', errorMessage: output.message })
          : report({ status: 'completed' }),
      )
      .catch((error) => {
        logger.warn(
          { error: getErrorObject(error), agentType, spawnId },
          'Async subagent failed',
        )
        return report({
          status: 'failed',
          errorMessage: getErrorObject(error).message,
        })
      }),
  )

  return {
    output: [
      {
        type: 'json',
        value: { agentType, spawnId, status: 'running' },
      },
    ],
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
