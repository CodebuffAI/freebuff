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
  let lastCheckAt = 0
  // Bumped whenever the loop pauses (last listener unsubscribes) or stops for good. A
  // scheduled tick or an in-flight check captures the generation active when it started; if
  // the generation has since moved on, that tick/check is stale and must not schedule another
  // one or emit — otherwise it would revive a paused loop with nobody listening. That was the
  // bug: a BYOK session that unsubscribed (its hook takes the early return for
  // `hasSelectedByokConnection`) left this loop polling the Codebuff backend forever, since
  // unsubscribing only removed the listener and never paused the timer.
  let generation = 0
  // The one network probe currently awaiting a response, shared by every check that wants a
  // reading. A loop that resumes while a probe from before its pause is still pending adopts it
  // instead of starting a second request: the generation guard discards stale continuations,
  // but it cannot cancel their requests, so without this a fast pause/resume cycle during a
  // slow health check would stack up concurrent probes.
  let inFlight: Promise<boolean> | null = null

  const probe = (): Promise<boolean> => {
    if (!inFlight) {
      let request: Promise<boolean>
      try {
        request = checkConnection()
      } catch (error) {
        request = Promise.reject(error)
      }
      inFlight = request
      // Registered before any caller awaits `request`, so it runs first and the slot is free
      // by the time a continuation might schedule the next probe. Callers await `request`
      // itself, so sharing adds no extra microtask hops to a check.
      const release = () => {
        if (inFlight === request) inFlight = null
      }
      request.then(release, release)
    }
    return inFlight
  }

  const clearTimer = (): void => {
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
  }

  const scheduleNext = (interval: number, gen: number): void => {
    if (stopped || gen !== generation) return
    clearTimer()
    timeoutId = setTimeout(() => void check(gen), interval)
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

  const scheduleFailed = (
    gen: number,
    message: string,
    error?: unknown,
  ): void => {
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
    scheduleNext(delayMs, gen)
  }

  const check = async (gen: number): Promise<void> => {
    if (stopped || gen !== generation) return
    if (busy) {
      scheduleNext(busyRecheckIntervalMs, gen)
      return
    }
    try {
      const ok = await probe()
      lastCheckAt = Date.now()
      if (stopped) return
      // The generation may have moved on while this awaited — e.g. the last subscriber
      // unsubscribed mid-check. The reading is still real, so keep it as the snapshot the next
      // subscriber starts from (it is what `lastCheckAt` now vouches for), but a stale loop must
      // not emit or reschedule.
      if (gen !== generation) {
        connected = ok
        return
      }
      if (ok) {
        consecutiveFailures = 0
        consecutiveSuccesses++
        emit(true)
        scheduleNext(
          jitterPollIntervalMs({
            intervalMs: getNextInterval(consecutiveSuccesses),
          }),
          gen,
        )
      } else {
        scheduleFailed(gen, 'Health check failed, backing off')
      }
    } catch (error) {
      lastCheckAt = Date.now()
      if (stopped) return
      if (gen !== generation) {
        connected = false
        return
      }
      scheduleFailed(gen, 'Connection check failed; backing off', error)
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
        const gen = generation
        // Resuming shortly after a pause (e.g. a quick unsubscribe/resubscribe cycle) should
        // not immediately refire a probe — wait out whatever's left of the last check's
        // interval instead, so toggling quickly never triggers more than one check per
        // INITIAL_INTERVAL. A probe still pending from before the pause is adopted, not
        // duplicated (see `probe`).
        const elapsedSinceLastCheck = lastCheckAt ? Date.now() - lastCheckAt : Infinity
        if (inFlight) {
          void check(gen)
        } else if (elapsedSinceLastCheck < HEALTH_CHECK_CONFIG.INITIAL_INTERVAL) {
          scheduleNext(
            HEALTH_CHECK_CONFIG.INITIAL_INTERVAL - elapsedSinceLastCheck,
            gen,
          )
        } else {
          void check(gen)
        }
      }
      return () => {
        listeners.delete(listener)
        // Nobody's listening — pause the loop instead of polling into the void. `started`
        // stays false so the next subscribe() restarts it; `stopped` stays false so it can.
        if (listeners.size === 0 && started) {
          started = false
          generation++
          clearTimer()
        }
      }
    },
    getConnected: () => connected,
    setBusy(next: boolean) {
      busy = next
    },
    stop() {
      stopped = true
      generation++
      listeners.clear()
      clearTimer()
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
