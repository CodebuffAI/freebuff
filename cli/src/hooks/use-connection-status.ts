import { useEffect, useRef, useState } from 'react'

import { getCodebuffClient } from '../utils/codebuff-client'
import { logger } from '../utils/logger'
import { useByokSelectionStore } from '../utils/byok'
import {
  failedPollDelayMs,
  jitterPollIntervalMs,
} from '../utils/polling-backoff'

// Adaptive health check interval configuration
// Progressively increases polling interval based on consecutive successful checks
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
} as const

/**
 * Calculates the next health check interval based on consecutive successful checks
 * Exported for testing purposes
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

/**
 * Number of consecutive failed health checks required before the CLI reports
 * itself as disconnected.
 */
export const DISCONNECT_FAILURE_THRESHOLD = 2

/**
 * Tracks consecutive failed health probes across the hook's lifetime.
 *
 * `recordFailure` returns whether the badge may flip to "connecting": a single
 * failed probe is not evidence of a disconnection. Transient blips (a slow
 * proxy, one dropped packet, a momentary 5xx) would otherwise paint a false
 * badge and, because failures back off exponentially, leave that wrong state on
 * screen for minutes.
 *
 * Recovery is deliberately not hysteretic: a success always clears the streak,
 * so coming back feels instant. Slow to alarm, fast to clear.
 *
 * Exported for testing purposes.
 */
export function createProbeFailureTracker({
  threshold = DISCONNECT_FAILURE_THRESHOLD,
}: { threshold?: number } = {}) {
  let consecutiveFailures = 0
  return {
    get consecutiveFailures() {
      return consecutiveFailures
    },
    recordFailure(): boolean {
      consecutiveFailures += 1
      return consecutiveFailures >= threshold
    },
    recordSuccess(): void {
      consecutiveFailures = 0
    },
  }
}

/**
 * Hook to monitor connection status to the Codebuff backend.
 * Jitters the adaptive healthy cadence and exponentially backs off failures so
 * a shared outage cannot synchronize every CLI into a fixed retry wave.
 *
 * When the connection transitions from disconnected to connected, the optional
 * onReconnect callback is invoked with a boolean indicating whether this was
 * the initial connection (true) or a subsequent reconnection (false).
 */
export const useConnectionStatus = (
  onReconnect?: (isInitialConnection: boolean) => void,
) => {
  const hasSelectedByokConnection = useByokSelectionStore(
    (state) => state.selected !== undefined,
  )
  const [isConnected, setIsConnected] = useState(true)
  // null = never connected, false = was disconnected, true = was connected
  const previousConnectedRef = useRef<boolean | null>(null)

  useEffect(() => {
    // A BYOK run talks directly to its selected provider. Do not probe the
    // Codebuff backend just to paint a connection badge.
    if (hasSelectedByokConnection) {
      setIsConnected(true)
      previousConnectedRef.current = true
      return
    }
    let isMounted = true
    let timeoutId: NodeJS.Timeout | null = null
    let consecutiveSuccesses = 0
    const probeFailures = createProbeFailureTracker()

    const scheduleNextCheck = (interval: number) => {
      if (!isMounted) return
      timeoutId = setTimeout(() => checkConnection(), interval)
    }

    const scheduleFailedCheck = (message: string, error?: unknown): void => {
      if (!isMounted) return
      consecutiveSuccesses = 0
      if (probeFailures.recordFailure()) {
        setIsConnected(false)
        previousConnectedRef.current = false
      }
      const delayMs = failedPollDelayMs({
        consecutiveFailures: probeFailures.consecutiveFailures,
      })
      logger.debug(
        {
          ...(error === undefined ? {} : { error }),
          delayMs,
          consecutiveFailures: probeFailures.consecutiveFailures,
        },
        message,
      )
      scheduleNextCheck(delayMs)
    }

    const checkConnection = async () => {
      try {
        const client = await getCodebuffClient()
        if (!client) {
          scheduleFailedCheck('Health check: No client, backing off')
          return
        }

        const connected = await client.checkConnection()
        if (!isMounted) return

        const prevConnected = previousConnectedRef.current

        if (connected) {
          probeFailures.recordSuccess()
          setIsConnected(true)
          previousConnectedRef.current = true
          // Determine if this is the initial connection (null) or a reconnection (false)
          const isInitialConnection = prevConnected === null
          const shouldFireReconnectCallback =
            typeof onReconnect === 'function' && prevConnected !== true

          if (shouldFireReconnectCallback) {
            logger.info(
              { isInitialConnection },
              'Reconnection detected, firing onReconnect callback',
            )
            onReconnect(isInitialConnection)
          }
          consecutiveSuccesses++
          scheduleNextCheck(
            jitterPollIntervalMs({
              intervalMs: getNextInterval(consecutiveSuccesses),
            }),
          )
        } else {
          // The badge is flipped by scheduleFailedCheck alone, so a single
          // failed probe cannot report a disconnection by itself.
          scheduleFailedCheck('Health check failed, backing off')
        }
      } catch (error) {
        scheduleFailedCheck('Connection check failed; backing off', error)
      }
    }

    // Start first check immediately
    checkConnection()

    return () => {
      isMounted = false
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }, [hasSelectedByokConnection, onReconnect])

  return isConnected
}
