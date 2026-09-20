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

/**
 * Cut a stored run's history back to the point a user edit rewinds to.
 *
 * ## Why this exists
 *
 * A host that lets someone edit an earlier message has two representations of
 * the same conversation: the transcript it shows, and the `RunState` the model
 * actually resumes from. Deleting from the transcript alone leaves the model
 * remembering turns the user can no longer see. Clearing the state instead —
 * which is what Freebuff Desktop did until 2026-09-19 — leaves the transcript
 * intact and the model with no memory of any of it, so editing the third
 * message of a long thread made the assistant behave as though the
 * conversation had just started. That is the bug this closes; the two
 * representations have to be cut at the same place.
 *
 * ## The boundary
 *
 * `keepUserTurns` is how many user turns survive the rewind — for an edit of
 * the message at 0-based ordinal N, exactly N. History is kept up to, and not
 * including, the (N+1)-th user message, so the assistant and tool messages
 * belonging to the preserved turns come with them and everything the edit
 * removed goes.
 *
 * ## Why it can answer null
 *
 * The mapping between a host's user rows and user messages in `messageHistory`
 * is an assumption, not a guarantee: a host may inject prompts of its own, and
 * an older state may predate whatever it is being matched against. So this
 * counts rather than trusts, and when the history does not contain enough user
 * messages to place the cut it returns null instead of guessing. A caller that
 * gets null should fall back to clearing the state — amnesia is a bad outcome,
 * but a state that silently disagrees with the transcript is a worse one.
 *
 * `keepUserTurns: 0` also answers null: nothing survives, which is the
 * clearing case and not something to express as an empty history.
 */
export function truncateRunStateAtUserTurn(params: {
  runState: RunState
  keepUserTurns: number
}): RunState | null {
  const { runState, keepUserTurns } = params
  if (!Number.isInteger(keepUserTurns) || keepUserTurns <= 0) return null
  const sessionState = runState.sessionState
  const agentState = sessionState?.mainAgentState
  if (!sessionState || !agentState) return null
  const history = agentState.messageHistory
  if (!history?.length) return null

  let seen = 0
  let cutAt = -1
  for (let i = 0; i < history.length; i++) {
    if (history[i]?.role !== 'user') continue
    seen++
    if (seen === keepUserTurns + 1) {
      cutAt = i
      break
    }
  }
  // Fewer user messages than the transcript claims: the two representations
  // are not aligned, so there is no boundary this can honestly place.
  if (cutAt === -1) return null

  const next = cloneSessionState(sessionState)
  next.mainAgentState.messageHistory = history.slice(0, cutAt)
  // The count is advisory and rebuilt on the next turn; leaving a stale, larger
  // number would make the next request think it has less room than it does.
  next.mainAgentState.contextTokenCount = countTokensMessages(
    next.mainAgentState.messageHistory,
  )
  return { ...runState, sessionState: next }
}
