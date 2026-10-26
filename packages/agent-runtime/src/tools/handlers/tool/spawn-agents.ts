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
  forwardSubagentChunk,
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

/** What a spawn tool's handler is given: spawn_agents and spawn_agent_async
 *  differ only in their tool call. */
export type SpawnToolParams<T extends 'spawn_agents' | 'spawn_agent_async'> = {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<T>

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
  >

/**
 * Starts one child of a spawn tool call: its live-subagent slot (reserved
 * before the first await, so the children of one batch and of concurrent
 * batches all count against the cap in order), the template and input checks,
 * its state and its run. The slot, and its place in a Projects subagent's
 * scope, are held until the run settles. Throws, holding nothing, when the cap
 * or a check refuses.
 */
export async function startSubagent(
  params: SpawnToolParams<'spawn_agents' | 'spawn_agent_async'>,
  child: {
    agentTypeStr: string
    /** The prompt as the parent wrote it: checked against the input schema
     *  and shown with the child's events. */
    prompt: string | undefined
    spawnParams: Record<string, any> | undefined
    isOnlyChild: boolean
    /** What a parent should do instead when the cap refuses. */
    whenFull: string
    /** What the child's run is given instead of `prompt`. */
    runPrompt?: string
    /** A background child (spawn_agent_async): stopped by its own controller
     *  too, and its usage receipts reach the host directly, since no tool
     *  result carries its cost. */
    background?: Pick<
      Parameters<typeof executeSubagent>[0],
      'onAgentUsageReceived' | 'onAgentUsageIncomplete'
    > & { abort: AbortController }
  },
) {
  const parentAgentState = params.agentState
  const bucket = liveBucket(parentAgentState, child.agentTypeStr)
  if (!reserveLiveSlot(bucket)) {
    throw new Error(
      `at most ${bucket.cap} ${bucket.label} may run at once here and that many are already running. ${child.whenFull}`,
    )
  }
  let childAgentId: string | undefined
  const release = () => {
    if (childAgentId) projectsScopeOf.delete(childAgentId)
    releaseLiveSlot(bucket.key)
  }
  try {
    const { agentTemplate, agentType } = await validateAndGetAgentTemplate({
      ...params,
      agentTypeStr: child.agentTypeStr,
      parentAgentTemplate: params.agentTemplate,
    })
    validateAgentInput(agentTemplate, agentType, child.prompt, child.spawnParams)

    const subAgentState = createAgentState(
      agentType,
      agentTemplate,
      parentAgentState,
      {},
      {
        toolCallId: params.toolCall.toolCallId,
        currentAssistantMessages: params.currentAssistantMessages ?? [],
      },
    )
    if (bucket.projectsScope) {
      childAgentId = subAgentState.agentId
      projectsScopeOf.set(childAgentId, bucket.projectsScope)
    }

    const run = executeSubagent({
      // Extract common context params to avoid bugs from spreading all params
      ...extractSubagentContextParams(params),
      ...(child.background
        ? {
            signal: AbortSignal.any([
              params.signal,
              child.background.abort.signal,
            ]),
            onAgentUsageReceived: child.background.onAgentUsageReceived,
            onAgentUsageIncomplete: child.background.onAgentUsageIncomplete,
          }
        : {}),

      // Spawn-specific params
      ancestorRunIds: parentAgentState.ancestorRunIds,
      userInputId: `${params.userInputId}-${agentType}${subAgentState.agentId}`,
      prompt: child.runPrompt ?? (child.prompt || ''),
      spawnParams: child.spawnParams,
      agentTemplate,
      parentAgentState,
      agentState: subAgentState,
      fingerprintId: params.fingerprintId,
      isOnlyChild: child.isOnlyChild,
      excludeToolFromMessageHistory: false,
      fromHandleSteps: false,
      parentSystemPrompt: params.system,
      parentTools: agentTemplate.inheritParentSystemPrompt
        ? (params.tools ?? {})
        : undefined,
      onResponseChunk: forwardSubagentChunk({
        userInputId: params.userInputId,
        agentType,
        prompt: child.prompt,
        subAgentState,
        parentAgentState,
        sendSubagentChunk: params.sendSubagentChunk,
        writeToClient: params.writeToClient,
      }),
    }).finally(release)
    return { agentType, agentTemplate, subAgentState, run }
  } catch (error) {
    release()
    throw error
  }
}

/** Test seam: how many capped agents are live, and scope entries held. */
export function liveCappedAgentCountForTests(): number {
  let total = projectsScopeOf.size
  for (const n of liveCappedAgents.values()) total += n
  return total
}
export const handleSpawnAgents = (async (
  params: SpawnToolParams<ToolName>,
): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const {
    previousToolCallFinished,
    toolCall,
    agentState: parentAgentState,
    logger,
  } = params
  const { agents } = toolCall.input

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
        const child = await startSubagent(params, {
          agentTypeStr,
          prompt,
          spawnParams,
          isOnlyChild: agents.length === 1,
          whenFull:
            'Do not retry this spawn: do the remaining work yourself, or report what you have.',
        })
        const result = await child.run
        return {
          ...result,
          agentType: child.agentType,
          agentName: child.agentTemplate.displayName,
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
