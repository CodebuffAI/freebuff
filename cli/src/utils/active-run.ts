/** Why the active agent run is being stopped. */
export type ActiveRunStopReason =
  | 'user-interrupt'
  | 'logout'
  | 'new-chat'
  | 'history-resume'
  | 'undo-history'
  | 'redo-history'
  | 'session-transition'
  | 'process-exit'

type ActiveRunQueuePolicy =
  | 'pause-if-pending'
  | 'clear-and-block'
  | 'preserve-and-block'

/**
 * Every reason aborts through the same run owner, which marks the message
 * interrupted and checkpoints it. Process-exit callers additionally flush
 * that checkpoint synchronously. Queue behavior is the only policy that
 * varies here: context changes discard old prompts, a manual interrupt pauses
 * them, and exit preserves them while blocking any new dequeue.
 */
export const ACTIVE_RUN_QUEUE_POLICIES = {
  'user-interrupt': 'pause-if-pending',
  logout: 'clear-and-block',
  'new-chat': 'clear-and-block',
  'history-resume': 'clear-and-block',
  'undo-history': 'clear-and-block',
  'redo-history': 'clear-and-block',
  'session-transition': 'clear-and-block',
  'process-exit': 'preserve-and-block',
} satisfies Record<ActiveRunStopReason, ActiveRunQueuePolicy>

export type ActiveRunQueueControls = {
  pauseQueueIfPending: () => void
  discardQueue: () => void
  setCanProcessQueue: (canProcess: boolean) => void
}

/** Apply the reason matrix to the persistent runtime's latest queue state. */
export function applyActiveRunQueuePolicy(
  reason: ActiveRunStopReason,
  controls: ActiveRunQueueControls,
): void {
  const policy = ACTIVE_RUN_QUEUE_POLICIES[reason]
  if (policy === 'pause-if-pending') {
    controls.pauseQueueIfPending()
    return
  }
  if (policy === 'clear-and-block') {
    controls.discardQueue()
    return
  }
  if (policy === 'preserve-and-block') {
    // Freebuff exit can spend up to a second releasing the session seat. Keep
    // queued prompts in memory, but do not let abort cleanup dequeue a new run
    // during that window.
    controls.setCanProcessQueue(false)
  }
}

type ActiveRun = {
  ownerId: string
  stop: (reason: ActiveRunStopReason) => void
}

let activeRun: ActiveRun | null = null
let runtimeStopHandler: ((reason: ActiveRunStopReason) => void) | null = null

/**
 * Install cleanup owned by the persistent ChatRuntime. It runs even while no
 * SDK run exists, which is important for clearing a paused queue on /logout,
 * /new, or a session reset.
 */
export function registerActiveRunStopHandler(
  handler: (reason: ActiveRunStopReason) => void,
): () => void {
  runtimeStopHandler = handler
  return () => {
    if (runtimeStopHandler === handler) runtimeStopHandler = null
  }
}

/** Register the sole run that may currently mutate the active chat. */
export function registerActiveRun(
  ownerId: string,
  stop: (reason: ActiveRunStopReason) => void,
): void {
  const previousRun = activeRun
  activeRun = { ownerId, stop }
  if (previousRun && previousRun.ownerId !== ownerId) {
    // This should only happen if an unexpected path bypassed the chain lock.
    // Stop the displaced owner after installing the new one so its late
    // owner-guarded cleanup cannot unregister the replacement.
    try {
      previousRun.stop('user-interrupt')
    } catch {
      // The new owner is already installed; never orphan it because cleanup
      // for the displaced run failed.
    }
  }
}

/** Owner-guarded so a stale run settling cannot release a newer run. */
export function clearActiveRun(ownerId: string): void {
  if (activeRun?.ownerId === ownerId) {
    activeRun = null
  }
}

/**
 * Stop the in-flight run, if any. Ownership is released before invoking the
 * callback: repeated entry points are idempotent and the stopped run cannot
 * consume a later reason intended for a newer run.
 */
export function stopActiveRun(reason: ActiveRunStopReason): boolean {
  const run = activeRun
  if (run) activeRun = null

  try {
    run?.stop(reason)
  } catch {
    // Cancellation is a best-effort boundary used during fatal process
    // cleanup too; one broken run callback must not block queue/terminal
    // cleanup.
  }
  try {
    runtimeStopHandler?.(reason)
  } catch {
    // The run is already detached. Keep cancellation idempotent and allow the
    // initiating transition or process cleanup to continue.
  }
  return run !== null
}
