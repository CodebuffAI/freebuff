/**
 * Where each turn of a local Claude Code chat ended in the CLI's own transcript, so Roll back can
 * cut the model's memory at a message (web history-store.ts `rollbackChat`, claude-rollback.ts).
 *
 * Desktop's Claude harness (claude-code.ts) appends one mark to the chat's saved state at the end
 * of every turn that produced a reply. A rollback keeps the marks of the runs it keeps and resumes
 * the last one's session AT its last entry, branched into a new session (`resumeSessionAt` with
 * `forkSession`), which is how Claude Code's own rewind drops the turns after a message. A mark
 * names its own session: a fork or rollback moves the chat to a new session id, and the kept turns
 * still live in the transcript of the session they ran in, which stays on this computer.
 */
export type ClaudeTurnMark = {
  /** The Freebuff run (`freebuff_cloud_run.id`) this turn answered. */
  run: string
  /** The CLI session the turn ran in. */
  session: string
  /** The uuid of the turn's last top-level transcript entry: its final assistant message. */
  end: string
}

/** Only the most recent turns can be rolled back to; older marks are dropped. */
export const CLAUDE_TURN_MARKS_KEPT = 200

/** CLI session ids and transcript entry uuids; anything else is refused before it reaches a CLI. */
export const CLAUDE_TRANSCRIPT_ID = /^[a-zA-Z0-9_-]{1,128}$/

export function isClaudeTurnMark(value: unknown): value is ClaudeTurnMark {
  if (!value || typeof value !== 'object') return false
  const { run, session, end } = value as Record<string, unknown>
  return (
    typeof run === 'string' &&
    run.length > 0 &&
    typeof session === 'string' &&
    CLAUDE_TRANSCRIPT_ID.test(session) &&
    typeof end === 'string' &&
    CLAUDE_TRANSCRIPT_ID.test(end)
  )
}

/** The well-formed marks a saved state carries, oldest first. */
export function claudeTurnMarks(state: unknown): ClaudeTurnMark[] {
  if (!state || typeof state !== 'object') return []
  const turns = (state as { turns?: unknown }).turns
  return Array.isArray(turns) ? turns.filter(isClaudeTurnMark) : []
}
