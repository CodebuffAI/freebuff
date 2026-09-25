import { create } from 'zustand'

import type { SponsoredRunSnapshot } from '../utils/sponsored-run'

/**
 * The sponsored run's snapshot, readable from React.
 *
 * `SponsoredRun` is a plain object built lazily at the first Accept, so a
 * component cannot subscribe to it before it exists. The process's one run
 * mirrors its snapshot here instead (`sponsoredRunFor`), and the two readers
 * that need it -- the chat runtime, which holds the queue and starts the turn,
 * and the dock, which draws the run's progress -- read it from one place.
 */
export const useSponsoredRunStore = create<{
  snapshot: SponsoredRunSnapshot | null
}>(() => ({ snapshot: null }))

/**
 * Whether the user's queued messages must wait: from the Accept until the
 * sponsored turn has a verdict. `running` is included as well as `queued` on
 * purpose -- between the two there is an await (the `running` report) before
 * the turn takes the chain, and a queue released in that gap would start the
 * user's own turn ahead of the one they just approved.
 */
export function sponsoredTurnHoldsQueue(
  snapshot: SponsoredRunSnapshot | null,
): boolean {
  return snapshot?.phase === 'queued' || snapshot?.phase === 'running'
}
