import {
  FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS,
  FREEBUFF_PROJECTS_SUBAGENT_ID,
} from '@codebuff/common/constants/free-agents'
import { MAX_SPAWN_AGENTS_PER_CALL } from '@codebuff/common/tools/params/tool/spawn-agents'
import { parseAgentId } from '@codebuff/common/util/agent-id-parsing'
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

/** Agent types capped by how many may run at once under one root run, nested
 *  spawns included. */
const MAX_LIVE_PER_ROOT: Readonly<Record<string, number>> = {
  [FREEBUFF_PROJECTS_SUBAGENT_ID]: FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS,
}

/** Live capped agents, keyed by root run and agent type. Every agent of one
 *  run tree spawns in this process, so a process-local count sees them all. */
const liveCappedAgents = new Map<string, number>()

function liveCapKey(parent: AgentState, agentTypeStr: string): string | null {
  const bare = parseAgentId(agentTypeStr).agentId ?? agentTypeStr
  if (MAX_LIVE_PER_ROOT[bare] === undefined) return null
  const root = parent.ancestorRunIds[0] ?? parent.runId ?? parent.agentId
  return `${root}\u0000${bare}`
}

/** Takes a slot for a capped agent type; false when the root is at its cap. */
function reserveLiveSlot(key: string, agentTypeStr: string): boolean {
  const bare = parseAgentId(agentTypeStr).agentId ?? agentTypeStr
  const live = liveCappedAgents.get(key) ?? 0
  if (live >= MAX_LIVE_PER_ROOT[bare]!) return false
  liveCappedAgents.set(key, live + 1)
  return true
}

function releaseLiveSlot(key: string): void {
  const live = (liveCappedAgents.get(key) ?? 1) - 1
  if (live <= 0) liveCappedAgents.delete(key)
  else liveCappedAgents.set(key, live)
}

/** Test seam: how many capped agents are live under a root. */
export function liveCappedAgentCountForTests(): number {
  let total = 0
  for (const n of liveCappedAgents.values()) total += n
  return total
}
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

  // Enforce the schema's MAX_SPAWN_AGENTS_PER_CALL even when validation was
  // bypassed (custom tool-call parsing, a cached schema from an older client).
  // The batch answers in place: no subagent starts and no token is spent.
  if (agents.length > MAX_SPAWN_AGENTS_PER_CALL) {
    return {
      output: jsonToolResult([
        {
          agentType: agents[0]?.agent_type ?? 'unknown',
          errorMessage: `Refusing to spawn ${agents.length} agents at once: at most ${MAX_SPAWN_AGENTS_PER_CALL} per spawn_agents call. Split the fan-out into smaller batches.`,
        },
      ]),
    }
  }

  await previousToolCallFinished

  const results = await Promise.allSettled(
    agents.map(
      async ({ agent_type: agentTypeStr, prompt, params: spawnParams }) => {
        // Reserved before the first await, so the agents of one batch and of
        // concurrent batches all count against the cap in order.
        const capKey = liveCapKey(parentAgentState, agentTypeStr)
        if (capKey && !reserveLiveSlot(capKey, agentTypeStr)) {
          const bare = parseAgentId(agentTypeStr).agentId ?? agentTypeStr
          throw new Error(
            `at most ${MAX_LIVE_PER_ROOT[bare]} ${bare} may run at once in this session. Wait for running ones to report, then spawn again.`,
          )
        }
        try {
          const { agentTemplate, agentType } =
            await validateAndGetAgentTemplate({
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
                if (
                  chunk.type === 'tool_call' ||
                  chunk.type === 'tool_result'
                ) {
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
        } finally {
          if (capKey) releaseLiveSlot(capKey)
        }
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
