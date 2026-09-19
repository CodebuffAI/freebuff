import { FREE_MODE_AGENT_MODELS, isFreebuffRootAgent } from './free-agents'
import { parseAgentId } from '../util/agent-id-parsing'

/**
 * Agent ids only a Freebuff client ever sends.
 *
 * `FREE_MODE_AGENT_MODELS` is keyed by exactly the agents free mode admits —
 * the roots plus their subagents — so membership is the same question as "is
 * this one of ours", and it stays correct as agents are added. The publisher
 * check mirrors the other gates in `free-agents.ts`: a non-codebuff publisher
 * never matches, so `someone/base3-free-deepseek` cannot borrow the id.
 */
export function isFreebuffOnlyAgentId(fullAgentId: string): boolean {
  const { publisherId, agentId } = parseAgentId(fullAgentId)
  if (!agentId) return false
  if (publisherId && publisherId !== 'codebuff') return false
  return agentId in FREE_MODE_AGENT_MODELS || isFreebuffRootAgent(fullAgentId)
}

/**
 * A Freebuff agent id sent with a cost mode other than `free`.
 *
 * ## What this closes
 *
 * `cost_mode` is a client-supplied field in `codebuff_metadata`, and it selects
 * the whole enforcement regime. Roughly twenty gates in the completions route
 * hang off `isFreeModeRequest`: the session/waiting-room gate, the canonical
 * system-prompt gate, the free model allowlist, Freebucks metering, the
 * free-mode rate limits, the run-fanout guard, the ad loop — and the entire
 * third-party-client detector shipped in #3495/#3528. Declaring `normal`
 * instead of `free` turns all of them off in one field, leaving only a
 * `totalRemaining > 0` balance check.
 *
 * That is not theoretical. A subscriber's block grant is sold as a capped,
 * per-model allowance consumed through our clients; spent as plain credits it
 * becomes unrestricted access to every model in the catalog, from any harness,
 * with no ads. Reported by a user in good faith on 2026-09-18 and reproduced
 * from their own traffic.
 *
 * ## This predicate is only half the rule
 *
 * On its own it is NOT abuse, and an earlier version of this change that
 * refused on it alone was wrong. `codebuff/base2-free-luna` with `cost_mode:
 * normal` is the supported "paid Luna" path and has a regression test
 * asserting it stays 200; that test is what caught the blanket rule. Over 7
 * days no real account sent this shape (the only caller was our own
 * `freebuff-web-service`, exempt as an unmetered service request), but "no
 * traffic this week" is not the same as "no supported path", and the test
 * encodes the second.
 *
 * So the call site composes this with the third-party-client verdict: one of
 * OUR agents, on a mode that skips OUR rules, from a client that is not ours.
 * Each condition alone is somebody's ordinary traffic; together they have no
 * legitimate reading.
 */
export function isFreebuffCostModeEscalation(params: {
  agentId: string
  isFreeModeRequest: boolean
}): boolean {
  return !params.isFreeModeRequest && isFreebuffOnlyAgentId(params.agentId)
}

export const FREEBUFF_COST_MODE_ESCALATION_ERROR =
  'free_mode_cost_mode_required'
export const FREEBUFF_COST_MODE_ESCALATION_MESSAGE =
  'Freebuff agents run in free mode. Send codebuff_metadata.cost_mode = "free", or pick a non-Freebuff agent.'

/**
 * Accounts exempted from the PUNISHMENT for using a third-party client, from
 * `FREEBUFF_BAN_EXEMPT_USER_IDS` (comma-separated user ids).
 *
 * A researcher who reports a bypass in good faith must not be permanently
 * flagged or swept into a ban for the traffic that demonstrated it — they did
 * us a favour, and the first one who gets banned for it is the last one who
 * tells us. Support also needs a lever to clear a false positive without a
 * deploy.
 *
 * Scope is narrow and was corrected once: the DOWNGRADE still applies. An
 * earlier version waived it too, which made the exempt account the only place
 * on the platform where the third-party rule did not hold. The reporter,
 * testing from that account, measured the lane as still open and wrote it up
 * as unfixed — their requests were being detected the whole time and served
 * anyway. The downgrade is the rule; the sticky flag and the `ban_event` row
 * are the punishment. Only the punishment is waived, and detection is never
 * suppressed, so an exempt account stays visible in every dashboard.
 */
export function parseExemptUserIds(
  raw: string | undefined,
): ReadonlySet<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  )
}
