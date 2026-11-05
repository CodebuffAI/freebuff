/** The prompt that compacts a chat (`isCompactCommandPrompt` in agent-runtime). */
export const CLOUD_COMPACT_PROMPT = '/compact'

export const CLOUD_NOTHING_TO_COMPACT = 'Nothing to compact yet.'
export const CLOUD_COMPACTED =
  'Context compacted. Earlier messages stay here; the agent continues from a summary of them.'

export const CLOUD_COMPACT_FAILED =
  'Couldn’t compact this chat. Nothing changed, so you can try again.'

/** A compact never starts a session, so pressing it again would meet the same refusal. */
export const CLOUD_COMPACT_SESSION_ENDED =
  'This chat’s session has ended, so nothing was compacted. Send a message to start a new session, then compact.'

/** What a compact did, from its callbacks: a pass that began and installed nothing failed. */
export function compactOutcome(run: { started: boolean; compacted: boolean }) {
  if (run.compacted) return CLOUD_COMPACTED
  return run.started ? CLOUD_COMPACT_FAILED : CLOUD_NOTHING_TO_COMPACT
}

export function isCloudCompactPrompt(prompt: string): boolean {
  return prompt.trim() === CLOUD_COMPACT_PROMPT
}

/**
 * A compact is maintenance on a chat's saved history, not a turn: nothing runs
 * on the chat's VM or computer, and it is not a message to anything that counts
 * messages. Claude Code and Codex keep the word, since it is their own command,
 * and a mission, an opener or a sponsored procedure is a turn whatever it says.
 */
export function isCloudCompactRequest(request: {
  prompt: string
  agent?: unknown
  localHarness?: unknown
  opener?: unknown
  runtimeContinuation?: unknown
  mission?: unknown
  missionPass?: unknown
  sponsored?: unknown
  agenticAdLabOfferId?: unknown
}): boolean {
  return (
    isCloudCompactPrompt(request.prompt) &&
    !request.agent &&
    !request.localHarness &&
    !request.opener &&
    !request.runtimeContinuation &&
    !request.mission &&
    !request.missionPass &&
    !request.sponsored &&
    !request.agenticAdLabOfferId
  )
}
