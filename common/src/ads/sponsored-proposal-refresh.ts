/**
 * Whether the desktop may refresh a sponsored proposal.
 *
 * A proposal is an offer to the person reading the active thread. Unlike an
 * auction, checking whether one exists does not depend on recent typing: an
 * offer can be created after the thread has become quiet. It must still stop
 * when the desktop window or its thread is no longer in front of that person.
 */
export function sponsoredProposalRefreshMayPoll({
  windowVisible,
  threadIsActive,
}: {
  windowVisible: boolean
  threadIsActive: boolean
}): boolean {
  return windowVisible && threadIsActive
}
