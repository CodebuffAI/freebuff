import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

import { isUserActive, subscribeToActivity } from '../utils/activity-tracker'

// Global query cache
type CacheEntry<T> = {
  // allow error-only entries (first fetch failure) without pretending data exists
  data?: T
  dataUpdatedAt: number // 0 means "no successful data yet" (also stale)
  error: Error | null
  errorUpdatedAt: number | null
}

type KeySnapshot<T> = {
  entry: CacheEntry<T> | undefined
  isFetching: boolean
}

type CacheState = {
  entries: Map<string, CacheEntry<unknown>>
  // Per-key listeners
  keyListeners: Map<string, Set<() => void>>
  // Reference counts
  refCounts: Map<string, number>
  // Global fetch status per key
  fetchingKeys: Set<string>
}

const cache: CacheState = {
  entries: new Map(),
  keyListeners: new Map(),
  refCounts: new Map(),
  fetchingKeys: new Set(),
}

// In-flight promises for request deduplication
const inFlight = new Map<string, Promise<unknown>>()

// Per-key snapshot memoization so fetching-status changes trigger rerenders
// even if the cache entry object didn’t change.
const snapshotMemo = new Map<
  string,
  {
    entryRef: CacheEntry<unknown> | undefined
    fetching: boolean
    snap: KeySnapshot<unknown>
  }
>()

/**
 * Notify listeners for a specific cache key.
 */
function notifyKeyListeners(key: string) {
  const listeners = cache.keyListeners.get(key)
  if (!listeners) return
  for (const listener of listeners) listener()
}

/**
 * Subscribe to cache changes for a specific key. Used by useSyncExternalStore.
 */
function subscribeToKey(key: string, callback: () => void): () => void {
  let listeners = cache.keyListeners.get(key)
  if (!listeners) {
    listeners = new Set()
    cache.keyListeners.set(key, listeners)
  }
  listeners.add(callback)
  return () => {
    listeners!.delete(callback)
    if (listeners!.size === 0) {
      cache.keyListeners.delete(key)
    }
  }
}

/**
 * Snapshot includes BOTH entry + isFetching, and is memoized so Object.is only changes
 * when either changes. This fixes "notify but no rerender" when only fetch-status changes.
 */
function getKeySnapshot<T>(key: string): KeySnapshot<T> {
  const entry = cache.entries.get(key) as CacheEntry<T> | undefined
  const fetching = cache.fetchingKeys.has(key)

  const memo = snapshotMemo.get(key)
  if (memo && memo.entryRef === (entry as any) && memo.fetching === fetching) {
    return memo.snap as KeySnapshot<T>
  }

  const snap: KeySnapshot<T> = { entry, isFetching: fetching }
  snapshotMemo.set(key, {
    entryRef: entry as any,
    fetching,
    snap: snap as any,
  })
  return snap
}

function setCacheEntry<T>(key: string, entry: CacheEntry<T>): void {
  cache.entries.set(key, entry as CacheEntry<unknown>)
  // bust memo for this key
  snapshotMemo.delete(key)
  notifyKeyListeners(key)
}

function getCacheEntry<T>(key: string): CacheEntry<T> | undefined {
  return cache.entries.get(key) as CacheEntry<T> | undefined
}

/**
 * Check if a cache entry is stale based on staleTime.
 * Exported for testing purposes.
 */
export function isEntryStale(key: string, staleTime: number): boolean {
  const entry = getCacheEntry(key)
  if (!entry) return true
  
  // If we have successful data, use its timestamp for staleness
  if (entry.dataUpdatedAt !== 0) {
    return staleTime === 0 || Date.now() - entry.dataUpdatedAt > staleTime
  }
  
  // No successful data - check if we have a recent error
  // Use errorUpdatedAt to prevent rapid retries on persistent errors
  if (entry.errorUpdatedAt !== null) {
    return staleTime === 0 || Date.now() - entry.errorUpdatedAt > staleTime
  }
  
  // No data and no error timestamp - entry is stale
  return true
}

function setQueryFetching(key: string, fetching: boolean): void {
  const wasFetching = cache.fetchingKeys.has(key)
  if (fetching) cache.fetchingKeys.add(key)
  else cache.fetchingKeys.delete(key)

  if (wasFetching !== fetching) {
    // bust memo so snapshot changes even if entry didn’t
    snapshotMemo.delete(key)
    notifyKeyListeners(key)
  }
}

function incrementRefCount(key: string): void {
  const current = cache.refCounts.get(key) ?? 0
  cache.refCounts.set(key, current + 1)
}

function decrementRefCount(key: string): number {
  const current = cache.refCounts.get(key) ?? 0
  const next = Math.max(0, current - 1)
  if (next === 0) cache.refCounts.delete(key)
  else cache.refCounts.set(key, next)
  return next
}

function getRefCount(key: string): number {
  return cache.refCounts.get(key) ?? 0
}

/**
 * Serialize a query key to a string for cache lookup.
 */
function serializeQueryKey(queryKey: readonly unknown[]): string {
  return JSON.stringify(queryKey)
}

// Module-level map to track GC timeouts (survives component unmount)
const gcTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

// Per-key retry state (so unmounting one observer doesn’t cancel retries for others)
const retryCounts = new Map<string, number>()
const retryTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

// Per-key generation to prevent "resurrecting" deleted entries from late in-flight responses
const generations = new Map<string, number>()
function bumpGeneration(key: string) {
  generations.set(key, (generations.get(key) ?? 0) + 1)
}
function getGeneration(key: string) {
  return generations.get(key) ?? 0
}

function clearRetryTimeout(key: string) {
  const t = retryTimeouts.get(key)
  if (t) clearTimeout(t)
  retryTimeouts.delete(key)
}

function clearRetryState(key: string) {
  clearRetryTimeout(key)
  retryCounts.delete(key)
}

function deleteCacheEntry(key: string): void {
  bumpGeneration(key)
  clearRetryState(key)
  inFlight.delete(key)
  cache.fetchingKeys.delete(key)
  cache.entries.delete(key)
  cache.refCounts.delete(key)
  snapshotMemo.delete(key)
  notifyKeyListeners(key)
}
export type UseActivityQueryOptions<T> = {
  /** Unique key for caching the query */
  queryKey: readonly unknown[]
  /** Function that fetches the data */
  queryFn: () => Promise<T>
  /** Whether the query is enabled (default: true) */
  enabled?: boolean
  /** Time in ms before data is considered stale (default: 0) */
  staleTime?: number
  /** Time in ms to keep unused cache entries (default: 5 minutes) */
  gcTime?: number
  /** Number of retry attempts on failure (default: 0) */
  retry?: number | false
  /** Interval in ms to refetch data (default: false/disabled) */
  refetchInterval?: number | false

  /** Refetch when component mounts (default: false) */
  refetchOnMount?: boolean | 'always'
  /** Refetch stale data when user becomes active after being idle (default: false) */
  refetchOnActivity?: boolean
  /** Pause polling when user is idle (default: false) */
  pauseWhenIdle?: boolean
  /** Time in ms to consider user idle (default: 30 seconds) */
  idleThreshold?: number
}

export type UseActivityQueryResult<T> = {
  /** The query data, undefined if not yet fetched */
  data: T | undefined
  /** Whether the initial fetch is in progress */
  isLoading: boolean
  /** Whether any fetch (initial or refetch) is in progress */
  isFetching: boolean
  /** Whether the query has successfully fetched data */
  isSuccess: boolean
  /** Error from the last fetch attempt */
  error: Error | null
  /** Manually trigger a refetch */
  refetch: () => Promise<void>
}

/**
 * Activity-aware query hook that provides caching and refetching based on user activity.
 * 
 * This hook replaces TanStack Query with terminal-specific activity awareness:
 * - Detects when user is active (typing, mouse movement, keyboard shortcuts)
 * - Can pause polling when user is idle to save resources
 * - Can refetch stale data when user becomes active again
 */
export function useActivityQuery<T>(
  options: UseActivityQueryOptions<T>,
): UseActivityQueryResult<T> {
  const {
    queryKey,
    queryFn,
    enabled = true,
    staleTime = 0,
    gcTime = 5 * 60 * 1000,
    retry = 0,
    refetchInterval = false,
    refetchOnMount = false,
    refetchOnActivity = false,
    pauseWhenIdle = false,
    idleThreshold = 30_000,
  } = options

  const serializedKey = serializeQueryKey(queryKey)
  const mountedRef = useRef(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const wasIdleRef = useRef(false)
  
  // Store queryFn in a ref to avoid recreating doFetch when queryFn changes.
  // This is critical because inline arrow functions create new references on every render,
  // which would cause the polling interval to reset constantly.
  const queryFnRef = useRef(queryFn)
  queryFnRef.current = queryFn

  // Snapshot includes entry + isFetching (so fetch-status updates rerender correctly)
  const snap = useSyncExternalStore(
    (cb) => subscribeToKey(serializedKey, cb),
    () => getKeySnapshot<T>(serializedKey),
    () => getKeySnapshot<T>(serializedKey),
  )

  const cachedEntry = snap.entry
  const isFetching = snap.isFetching

  const data = cachedEntry?.data
  const error = cachedEntry?.error ?? null
  const dataUpdatedAt = cachedEntry?.dataUpdatedAt ?? 0

  // Initial load = fetching with no successful data yet
  const isLoading = isFetching && (cachedEntry == null || dataUpdatedAt === 0)

  const doFetch = useCallback(async (): Promise<void> => {
    if (!enabled) return

    // global dedupe
    const existing = inFlight.get(serializedKey)
    if (existing) {
      await existing
      return
    }

    const myGen = getGeneration(serializedKey)
    setQueryFetching(serializedKey, true)

    const fetchPromise = (async () => {
      try {
        // Use ref to get latest queryFn without including it in dependencies
        const result = await queryFnRef.current()

        // If someone removed/GC'd this key while we were in-flight, don’t resurrect it.
        if (getGeneration(serializedKey) !== myGen) return

        setCacheEntry(serializedKey, {
          data: result,
          dataUpdatedAt: Date.now(),
          error: null,
          errorUpdatedAt: null,
        })
        retryCounts.set(serializedKey, 0)
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        const maxRetries = retry === false ? 0 : retry
        const currentRetries = retryCounts.get(serializedKey) ?? 0

        if (currentRetries < maxRetries && getRefCount(serializedKey) > 0) {
          const next = currentRetries + 1
          retryCounts.set(serializedKey, next)

          // allow a new in-flight request for the retry attempt
          inFlight.delete(serializedKey)
          setQueryFetching(serializedKey, false)

          // Only clear the previous timeout, NOT the retry count.
          // Using clearRetryState here would reset retryCounts, causing infinite retries.
          // (see: _retryTestHelpers.simulateFailedFetch mirrors this logic)
          clearRetryTimeout(serializedKey)
          const t = setTimeout(() => {
            retryTimeouts.delete(serializedKey)
            // only retry if still mounted somewhere and key not deleted
            if (getRefCount(serializedKey) > 0 && getGeneration(serializedKey) === myGen) {
              void doFetch()
            }
          }, 1000 * next)
          retryTimeouts.set(serializedKey, t)
          return
        }

        retryCounts.set(serializedKey, 0)

        // Store error even if we have no existing data (error-only entry).
        if (getGeneration(serializedKey) !== myGen) return

        const existingEntry = getCacheEntry<T>(serializedKey)
        setCacheEntry(serializedKey, {
          data: existingEntry?.data,
          dataUpdatedAt: existingEntry?.dataUpdatedAt ?? 0,
          error: e,
          errorUpdatedAt: Date.now(),
        })
      } finally {
        inFlight.delete(serializedKey)
        setQueryFetching(serializedKey, false)

        // If nobody is watching and the entry was deleted, keep things tidy.
        if (getRefCount(serializedKey) === 0) {
          clearRetryState(serializedKey)
        }
      }
    })()

    inFlight.set(serializedKey, fetchPromise)
    await fetchPromise
  }, [enabled, serializedKey, retry])

  const refetch = useCallback(async (): Promise<void> => {
    clearRetryState(serializedKey)
    await doFetch()
  }, [doFetch, serializedKey])

  // Refcount + cancel pending GC when (re)subscribing
  useEffect(() => {
    const existingTimeout = gcTimeouts.get(serializedKey)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
      gcTimeouts.delete(serializedKey)
    }

    wasIdleRef.current = false
    incrementRefCount(serializedKey)

    return () => {
      const next = decrementRefCount(serializedKey)

      // If last observer is gone, don’t keep retry timers around.
      if (next === 0) {
        clearRetryState(serializedKey)
      }
    }
  }, [serializedKey])

  // Initial fetch on mount/key change/enabled toggle (intentionally minimal deps)
  useEffect(() => {
    mountedRef.current = true
    if (!enabled) return

    const currentEntry = getCacheEntry<T>(serializedKey)
    // Use isEntryStale for consistent staleness calculation that considers
    // both dataUpdatedAt and errorUpdatedAt (prevents rapid refetch loops
    // when endpoint returns persistent errors)
    const currentlyStale = isEntryStale(serializedKey, staleTime)

    const shouldFetchOnMount =
      refetchOnMount === 'always' ||
      (refetchOnMount && currentlyStale) ||
      (!currentEntry)

    if (shouldFetchOnMount) void doFetch()

    return () => {
      mountedRef.current = false
    }
  }, [enabled, serializedKey])

  // Polling
  useEffect(() => {
    if (!enabled || !refetchInterval) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      return
    }

    const tick = () => {
      if (pauseWhenIdle && !isUserActive(idleThreshold)) {
        wasIdleRef.current = true
        return
      }
      if (isEntryStale(serializedKey, staleTime)) {
        void doFetch()
      }
    }

    intervalRef.current = setInterval(tick, refetchInterval)
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [enabled, refetchInterval, pauseWhenIdle, idleThreshold, staleTime, serializedKey, doFetch])

  // Refetch on activity after idle
  useEffect(() => {
    if (!enabled || !refetchOnActivity) return

    const unsubscribe = subscribeToActivity(() => {
      if (wasIdleRef.current) {
        wasIdleRef.current = false
        if (isEntryStale(serializedKey, staleTime)) {
          void doFetch()
        }
      }
    })

    const checkIdle = setInterval(() => {
      if (!isUserActive(idleThreshold)) {
        wasIdleRef.current = true
      }
    }, 5000)

    return () => {
      unsubscribe()
      clearInterval(checkIdle)
    }
  }, [enabled, refetchOnActivity, idleThreshold, staleTime, serializedKey, doFetch])

  // Garbage collection
  useEffect(() => {
    return () => {
      const timeoutId = setTimeout(() => {
        if (getRefCount(serializedKey) === 0) {
          deleteCacheEntry(serializedKey)
          gcTimeouts.delete(serializedKey)
        }
      }, gcTime)

      gcTimeouts.set(serializedKey, timeoutId)
    }
  }, [serializedKey, gcTime])

  return {
    data,
    isLoading,
    isFetching,
    isSuccess: cachedEntry != null && cachedEntry.error == null && cachedEntry.dataUpdatedAt !== 0,
    error,
    refetch,
  }
}

/**
 * Invalidate a query, causing it to refetch on next access.
 */
export function invalidateActivityQuery(queryKey: readonly unknown[]): void {
  const key = serializeQueryKey(queryKey)
  const entry = getCacheEntry(key)
  if (!entry) return
  setCacheEntry(key, { ...entry, dataUpdatedAt: 0 })
}

/**
 * Remove a query from the cache entirely.
 */
export function removeActivityQuery(queryKey: readonly unknown[]): void {
  const key = serializeQueryKey(queryKey)

  const existingTimeout = gcTimeouts.get(key)
  if (existingTimeout) {
    clearTimeout(existingTimeout)
    gcTimeouts.delete(key)
  }

  deleteCacheEntry(key)
}

/**
 * Read cached data.
 */
export function getActivityQueryData<T>(queryKey: readonly unknown[]): T | undefined {
  const key = serializeQueryKey(queryKey)
  return getCacheEntry<T>(key)?.data
}

/**
 * Write cached data (optimistic updates).
 */
export function setActivityQueryData<T>(queryKey: readonly unknown[], data: T): void {
  const key = serializeQueryKey(queryKey)
  setCacheEntry(key, {
    data,
    dataUpdatedAt: Date.now(),
    error: null,
    errorUpdatedAt: null,
  })
}

/**
 * Reset the activity query cache (mainly for testing).
 */
export function resetActivityQueryCache(): void {
  for (const timeoutId of gcTimeouts.values()) clearTimeout(timeoutId)
  gcTimeouts.clear()

  for (const t of retryTimeouts.values()) clearTimeout(t)
  retryTimeouts.clear()
  retryCounts.clear()

  cache.entries.clear()
  cache.keyListeners.clear()
  cache.refCounts.clear()
  cache.fetchingKeys.clear()

  inFlight.clear()
  snapshotMemo.clear()
  generations.clear()
}

/**
 * Set an error-only cache entry (for testing).
 * This simulates what happens when a fetch fails with no prior successful data.
 */
export function setErrorOnlyCacheEntry(
  queryKey: readonly unknown[],
  error: Error,
  errorUpdatedAt?: number,
): void {
  const key = serializeQueryKey(queryKey)
  setCacheEntry(key, {
    data: undefined,
    dataUpdatedAt: 0,
    error,
    errorUpdatedAt: errorUpdatedAt ?? Date.now(),
  })
}

/**
 * Test helpers for verifying retry behavior.
 * These expose internal retry state to allow unit testing the retry logic
 * without needing a React renderer.
 */
export const _retryTestHelpers = {
  getRetryCount(queryKey: readonly unknown[]): number {
    return retryCounts.get(serializeQueryKey(queryKey)) ?? 0
  },
  setRetryCount(queryKey: readonly unknown[], count: number): void {
    retryCounts.set(serializeQueryKey(queryKey), count)
  },
  getRetryTimeout(queryKey: readonly unknown[]): ReturnType<typeof setTimeout> | undefined {
    return retryTimeouts.get(serializeQueryKey(queryKey))
  },
  setRefCount(queryKey: readonly unknown[], count: number): void {
    const key = serializeQueryKey(queryKey)
    if (count === 0) cache.refCounts.delete(key)
    else cache.refCounts.set(key, count)
  },
  setFetching(queryKey: readonly unknown[], fetching: boolean): void {
    setQueryFetching(serializeQueryKey(queryKey), fetching)
  },
  getInFlight(queryKey: readonly unknown[]): boolean {
    return inFlight.has(serializeQueryKey(queryKey))
  },
  /**
   * Simulate the exact retry scheduling logic from doFetch's catch block.
   * This reproduces the code path that caused the infinite retry loop bug.
   * Returns whether a retry was scheduled (true) or retries were exhausted (false).
   */
  simulateFailedFetch(
    queryKey: readonly unknown[],
    maxRetries: number,
  ): { retryScheduled: boolean; retryCount: number } {
    const key = serializeQueryKey(queryKey)
    const currentRetries = retryCounts.get(key) ?? 0

    if (currentRetries < maxRetries && (cache.refCounts.get(key) ?? 0) > 0) {
      const next = currentRetries + 1
      retryCounts.set(key, next)

      inFlight.delete(key)
      setQueryFetching(key, false)

      // This is the fixed line — uses clearRetryTimeout instead of clearRetryState
      clearRetryTimeout(key)

      // Don't actually schedule a setTimeout in tests, just record the intent
      return { retryScheduled: true, retryCount: next }
    }

    retryCounts.set(key, 0)

    const existingEntry = getCacheEntry(key)
    setCacheEntry(key, {
      data: existingEntry?.data,
      dataUpdatedAt: existingEntry?.dataUpdatedAt ?? 0,
      error: new Error('Simulated fetch error'),
      errorUpdatedAt: Date.now(),
    })

    inFlight.delete(key)
    setQueryFetching(key, false)

    return { retryScheduled: false, retryCount: 0 }
  },
}
