import { create } from 'zustand'

import { getAuthTokenDetails } from '../utils/auth'
import { freebuffCliAttemptId } from '../utils/freebuff-session-identity'
import { saveFreebuffSessionForRelaunch } from '../utils/freebuff-session-relaunch'
import {
  callFreebuffSession,
  holdsLiveFreebuffSlot,
  FreebuffSessionRequestError,
} from '../utils/freebuff-session-api'

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
 * Navigation controls (force re-POST, mark superseded/ended) live on
 * the module exports of `use-freebuff-session.ts` rather than on this store —
 * that way callers don't need to null-check a "driver" slot whose lifetime
 * is tied to the React tree.
 */
interface FreebuffSessionStore {
  session: FreebuffSessionResponse | null
  /** A POST may commit without a reply. Exit must cancel that exact attempt. */
  pendingAdmission: { instanceId: string; token: string } | null
  setPendingAdmission: (
    admission: { instanceId: string; token: string } | null,
  ) => void
  lastRefund: number | null
  pendingRefund: { instanceId: string; token: string } | null
  refreshRefund: () => Promise<void>
  releaseSlot: (
    session?: FreebuffSessionResponse,
    signal?: AbortSignal,
  ) => Promise<void>
  /**
   * This process is being replaced by the launcher's update restart: keep the
   * held slot instead of ending it on the way out. Every later `releaseSlot`
   * is a no-op, which covers both exit paths — `exitCliCleanly` and the
   * session hook's unmount cleanup that renderer teardown triggers.
   *
   * A multi-session CLI writes a launcher-scoped handoff and reclaims its exact
   * instance. Legacy trials find a dead local owner and take over its row.
   * Thus the user keeps the hour they just bought and never sees
   * the model picker again. Ending it instead dropped them on the picker with
   * the full price showing: the hour was still reusable server-side, but
   * nothing said so, and some bought a different model or left.
   */
  keepSlotForRelaunch: () => void
  slotKeptForRelaunch: boolean
  failure: FreebuffSessionFailure | null

  setSession: (session: FreebuffSessionResponse | null) => void
  setFailure: (failure: FreebuffSessionFailure | null) => void
}

function instanceOf(
  session: FreebuffSessionResponse | null | undefined,
): string | undefined {
  return session && 'instanceId' in session ? session.instanceId : undefined
}

export const useFreebuffSessionStore = create<FreebuffSessionStore>(
  (set, get) => {
    // Coalesce exit, unmount and explicit end for the same authenticated instance.
    const releases = new Map<string, Promise<void>>()
    return {
      session: null,
      pendingAdmission: null,
      setPendingAdmission: (pendingAdmission) => set({ pendingAdmission }),
      lastRefund: null,
      pendingRefund: null,
      refreshRefund: async () => {
        const pending = get().pendingRefund
        if (!pending || getAuthTokenDetails().token !== pending.token) return
        const receipt = await callFreebuffSession('DELETE', pending.token, {
          instanceId: pending.instanceId,
        })
        if (
          get().pendingRefund !== pending ||
          getAuthTokenDetails().token !== pending.token
        )
          return
        if (receipt.status === 'ended' && !receipt.freebucksRefundPending)
          set({ lastRefund: receipt.freebucksRefund ?? 0, pendingRefund: null })
      },
      slotKeptForRelaunch: false,
      keepSlotForRelaunch: () => {
        const session = get().session
        if (
          freebuffCliAttemptId(
            instanceOf(session) ?? get().pendingAdmission?.instanceId,
          )
        ) {
          const token = getAuthTokenDetails().token
          if (
            session?.status !== 'active' ||
            !token ||
            !saveFreebuffSessionForRelaunch(
              {
                instanceId: session.instanceId,
                model: session.model,
              },
              token,
            )
          )
            return
        }
        set({ slotKeptForRelaunch: true })
      },
      releaseSlot: (target = get().session ?? undefined, signal) => {
        if (get().slotKeptForRelaunch) return Promise.resolve()
        const pending = get().pendingAdmission
        const instanceId = holdsLiveFreebuffSlot(target ?? null)
          ? instanceOf(target)
          : pending?.instanceId
        if (!instanceId) return Promise.resolve()
        const token =
          pending?.instanceId === instanceId
            ? pending.token
            : getAuthTokenDetails().token
        if (!token || !instanceId) {
          return Promise.reject(
            new Error(
              'Cannot end the session without authentication and its instance id.',
            ),
          )
        }
        const key = JSON.stringify([token, instanceId])
        const existing = releases.get(key)
        if (existing) return existing
        const owner = get().session
        const stillOwned = () =>
          (get().session === owner ||
            (instanceOf(owner) !== undefined &&
              instanceOf(get().session) === instanceOf(owner))) &&
          getAuthTokenDetails().token === token
        const release = (async () => {
          try {
            const result = await callFreebuffSession('DELETE', token, {
              instanceId,
              signal,
            })
            if (result.status !== 'ended') {
              throw new Error(
                'The server did not confirm that the session ended.',
              )
            }
            if (get().pendingAdmission === pending)
              set({ pendingAdmission: null })
            if (stillOwned())
              set({
                lastRefund: result.freebucksRefund ?? null,
                pendingRefund: result.freebucksRefundPending
                  ? { instanceId, token }
                  : null,
                failure: null,
              })
          } catch (error) {
            if (stillOwned())
              set({
                failure: {
                  type: 'other',
                  message:
                    error instanceof Error ? error.message : String(error),
                  retry: null,
                  outcomeUnknown:
                    !(error instanceof FreebuffSessionRequestError) ||
                    error.statusCode >= 500,
                },
              })
            throw error
          } finally {
            releases.delete(key)
          }
        })()
        releases.set(key, release)
        return release
      },
      failure: null,
      setSession: (session) =>
        set({
          session,
          ...(session === null ? { pendingAdmission: null } : {}),
          ...(session === null || session.status === 'active'
            ? { lastRefund: null, pendingRefund: null }
            : {}),
        }),
      setFailure: (failure) => set({ failure }),
    }
  },
)
