import { endFreebuffSessionBestEffort } from '../hooks/use-freebuff-session'

import { flushAnalytics } from './analytics'
import { stopActiveRun } from './active-run'
import { stopEngagementTracking } from './engagement'
import { TERMINAL_RESET_SEQUENCES } from './terminal-reset-sequences'
import { withTimeout } from './terminal-color-detection'

/** Cap on exit cleanup so a slow network doesn't block process exit. */
const EXIT_CLEANUP_TIMEOUT_MS = 1_000

/**
 * Ensure any buffered terminal output is written to the terminal before the
 * process exits. Without this flush, process.exit() can terminate without
 * sending pending terminal escape sequences, leaving garbled output and
 * potentially causing ASCII/UTF-8 decoding errors in the terminal.
 */
function flushTerminalOutput(): void {
  try {
    if (process.stdout.isTTY) {
      process.stdout.write(TERMINAL_RESET_SEQUENCES)
    }
  } catch {
    // stdout may be closed
  }
}

/**
 * Flush analytics + release the freebuff seat (best-effort), then exit 0.
 * Shared by every freebuff-specific screen's Ctrl+C / X handler so they all
 * run the same cleanup.
 */
export async function exitFreebuffCleanly(): Promise<never> {
  stopActiveRun('process-exit')
  // Stop the heartbeat first so no engaged-minute fires mid-teardown, then
  // flush whatever's already queued.
  stopEngagementTracking()
  await withTimeout(
    Promise.allSettled([flushAnalytics(), endFreebuffSessionBestEffort()]),
    EXIT_CLEANUP_TIMEOUT_MS,
    undefined,
  )
  // Flush terminal output before exiting to prevent garbled terminal state.
  // This writes terminal reset sequences and ensures they reach the terminal
  // before the process terminates.
  flushTerminalOutput()
  process.exit(0)
}
