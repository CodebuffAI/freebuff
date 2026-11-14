import {
  FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS,
  FREEBUFF_PROJECTS_SUBAGENT_ID,
} from '@codebuff/common/constants/free-agents'
import {
  MAX_LIVE_SUBAGENTS_PER_ROOT,
  MAX_SPAWN_AGENTS_PER_CALL,
} from '@codebuff/common/tools/params/tool/spawn-agents'
import {
  normalizeAgentIdForLookup,
  parseAgentId,
} from '@codebuff/common/util/agent-id-parsing'
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

const bareAgentType = (agentType: string): string =>
  parseAgentId(normalizeAgentIdForLookup(agentType)).agentId ?? agentType

/** Live capped agents, keyed by scope and bucket. Every agent of one run tree
 *  spawns in this process, so a process-local count sees them all. */
const liveCappedAgents = new Map<string, number>()

/** Live agents below a Projects subagent, mapped to that subagent's agentId. */
const projectsScopeOf = new Map<string, string>()

type LiveBucket = {
  key: string
  cap: number
  label: string
  /** The Projects subagent whose helpers this spawn counts against, if any. */
  projectsScope?: string
}

/** Projects subagents share one count per root run. Every other agent counts
 *  in its nearest Projects subagent's own MAX_LIVE_SUBAGENTS_PER_ROOT when it
 *  runs below one, and in the root's otherwise, so a Projects subagent's
 *  helpers neither consume nor are starved by the rest of the tree. Helpers
 *  spawn no Projects subagents, so one root run holds at most
 *  MAX_LIVE_SUBAGENTS_PER_ROOT + FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS *
 *  (1 + MAX_LIVE_SUBAGENTS_PER_ROOT) live subagents. */
function liveBucket(parent: AgentState, agentTypeStr: string): LiveBucket {
  const root = parent.ancestorRunIds[0] ?? parent.runId ?? parent.agentId
  if (bareAgentType(agentTypeStr) === FREEBUFF_PROJECTS_SUBAGENT_ID) {
    return {
      key: `${root}\u0000${FREEBUFF_PROJECTS_SUBAGENT_ID}`,
      cap: FREEBUFF_PROJECTS_MAX_LIVE_SUBAGENTS,
      label: FREEBUFF_PROJECTS_SUBAGENT_ID,
    }
  }
  const projectsScope =
    parent.agentType &&
    bareAgentType(parent.agentType) === FREEBUFF_PROJECTS_SUBAGENT_ID
      ? parent.agentId
      : projectsScopeOf.get(parent.agentId)
  return {
    key: `${projectsScope ?? root}\u0000subagents`,
    cap: MAX_LIVE_SUBAGENTS_PER_ROOT,
    label: 'subagents',
    projectsScope,
  }
}

/** Takes a slot; false when the bucket is at its cap. */
function reserveLiveSlot({ key, cap }: LiveBucket): boolean {
  const live = liveCappedAgents.get(key) ?? 0
  if (live >= cap) return false
  liveCappedAgents.set(key, live + 1)
  return true
}

function releaseLiveSlot(key: string): void {
  const live = (liveCappedAgents.get(key) ?? 1) - 1
  if (live <= 0) liveCappedAgents.delete(key)
  else liveCappedAgents.set(key, live)
}

/** Test seam: how many capped agents are live, and scope entries held. */
export function liveCappedAgentCountForTests(): number {
  let total = projectsScopeOf.size
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
        const bucket = liveBucket(parentAgentState, agentTypeStr)
        if (!reserveLiveSlot(bucket)) {
          throw new Error(
            `at most ${bucket.cap} ${bucket.label} may run at once here and that many are already running. Do not retry this spawn: do the remaining work yourself, or report what you have.`,
          )
        }
        let childAgentId: string | undefined
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
          if (bucket.projectsScope) {
            childAgentId = subAgentState.agentId
            projectsScopeOf.set(childAgentId, bucket.projectsScope)
          }

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
            onResponseChunk: async (chunk: string | PrintModeEvent) => {
              if (typeof chunk === 'string') {
                await sendSubagentChunk({
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
                  await writeToClient({
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
                await writeToClient({ ...chunk, parentAgentId })
                return
              }

              const eventWithAgent = {
                ...chunk,
                agentId: subAgentState.agentId,
              }
              await writeToClient(eventWithAgent)
            },
          })
          return { ...result, agentType, agentName: agentTemplate.displayName }
        } finally {
          if (childAgentId) projectsScopeOf.delete(childAgentId)
          releaseLiveSlot(bucket.key)
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
