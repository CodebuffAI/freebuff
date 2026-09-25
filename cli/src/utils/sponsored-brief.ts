/**
 * The one note owed to the conversation's own agent after a sponsored run.
 *
 * A sponsored turn runs with FRESH memory and writes none back (#3989), so the
 * agent the user is talking to keeps its context through it and has no idea
 * the files moved -- or, after `/ads:undo`, that they moved back. The next
 * ordinary turn carries this note ahead of the user's words, then it is gone.
 *
 * Only the latest note is kept: an undo after a delivery that was never
 * followed by a turn makes the delivery note untrue, and the agent needs to
 * hear the last thing that happened, not both.
 */
let pending: string | null = null

export function setPendingSponsoredBrief(brief: string | null): void {
  pending = brief
}

export function takePendingSponsoredBrief(): string | null {
  const brief = pending
  pending = null
  return brief
}
