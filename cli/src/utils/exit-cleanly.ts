import { flushAnalytics } from './analytics'
import { IS_FREEBUFF } from './constants'
import { stopEngagementTracking } from './engagement'
import { useFreebuffSessionStore } from '../state/freebuff-session-store'
import { drainClientLogs } from './log-shipper'
import { settleInterruptedSponsoredRun } from './sponsored-run-exit'
import { withTimeout } from './terminal-color-detection'

const EXIT_CLEANUP_TIMEOUT_MS = 1_000

type ExitCliDependencies = {
  isFreebuff: boolean
  cleanupLocal: () => void
  stopEngagementTracking: () => void
  flushAnalytics: () => Promise<void>
  drainClientLogs: () => Promise<void>
  endFreebuffSession: () => Promise<void>
  /**
   * Bring a sponsored run to a TERMINAL state, and say what it left behind.
   *
   * COD-339 acceptance 6, and the one interrupt question with no web
   * equivalent: on Cloud the run is remote and closing the tab leaves it to
   * finish, while here it is a process on the user's own machine that is about
   * to stop existing. Two things must not survive it -- a row stuck on
   * `running` forever, and a directory the user cannot account for.
   *
   * Resolves to the notice, or null when there was no run.
   */
  settleSponsoredRun: () => Promise<string | null>
  /** Where that notice goes once the alternate screen has been restored. */
  writeNotice: (text: string) => void
  waitForRemoteCleanup: (tasks: Promise<void>[]) => Promise<void>
  exit: (code: number) => void
}

let localExitCleanup: (() => void) | undefined

/** Register the synchronous renderer/terminal finalizer once it is available. */
export function registerExitCleanup(cleanup: () => void): void {
  localExitCleanup = cleanup
}

/**
 * Build an idempotent exit request. Exported for dependency-injected tests;
 * production uses the singleton below so competing exit triggers converge.
 */
export function createExitCliCleanly(deps: ExitCliDependencies) {
  let exitPromise: Promise<void> | undefined

  return (exitCode = 0): Promise<void> => {
    if (exitPromise) return exitPromise

    // Start on the next microtask so exitPromise is assigned before any cleanup
    // callback can re-enter this function.
    exitPromise = Promise.resolve().then(async () => {
      // STARTED BEFORE THE SCREEN IS TORN DOWN, awaited after. The abort and
      // the state report are the parts that must begin immediately; the notice
      // is printed once the terminal is back on its main screen, where the user
      // will still be able to read it after we exit.
      const sponsored = Promise.resolve()
        .then(deps.settleSponsoredRun)
        .catch(() => null)
      try {
        deps.cleanupLocal()
      } catch {
        // Cleanup is best-effort; never strand the process in a half-exited UI.
      }
      if (deps.isFreebuff) {
        try {
          deps.stopEngagementTracking()
        } catch {}
      }

      const remoteTasks = [
        Promise.resolve().then(deps.flushAnalytics),
        Promise.resolve().then(deps.drainClientLogs),
        sponsored.then((notice) => {
          if (notice) deps.writeNotice(notice)
        }),
      ]
      if (deps.isFreebuff) {
        remoteTasks.push(Promise.resolve().then(deps.endFreebuffSession))
      }

      try {
        await deps.waitForRemoteCleanup(remoteTasks)
      } finally {
        deps.exit(exitCode)
      }
    })

    return exitPromise
  }
}

export const exitCliCleanly = createExitCliCleanly({
  isFreebuff: IS_FREEBUFF,
  cleanupLocal: () => localExitCleanup?.(),
  stopEngagementTracking,
  flushAnalytics,
  drainClientLogs,
  endFreebuffSession: () => useFreebuffSessionStore.getState().releaseSlot(),
  settleSponsoredRun: settleInterruptedSponsoredRun,
  // `process.stdout.write`, not the logger and not the renderer: the renderer is
  // gone by now, and a line about a directory that exists on the user's disk is
  // the one thing on the way out that they actually have to act on.
  writeNotice: (text) => {
    try {
      process.stdout.write(`\n${text}\n`)
    } catch {
      // A closed stdout is not a reason to fail an exit.
    }
  },
  waitForRemoteCleanup: async (tasks) => {
    await withTimeout(
      Promise.allSettled(tasks),
      EXIT_CLEANUP_TIMEOUT_MS,
      undefined,
    )
  },
  exit: (code) => process.exit(code),
})
