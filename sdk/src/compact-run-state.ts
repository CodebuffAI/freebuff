import { compactHistoryNow } from '@codebuff/agent-runtime/compact-history'
import {
  countTokens,
  countTokensJson,
  countTokensMessages,
} from '@codebuff/agent-runtime/util/token-counter'

import { cloneSessionState } from './run'

import type { RunState } from './run-state'
import type { Logger } from '@codebuff/common/types/contracts/logger'

/**
 * A compaction applied to a run's persisted state, not to a live request.
 *
 * `previousTokens`/`nextTokens` are the whole next request as the runtime
 * counts it — history plus the system prompt and tool schemas the root agent
 * checkpointed beside it — so they are on the same basis as the
 * `contextTokenCount` this writes back, and their difference is the honest
 * size of what the pass removed.
 */
export type CompactedRunState = {
  runState: RunState
  previousTokens: number
  nextTokens: number
}

/**
 * Rewrite a stored run's history through the runtime's mechanical compaction,
 * on demand.
 *
 * This is the seam a HOST reaches for. The runtime compacts inside a turn, when
 * its own triggers fire and it already holds the live system prompt and tool
 * schemas; a host holds neither — it holds a `RunState` on disk between turns,
 * which is exactly what a user asking to reclaim context wants shrunk. The root
 * agent checkpoints `systemPrompt` and `toolDefinitions` onto its state, so the
 * fixed half of the count is recoverable here without rebuilding the agent.
 *
 * No model call, no request, no session: the pass is pure and synchronous, and
 * the only thing it spends is the provider's prompt cache, which a compaction
 * breaks whenever it happens.
 *
 * Returns null when there is nothing to do — no session state, no history, or a
 * pass that would not make the history smaller. A caller reports that as a
 * no-op; it is never an error.
 *
 * Throws the runtime's own user-presentable sentence when the live request
 * alone is over budget, which compaction cannot fix.
 */
export function compactRunState(params: {
  runState: RunState
  /** The context budget the next turn will be built against. */
  maxContextLength: number
  logger?: Logger
}): CompactedRunState | null {
  const { runState, maxContextLength, logger } = params
  const sessionState = runState.sessionState
  const agentState = sessionState?.mainAgentState
  if (!sessionState || !agentState) return null
  const previousHistory = agentState.messageHistory
  if (!previousHistory?.length) return null

  // The other half of the count, recovered from what the root agent stored
  // beside its history. An older checkpoint may carry neither, in which case
  // this is 0 and the budget is simply the whole window — the pass still runs,
  // it just has slightly more room than the next turn will.
  const fixedTokenCount =
    countTokens(agentState.systemPrompt ?? '') +
    countTokensJson(agentState.toolDefinitions ?? {})

  const compacted = compactHistoryNow({
    messages: previousHistory,
    maxContextLength,
    fixedTokenCount,
    ...(logger ? { logger } : {}),
    ...(agentState.runId ? { runId: agentState.runId } : {}),
  })
  if (!compacted) return null

  const next = cloneSessionState(sessionState, logger)
  next.mainAgentState.messageHistory = compacted.messages
  next.mainAgentState.contextTokenCount =
    countTokensMessages(compacted.messages) + fixedTokenCount
  return {
    runState: { ...runState, sessionState: next },
    previousTokens: compacted.previousTokens + fixedTokenCount,
    nextTokens: next.mainAgentState.contextTokenCount,
  }
}
