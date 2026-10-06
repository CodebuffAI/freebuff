import { getCodebuffClient } from './codebuff-client'
import { logger } from './logger'
import { failedPollDelayMs, jitterPollIntervalMs } from './polling-backoff'

// Adaptive health check interval configuration.
// Progressively increases polling interval based on consecutive successful checks.
const HEALTH_CHECK_CONFIG = {
  // Healthy startup cadence (ms).
  INITIAL_INTERVAL: 10_000, // 10 seconds
  // Interval thresholds based on consecutive successful checks
  INTERVALS: [
    { successCount: 3, interval: 30_000 }, // 30 seconds after 3 successes
    { successCount: 6, interval: 60_000 }, // 1 minute after 6 successes
    { successCount: 10, interval: 120_000 }, // 2 minutes after 10 successes
    { successCount: 15, interval: 300_000 }, // 5 minutes after 15 successes
    { successCount: 20, interval: 600_000 }, // 10 minutes after 20 successes
  ],
  // While a real request is in flight, its own success already proves the backend is up.
  // Recheck on this short cadence (without hitting the network) rather than probing
  // concurrently with the turn, and resume the normal schedule the moment it ends.
  BUSY_RECHECK_INTERVAL: 5_000,
} as const

/**
 * Calculates the next health check interval based on consecutive successful checks.
 * Exported for testing purposes.
 */
export function getNextInterval(consecutiveSuccesses: number): number {
  // Find the highest threshold that we've passed
  for (let i = HEALTH_CHECK_CONFIG.INTERVALS.length - 1; i >= 0; i--) {
    const { successCount, interval } = HEALTH_CHECK_CONFIG.INTERVALS[i]
    if (consecutiveSuccesses >= successCount) {
      return interval
    }
  }
  return HEALTH_CHECK_CONFIG.INITIAL_INTERVAL
}

export type ConnectionListener = (connected: boolean) => void

export interface ConnectionMonitor {
  /** Returns the current snapshot immediately, then notifies on every subsequent check. */
  subscribe(listener: ConnectionListener): () => void
  getConnected(): boolean
  /** A real request is in flight (or just finished). Its own success is stronger evidence of
   *  connectivity than a dedicated probe, so pause probing while busy and resume right after. */
  setBusy(busy: boolean): void
  /** Stops the pending timer for good. Production code never calls this; tests do. */
  stop(): void
}

export interface ConnectionMonitorOptions {
  /** swapped in tests; the default asks the Codebuff backend through the SDK client */
  checkConnection?: () => Promise<boolean>
  busyRecheckIntervalMs?: number
}

const defaultCheckConnection = async (): Promise<boolean> => {
  const client = await getCodebuffClient()
  if (!client) return false
  return client.checkConnection()
}

/**
 * Creates one health-check loop. Dependency-injected (mirrors
 * `freebuff-desktop/src/server/services/reachability.ts`'s `createReachability`) so tests can
 * swap `checkConnection` instead of mocking the `codebuff-client` module.
 *
 * Production code does not call this directly — see the singleton helpers below. The loop here
 * owns its own timer and backoff state, independent of any caller's lifecycle: subscribing adds
 * a listener only, and never resets the timer or the backoff counters. That matters because this
 * used to live inside `useConnectionStatus`'s `useEffect`, keyed on an `onReconnect` callback
 * identity. A render during active streaming recreated that closure and tore down/restarted the
 * effect — resetting the adaptive backoff to its 10s floor and firing an immediate probe on every
 * render. During active token streaming that is many renders a second, which is what flooded
 * `/api/healthz` (1.17B GETs/week, ~74% of all requests to the `web` Render service).
 */
export function createConnectionMonitor(
  options: ConnectionMonitorOptions = {},
): ConnectionMonitor {
  const checkConnection = options.checkConnection ?? defaultCheckConnection
  const busyRecheckIntervalMs =
    options.busyRecheckIntervalMs ?? HEALTH_CHECK_CONFIG.BUSY_RECHECK_INTERVAL

  const listeners = new Set<ConnectionListener>()
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let consecutiveSuccesses = 0
  let consecutiveFailures = 0
  let connected = true
  let started = false
  let busy = false
  let stopped = false

  const scheduleNext = (interval: number): void => {
    if (stopped) return
    if (timeoutId) clearTimeout(timeoutId)
    timeoutId = setTimeout(() => void check(), interval)
    timeoutId.unref?.()
  }

  const emit = (next: boolean): void => {
    connected = next
    for (const listener of [...listeners]) {
      try {
        listener(next)
      } catch (error) {
        logger.debug({ error }, 'Connection monitor listener threw')
      }
    }
  }

  const scheduleFailed = (message: string, error?: unknown): void => {
    consecutiveSuccesses = 0
    consecutiveFailures++
    const delayMs = failedPollDelayMs({ consecutiveFailures })
    logger.debug(
      {
        ...(error === undefined ? {} : { error }),
        delayMs,
        consecutiveFailures,
      },
      message,
    )
    emit(false)
    scheduleNext(delayMs)
  }

  const check = async (): Promise<void> => {
    if (stopped) return
    if (busy) {
      scheduleNext(busyRecheckIntervalMs)
      return
    }
    try {
      const ok = await checkConnection()
      if (stopped) return
      if (ok) {
        consecutiveFailures = 0
        consecutiveSuccesses++
        emit(true)
        scheduleNext(
          jitterPollIntervalMs({
            intervalMs: getNextInterval(consecutiveSuccesses),
          }),
        )
      } else {
        scheduleFailed('Health check failed, backing off')
      }
    } catch (error) {
      scheduleFailed('Connection check failed; backing off', error)
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      // Give the new subscriber the current snapshot right away so its UI doesn't flash
      // "disconnected" waiting for the next tick.
      listener(connected)
      if (!started) {
        started = true
        void check()
      }
      return () => {
        listeners.delete(listener)
      }
    },
    getConnected: () => connected,
    setBusy(next: boolean) {
      busy = next
    },
    stop() {
      stopped = true
      listeners.clear()
      if (timeoutId) clearTimeout(timeoutId)
    },
  }
}

// One process-wide instance. Lazily created on first use so importing this module never starts
// network traffic by itself (tests, non-CLI consumers of the package, etc.).
let singleton: ConnectionMonitor | null = null

function getSingleton(): ConnectionMonitor {
  if (!singleton) {
    singleton = createConnectionMonitor()
  }
  return singleton
}

/** Subscribe to connection state. Returns an unsubscribe function. */
export function subscribeToConnectionStatus(
  listener: ConnectionListener,
): () => void {
  return getSingleton().subscribe(listener)
}

export function getConnectionStatusSnapshot(): boolean {
  return getSingleton().getConnected()
}

/** Call with `true` while a real request/turn is in flight, `false` once it settles. */
export function setConnectionMonitorBusy(busy: boolean): void {
  getSingleton().setBusy(busy)
}

/** Test-only: drop the singleton so each test file gets an isolated monitor and timer. */
export function resetConnectionMonitorForTests(): void {
  if (singleton) singleton.stop()
  singleton = null
}
