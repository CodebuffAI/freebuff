import { create } from 'zustand'

import type { FreebuffSessionResponse } from '../types/freebuff-session'

export interface FreebuffSessionRetry {
  /** One-based number of the request that will be made next. */
  attempt: number
  /** Absolute client timestamp when the poll loop will retry. */
  retryAtMs: number
}

interface FreebuffSessionFailureBase {
  message: string
  retry: FreebuffSessionRetry | null
  /** The server may have committed a mutating request before its result was lost. */
  outcomeUnknown: boolean
}

export type FreebuffSessionFailure =
  | (FreebuffSessionFailureBase & {
      type: 'http'
      statusCode: number
    })
  | (FreebuffSessionFailureBase & {
      type: 'timeout' | 'other'
    })

/**
 * Shared state for the freebuff free session.
 *
 * The hook in `use-freebuff-session.ts` owns the poll loop and writes into
 * this store; React components subscribe via selectors, and non-React code
 * reads via `useFreebuffSessionStore.getState()`.
 *
 * Imperative session controls (force re-POST, mark superseded/ended) live on
 * the module exports of `use-freebuff-session.ts` rather than on this store —
 * that way callers don't need to null-check a "driver" slot whose lifetime
 * is tied to the React tree.
 */
interface FreebuffSessionStore {
  session: FreebuffSessionResponse | null
  failure: FreebuffSessionFailure | null
  /**
   * The user ID that owns the current active session. Set when the session
   * becomes `active`, cleared when the session ends. Used to prevent
   * account-switching abuse — if a session is bound to user A, user B
   * cannot log in on the same machine without ending the session first.
   */
  sessionBoundUserId: string | null

  setSession: (session: FreebuffSessionResponse | null) => void
  setFailure: (failure: FreebuffSessionFailure | null) => void
  setSessionBoundUserId: (userId: string | null) => void
}

export const useFreebuffSessionStore = create<FreebuffSessionStore>((set) => ({
  session: null,
  failure: null,
  sessionBoundUserId: null,
  setSession: (session) => set({ session }),
  setFailure: (failure) => set({ failure }),
  setSessionBoundUserId: (userId) => set({ sessionBoundUserId: userId }),
}))
