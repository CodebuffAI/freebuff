import { useCallback, useEffect, useRef } from 'react'

/**
 * Hook to safely manage multiple timeouts with automatic cleanup
 *
 * Provides setTimeout and clearTimeout methods that manage timeouts by key,
 * similar to TanStack Query's key-based API. All timeouts are automatically
 * cleaned up on component unmount.
 *
 * @returns Object with setTimeout and clearTimeout methods
 *
 * @example
 * const { setTimeout, clearTimeout } = useTimeout()
 *
 * // Schedule multiple timeouts with different keys
 * setTimeout('message', () => {
 *   console.log('Message timeout')
 * }, 1000)
 *
 * setTimeout('notification', () => {
 *   console.log('Notification timeout')
 * }, 2000)
 *
 * // Clear a specific timeout by key
 * clearTimeout('message')
 *
 * // Clear all timeouts
 * clearTimeout()
 *
 * // Replace existing timeout with same key
 * setTimeout('message', () => console.log('First'), 1000)
 * setTimeout('message', () => console.log('Second'), 2000) // Cancels first, schedules second
 */
export function useTimeout() {
  const timeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map())

  const setTimeout = useCallback((key: string, callback: () => void, delay: number) => {
    const timeouts = timeoutsRef.current

    // Clear existing timeout for this key if it exists
    const existingTimeout = timeouts.get(key)
    if (existingTimeout) {
      globalThis.clearTimeout(existingTimeout)
    }

    // Set new timeout with automatic cleanup after execution
    const timeoutId = globalThis.setTimeout(() => {
      callback()
      timeouts.delete(key)
    }, delay)
    timeouts.set(key, timeoutId)
  }, [])

  const clearTimeout = useCallback((key?: string) => {
    const timeouts = timeoutsRef.current

    if (key) {
      // Clear specific timeout
      const timeoutId = timeouts.get(key)
      if (timeoutId) {
        globalThis.clearTimeout(timeoutId)
        timeouts.delete(key)
      }
    } else {
      // Clear all timeouts
      timeouts.forEach((timeoutId) => {
        globalThis.clearTimeout(timeoutId)
      })
      timeouts.clear()
    }
  }, [])

  useEffect(() => {
    return () => {
      // Clean up all timeouts on unmount
      const timeouts = timeoutsRef.current
      timeouts.forEach((timeoutId) => {
        globalThis.clearTimeout(timeoutId)
      })
      timeouts.clear()
    }
  }, [])

  // setTimeout/clearTimeout are already stable (useCallback, no deps); keep the container
  // object stable too (via a ref, not useMemo, so this works under the minimal test dispatcher
  // in use-timeout.test.ts) so callers that depend on the whole returned object — e.g. inside
  // another useCallback's deps array — get the same reference every render instead of a new
  // object. An unstable object here previously recreated a downstream callback on every render,
  // which reset an effect keyed on that callback's identity on every render too (see
  // connection-monitor.ts).
  const resultRef = useRef<{
    setTimeout: typeof setTimeout
    clearTimeout: typeof clearTimeout
  } | null>(null)
  if (!resultRef.current) {
    resultRef.current = { setTimeout, clearTimeout }
  }
  return resultRef.current
}
