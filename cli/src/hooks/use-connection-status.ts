import { useEffect, useRef, useState } from 'react'

import { useByokSelectionStore } from '../utils/byok'
import {
  getConnectionStatusSnapshot,
  subscribeToConnectionStatus,
} from '../utils/connection-monitor'

export { getNextInterval } from '../utils/connection-monitor'

/**
 * Hook to monitor connection status to the Codebuff backend.
 *
 * The health-check loop itself lives in `connection-monitor.ts` as a single process-wide
 * singleton: it starts on the first subscriber and owns its own adaptive-backoff timer,
 * independent of any component's render or mount lifecycle. This hook only subscribes to
 * that shared state — subscribing/unsubscribing (which can happen on every render, e.g.
 * because `onReconnect` is a fresh closure each time) is cheap and never resets the backoff
 * or fires a probe.
 *
 * It used to be the other way around: the polling loop lived inside this hook's own
 * `useEffect`, keyed on `onReconnect`'s identity. A render during active streaming
 * recreated that closure and tore down/restarted the effect — resetting the adaptive
 * backoff to its 10s floor and firing an immediate request every time. That is what
 * flooded `/api/healthz`.
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
  // Read via a ref so an unstable callback identity never resubscribes (let alone resets
  // the shared monitor's backoff) — only the latest callback is invoked, from the effect below.
  const onReconnectRef = useRef(onReconnect)
  onReconnectRef.current = onReconnect

  useEffect(() => {
    // A BYOK run talks directly to its selected provider. Do not probe the
    // Codebuff backend just to paint a connection badge.
    if (hasSelectedByokConnection) {
      setIsConnected(true)
      previousConnectedRef.current = true
      return
    }

    setIsConnected(getConnectionStatusSnapshot())

    const unsubscribe = subscribeToConnectionStatus((connected) => {
      const prevConnected = previousConnectedRef.current
      setIsConnected(connected)
      previousConnectedRef.current = connected

      if (connected) {
        const isInitialConnection = prevConnected === null
        const shouldFireReconnectCallback =
          typeof onReconnectRef.current === 'function' &&
          prevConnected !== true

        if (shouldFireReconnectCallback) {
          onReconnectRef.current?.(isInitialConnection)
        }
      }
    })

    return unsubscribe
  }, [hasSelectedByokConnection])

  return isConnected
}
