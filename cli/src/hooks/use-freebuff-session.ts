import { nextFreebucksPriceChange } from '@codebuff/common/util/freebuff-price-changes'
import {
  FALLBACK_FREEBUFF_MODEL_ID,
  freebuffWithdrawnModelMessage,
  getFreebuffModel,
  isFreebuffLimitedOfferModelId,
  resolveFreebuffModelForAccessTier,
} from '@codebuff/common/constants/freebuff-models'
import {
  getLimitedModelOffers,
  getRateLimitsByModel,
  getReferralInfo,
  getFreebucksInfo,
  getSubscriptionInfo,
} from '@codebuff/common/types/freebuff-session'
import { useEffect } from 'react'

import {
  getSelectedFreebuffModel,
  useFreebuffModelStore,
} from '../state/freebuff-model-store'
import { useChatStore } from '../state/chat-store'
import { useFreebuffSessionStore } from '../state/freebuff-session-store'
import { getAuthTokenDetails } from '../utils/auth'
import { stopActiveRun } from '../utils/active-run'
import { IS_FREEBUFF } from '../utils/constants'
import {
  isFreebuffInstanceOwnedByDeadLocalProcess,
  recordFreebuffInstanceOwner,
} from '../utils/freebuff-instance-owner'
import { logger } from '../utils/logger'
import { getSystemMessage } from '../utils/message-history'
import {
  clearReferralCache,
  getCachedReferral,
  rememberReferral,
} from '../utils/freebuff-referral-cache'
import {
  callFreebuffSession,
  classifyFreebuffSessionRequestFailure,
  FreebuffSessionRequestError,
  holdsLiveFreebuffSlot,
  isFreebuffSessionTimeoutError,
  mergeCompactActiveSession,
} from '../utils/freebuff-session-api'
import {
  failedPollDelayMs,
  jitterPollIntervalMs,
} from '../utils/polling-backoff'
import { saveFreebuffModelPreference } from '../utils/settings'

import type { FreebuffSessionResponse } from '../types/freebuff-session'
import type {
  FreebuffCountryBlockReason,
  FreebuffIpPrivacySignal,
} from '@codebuff/common/types/freebuff-session'

const POLL_INTERVAL_ACTIVE_MS = 30_000

/** Play the terminal bell so users get an audible notification on admission. */
const playAdmissionSound = () => {
  try {
    process.stdout.write('\x07')
  } catch {
    // Silent fallback — some terminals/pipes disallow writing to stdout.
  }
}

/** Picks the poll delay after a successful tick. Returns null when the state
 *  is terminal (no further polling). */
function nextDelayMs(next: FreebuffSessionResponse): number | null {
  const activeCadenceMs = jitterPollIntervalMs({
    intervalMs: POLL_INTERVAL_ACTIVE_MS,
  })
  switch (next.status) {
    case 'active':
      // Poll at the normal cadence, but ensure we land just after
      // `expires_at` so the transition shows up promptly instead of leaving
      // the countdown stuck at 0 for up to a full interval.
      return Math.max(
        1_000,
        Math.min(activeCadenceMs, next.remainingMs + 1_000),
      )
    case 'ended':
      // Inside the grace window we keep checking so the post-grace transition
      // (server returns `none`, we synthesize ended-no-instanceId) is prompt.
      return next.instanceId ? activeCadenceMs : null
    case 'none':
    case 'superseded':
    case 'takeover_prompt':
    case 'country_blocked':
    case 'banned':
    case 'model_locked':
    case 'rate_limited':
    case 'spend_limited':
    case 'ip_capped':
    case 'model_unavailable':
    case 'premium_slot_taken':
      return null
  }
}

// --- Poll-loop control surface ---------------------------------------------
//
// The hook below registers a controller object here on mount; module-level
// imperative functions (restart / mark superseded / mark ended / etc.) talk
// to it without going through React. Non-React callers (chat-completions
// gate, exit paths) hit those functions directly.

/** How the next tick should behave after a forced restart.
 *   - 'rejoin'  → POST: claim/rotate a seat (used after explicit end-and-rejoin
 *                 or when the chat gate kicks us back to the queue).
 *   - 'landing' → GET: drop to the model-picker (status 'none') so the user
 *                 reconfirms a model before rejoining. */
type RestartMode = 'rejoin' | 'landing'

interface PollController {
  /** Cancel the in-flight tick + timer and start a fresh one in `mode`. */
  restart: (mode: RestartMode) => Promise<void>
  apply: (next: FreebuffSessionResponse) => void
  abort: () => void
}

let controller: PollController | null = null

/**
 * The model of the most recent EXPLICIT user pick (startFreebuffSession),
 * consumed by the first server response that follows it. Lets the
 * `model_locked` branch tell a deliberate pick apart from a background
 * rejoin/race: only the former deserves a visible explanation. Cleared on
 * every response so a stale pick can never annotate a later, unrelated lock.
 */
let pendingExplicitPickModel: string | null = null

/** Read the current instance id for outgoing chat requests. Defined via
 *  `holdsLiveFreebuffSlot` so the two can't drift: an id exists exactly while
 *  we hold a live slot (active, or `ended` inside the server-side grace
 *  window where the row stays alive until `expires_at + grace`). */
export function getFreebuffInstanceId(): string | undefined {
  const current = useFreebuffSessionStore.getState().session
  if (!current || !holdsLiveFreebuffSlot(current)) return undefined
  return 'instanceId' in current ? current.instanceId : undefined
}

/** True when the session represents a server-side slot the caller is
 *  holding (active, or in the post-expiry grace window with a live
 *  instance id). Chat requests are only admissible in these states — once
 *  the slot is gone, `getFreebuffInstanceId` returns undefined and the
 *  server rejects the request — so the message queue gates on this before
 *  firing queued work. Same predicate gates DELETE on exit: outside these
 *  states there is no server row to release. */
export function toLandingSession(
  current: FreebuffSessionResponse | null,
): Extract<FreebuffSessionResponse, { status: 'none' }> {
  const accessTier =
    current && 'accessTier' in current ? current.accessTier : undefined
  const rateLimitsByModel = getRateLimitsByModel(current)
  const referral = accessTier
    ? (getReferralInfo(current) ?? getCachedReferral(accessTier))
    : undefined
  const countryCode =
    current && 'countryCode' in current ? current.countryCode : undefined
  const countryBlockReason =
    current && 'countryBlockReason' in current
      ? current.countryBlockReason
      : undefined
  const ipPrivacySignals =
    current && 'ipPrivacySignals' in current
      ? current.ipPrivacySignals
      : undefined
  // Carried over so the picker doesn't lose the limited-offer row for the one
  // frame between synthesizing this state and the GET that refreshes it. The
  // GET is authoritative: if the wave has since been spent, the next response
  // simply omits the offer and the row disappears.
  const limitedModelOffers = getLimitedModelOffers(current)
  // Same carry as rateLimitsByModel: the plan panel must not blink out
  // between dropping to the picker and the refreshing GET.
  const subscription = getSubscriptionInfo(current)
  // And the meter itself, for the same reason and with more at stake: without
  // this the picker falls back to session rings for the frame between the
  // synthesized state and the GET, which on a metered account is a different
  // product flickering into view.
  const freebucks = getFreebucksInfo(current)

  return {
    status: 'none',
    ...(accessTier ? { accessTier } : {}),
    ...(rateLimitsByModel ? { rateLimitsByModel } : {}),
    ...(referral ? { referral } : {}),
    ...(subscription ? { subscription } : {}),
    ...(freebucks ? { freebucks } : {}),
    ...(limitedModelOffers.length > 0 ? { limitedModelOffers } : {}),
    ...(countryCode ? { countryCode } : {}),
    ...(countryBlockReason ? { countryBlockReason } : {}),
    ...(ipPrivacySignals ? { ipPrivacySignals } : {}),
  }
}

interface RestartOpts {
  resetChat?: boolean
  /** DELETE the held slot before restarting so the next POST starts clean. */
  releaseSlot?: boolean
}

async function restartFreebuffSession(
  mode: RestartMode,
  opts: RestartOpts = {},
): Promise<void> {
  if (!IS_FREEBUFF) return
  // A reset changes chat ownership. Stop and checkpoint the old run before
  // resetting its store so late deltas cannot land in the next session.
  if (opts.resetChat) {
    stopActiveRun('session-transition')
  }
  // Halt the running poll loop before we touch local stores or DELETE the
  // slot. Otherwise an in-flight GET could land mid-reset and overwrite
  // state, or the next scheduled tick could fire between DELETE and
  // restart() with stale assumptions. restart() re-aborts and re-arms
  // below; the extra abort here is cheap.
  const currentController = controller
  const currentToken = getAuthTokenDetails().token
  const currentSession = useFreebuffSessionStore.getState().session
  const stillCurrent = () =>
    controller === currentController &&
    getAuthTokenDetails().token === currentToken &&
    useFreebuffSessionStore.getState().session === currentSession
  currentController?.abort()
  if (opts.releaseSlot) {
    try {
      await useFreebuffSessionStore.getState()
    .releaseSlot()
    } catch (error) {
      if (!stillCurrent()) throw error
      // Keep the chat and held instance: the server may already have credited
      // the refund. A retry must use that same instance to recover its receipt.
      useChatStore
        .getState()
        .setMessages((messages) => [
          ...messages,
          getSystemMessage(
            `Could not confirm the session ended. Retry /end-session. ${error instanceof Error ? error.message : String(error)}`,
          ),
        ])
      throw error
    }
  }
  if (!stillCurrent()) return
  if (opts.resetChat) useChatStore.getState().reset()
  await currentController?.restart(mode)
}

/**
 * Re-POST to the server (rejoining the queue / rotating the instance id).
 * Pass `resetChat: true` to also wipe local chat history — used when
 * rejoining after a session ended so the next admitted session starts fresh.
 */
export function refreshFreebuffSession(
  opts: { resetChat?: boolean } = {},
): Promise<void> {
  return restartFreebuffSession('rejoin', { resetChat: opts.resetChat })
}

/**
 * Drop back to the pre-join landing state (model picker) instead of auto
 * re-queuing. Used after a session ends: the user lands on the picker so
 * they consciously choose a model and hit Enter to join, rather than being
 * silently re-queued for whatever model they last used.
 */
export function returnToFreebuffLanding(
  opts: { resetChat?: boolean } = {},
): Promise<void> {
  return restartFreebuffSession('landing', {
    resetChat: opts.resetChat,
    releaseSlot: true,
  })
}

/** Refresh picker-only metadata (quota and queue depths) while staying on the
 * model selection screen. Used when a midnight-Pacific session quota reset
 * passes while the landing screen is open. */
export function refreshFreebuffLandingMetadata(): Promise<void> {
  return restartFreebuffSession('landing')
}

/** Resolve the model an explicit picker action will send to session admission. */
export function resolveFreebuffModelPickForSession(
  model: string,
  session: FreebuffSessionResponse | null,
) {
  const accessTier =
    session && 'accessTier' in session ? session.accessTier : 'full'
  // `subscription.tierId` is the server's authoritative entitlement verdict.
  // The picker uses the same signal to show plan models at limited access, so
  // the explicit-pick path must preserve those models instead of coercing them
  // back to MiMo before the session POST.
  const hasPaidSubscription = Boolean(getSubscriptionInfo(session)?.tierId)
  return resolveFreebuffModelForAccessTier(
    model,
    accessTier,
    hasPaidSubscription,
  )
}

/** Reconcile the picker selection when fresh session state arrives. */
export function resolveFreebuffModelSelectionForSession(
  selectedModel: string,
  session: FreebuffSessionResponse,
) {
  if (session.status === 'active') return session.model
  if (session.status === 'none' && session.accessTier === 'limited') {
    return resolveFreebuffModelPickForSession(selectedModel, session)
  }
  return selectedModel
}

/**
 * Start a session on `model` (admitted immediately server-side). Dual-purpose:
 *   - First start: called from the pre-chat landing picker. The session starts
 *     at `none` (GET-only); this is the user's explicit commitment to enter.
 *   - Switch: called when the user picks a different model from the landing
 *     screen. The server admits them on the new model right away.
 *
 * If the server has already admitted them on a different model, it responds
 * with `model_locked`; because this is a deliberate pick, the tick loop ends
 * that session and re-claims on the requested model (see the model_locked
 * branch). Background rejoins hitting the same lock revert silently instead.
 */
export function startFreebuffSession(model: string): Promise<void> {
  if (!IS_FREEBUFF) return Promise.resolve()
  // This is the only explicit user-pick path (called from the picker on
  // click / Enter), so persistence belongs here — and ONLY here. Server-
  // driven flips (`model_locked`, `model_unavailable`, takeover) go
  // through `setSelectedModel` directly, which never writes to disk.
  const current = useFreebuffSessionStore.getState().session
  const resolved = resolveFreebuffModelPickForSession(model, current)
  // Remember that the next POST is a deliberate pick, so a `model_locked`
  // rejection explains itself in chat instead of reverting silently.
  pendingExplicitPickModel = resolved
  useFreebuffModelStore.getState().setSelectedModel(resolved)
  saveFreebuffModelPreference(resolved)
  return restartFreebuffSession('rejoin')
}

let takeoverInFlight: Promise<void> | null = null

export function takeOverFreebuffSession(): Promise<void> {
  if (!IS_FREEBUFF) return Promise.resolve()
  if (takeoverInFlight) return takeoverInFlight

  const { session } = useFreebuffSessionStore.getState()
  if (session?.status !== 'takeover_prompt') {
    return Promise.resolve()
  }

  useFreebuffModelStore.getState().setSelectedModel(session.model)
  takeoverInFlight = restartFreebuffSession('rejoin').finally(() => {
    takeoverInFlight = null
  })
  return takeoverInFlight
}

export function markFreebuffSessionSuperseded(): void {
  if (!IS_FREEBUFF) return
  controller?.abort()
  controller?.apply({ status: 'superseded' })
}

/** Flip into the terminal `country_blocked` state from outside the poll loop.
 *  Used when the chat-completions gate rejects on country even though the
 *  session-level country check did not catch the request first.
 *  Transitioning the session state here unmounts the Chat surface in favor of
 *  the landing screen's country_blocked message, so the user can't keep typing
 *  and sending doomed requests. */
export function markFreebuffSessionCountryBlocked(params: {
  countryCode: string
  countryBlockReason?: FreebuffCountryBlockReason
  ipPrivacySignals?: FreebuffIpPrivacySignal[]
}): void {
  if (!IS_FREEBUFF) return
  controller?.abort()
  controller?.apply({ status: 'country_blocked', ...params })
  // Best-effort DELETE so we don't hold a session row the server is already
  // refusing to serve at chat time.
  useFreebuffSessionStore
    .getState().releaseSlot()
    .catch(() => {})
}

/** Flip into the local `ended` state without an instanceId (server has lost
 *  our row). The chat surface stays mounted with the rejoin banner.
 *  Preserves any `rateLimitsByModel` snapshot from the prior session so the
 *  banner can show today's session count without an extra fetch. */
export function markFreebuffSessionEnded(): void {
  if (!IS_FREEBUFF) return
  controller?.abort()
  const current = useFreebuffSessionStore.getState().session
  const rateLimitsByModel = getRateLimitsByModel(current)
  controller?.apply({
    status: 'ended',
    accessTier:
      current && 'accessTier' in current ? current.accessTier : undefined,
    rateLimitsByModel,
    subscription: getSubscriptionInfo(current),
    // The post-session banner and the picker behind it both read the meter.
    freebucks: getFreebucksInfo(current),
  })
}

interface UseFreebuffSessionResult {
  session: FreebuffSessionResponse | null
  failure: ReturnType<typeof useFreebuffSessionStore.getState>['failure']
  lastRefund: number | null
  refundPending: boolean
}

/**
 * Manages the freebuff session lifecycle:
 *   - GET on mount to probe state (no auto-join; the user picks a model in
 *     the landing screen, which calls startFreebuffSession)
 *   - if the probe sees an existing seat, auto-takes-over when the prior
 *     local owner process is gone; otherwise asks before POSTing to rotate
 *     the instance id so any other CLI on the same account is superseded
 *   - polls GET while active to keep state fresh
 *   - re-POSTs on explicit refresh (chat gate rejected us, user switched
 *     models, user rejoined after ending)
 *   - DELETE on unmount so the slot frees up for the next user
 *   - plays a bell on admission to an active session
 */
export function useFreebuffSession(): UseFreebuffSessionResult {
  const session = useFreebuffSessionStore((s) => s.session)
  const failure = useFreebuffSessionStore((s) => s.failure)
  const lastRefund = useFreebuffSessionStore((s) => s.lastRefund)
  const pendingRefund = useFreebuffSessionStore((s) => s.pendingRefund)
  useEffect(() => {
    if (!pendingRefund) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        await useFreebuffSessionStore.getState().refreshRefund()
      } catch {
        /* Keep the pending receipt for a later retry. */
      }
      if (!cancelled) timer = setTimeout(poll, 3000)
    }
    timer = setTimeout(poll, 3000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pendingRefund])

  useEffect(() => {
    const { setSession, setFailure } = useFreebuffSessionStore.getState()

    if (!IS_FREEBUFF) {
      // Non-freebuff (Codebuff) builds never gate on a free session; leave the
      // store empty (app.tsx's session routing is all behind IS_FREEBUFF).
      setSession(null)
      return
    }

    const { token } = getAuthTokenDetails()
    if (!token) {
      logger.warn(
        {},
        '[freebuff-session] No auth token; skipping free-session admission',
      )
      setFailure({
        type: 'other',
        message: 'Not authenticated',
        retry: null,
        outcomeUnknown: false,
      })
      return
    }

    let cancelled = false
    let abortController = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    let previousStatus: FreebuffSessionResponse['status'] | null = null
    // A compact response for an unexpected session identity has no safe quota
    // snapshot to retain, so force exactly one rich poll to restore it.
    let needsFullActivePoll = false
    let restartGeneration = 0
    let consecutiveFailures = 0
    // Method for the NEXT tick. GET is read-only; POST claims/rotates a seat.
    // Startup is GET (probe before committing). After any POST completes we
    // flip back to GET. refresh() sets it to 'POST' for explicit join/rejoin;
    // the startup takeover branch does the same when the probe finds a seat.
    let nextMethod: 'GET' | 'POST' = 'GET'

    const apply = (next: FreebuffSessionResponse) => {
      rememberReferral(next)
      const selectedModel = getSelectedFreebuffModel()
      const resolvedModel = resolveFreebuffModelSelectionForSession(
        selectedModel,
        next,
      )
      if (resolvedModel !== selectedModel) {
        useFreebuffModelStore.getState().setSelectedModel(resolvedModel)
      }
      if (next.status === 'active') {
        recordFreebuffInstanceOwner(next.instanceId)
      }
      // A refusal carries no `freebucks` block of its own, and the landing
      // decides its wording by that block: without the carry, the monthly
      // wall read "You've used 2500 of 2500 sessions this month" — the
      // dollar allowance in cents, in the pool's shape, with the meter
      // forgotten. The block we hold is still the account's.
      if (
        (next.status === 'rate_limited' || next.status === 'spend_limited') &&
        getFreebucksInfo(next) === undefined
      ) {
        const carried = getFreebucksInfo(
          useFreebuffSessionStore.getState().session,
        )
        setSession(carried ? { ...next, freebucks: carried } : next)
      } else {
        setSession(next)
      }
      setFailure(null)
      previousStatus = next.status
    }

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }

    const schedule = (ms: number) => {
      if (cancelled) return
      clearTimer()
      timer = setTimeout(tick, ms)
    }

    const tick = async () => {
      if (cancelled) return
      const method = nextMethod
      const instanceId = getFreebuffInstanceId()
      const model = getSelectedFreebuffModel()
      const compact =
        method === 'GET' && previousStatus === 'active' && !needsFullActivePoll
      const fetchController = abortController
      const generation = restartGeneration
      try {
        const next = await callFreebuffSession(method, token, {
          signal: fetchController.signal,
          instanceId,
          model,
          compact,
        })
        if (
          cancelled ||
          fetchController.signal.aborted ||
          generation !== restartGeneration
        ) {
          return
        }
        consecutiveFailures = 0
        // After any successful call, default back to GET polling. The
        // takeover and model_locked branches below override this when they
        // need another POST.
        nextMethod = 'GET'

        // Consume the explicit-pick marker: it annotates exactly the first
        // response after a user pick, whatever that response turns out to be.
        const explicitPickModel = pendingExplicitPickModel
        pendingExplicitPickModel = null

        // The session is model-locked server-side: an active session on
        // another model rejects the switch. Two cases:
        //   - DELIBERATE pick (the explicit-pick marker was set): honor the
        //     click — end the locked session (usually a stale row from a
        //     crashed CLI; read its instance before deleting) and
        //     re-claim on the requested model. The marker is consume-once,
        //     so if the retried POST races another instance back into
        //     model_locked we take the revert branch instead of looping.
        //   - Background rejoin racing an admission: revert the local
        //     selection so the active session stays intact. Reverting a
        //     deliberate pick silently made "I clicked GLM 5.2 and it
        //     switched to DeepSeek V4 Flash" a recurring bug report
        //     (2026-07-30): sessions live 1h even when idle, so users
        //     constantly pick a model while a row is still active.
        if (next.status === 'model_locked') {
          if (explicitPickModel && explicitPickModel !== next.currentModel) {
            const current = getFreebuffModel(next.currentModel).displayName
            const requested = getFreebuffModel(explicitPickModel).displayName
            let released = false
            try {
              const held = await callFreebuffSession('GET', token, {
                signal: fetchController.signal,
              })
              if (
                !cancelled &&
                !fetchController.signal.aborted &&
                generation === restartGeneration &&
                held.status === 'active' &&
                held.model === next.currentModel
              ) {
                await useFreebuffSessionStore
                  .getState()
                  .releaseSlot(held, fetchController.signal)
                released = true
              }
            } catch {
              // DELETE failed — fall through to the revert-with-explanation
              // path below rather than stranding the user mid-switch.
            }
            if (
              cancelled ||
              fetchController.signal.aborted ||
              generation !== restartGeneration
            ) {
              return
            }
            if (released) {
              useChatStore
                .getState()
                .setMessages((prev) => [
                  ...prev,
                  getSystemMessage(
                    `Ended your previous session on ${current} and switched to ${requested}.`,
                  ),
                ])
              nextMethod = 'POST'
              schedule(0)
              return
            }
            useChatStore
              .getState()
              .setMessages((prev) => [
                ...prev,
                getSystemMessage(
                  `You're already in an active session on ${current}, and ending it failed, so the switch to ${requested} was not applied. Run /end-session, then pick ${requested}. (Sessions end on their own after 1 hour.)`,
                ),
              ])
          }
          useFreebuffModelStore.getState().setSelectedModel(next.currentModel)
          schedule(0)
          return
        }
        if (next.status === 'model_unavailable') {
          // Server says the requested model isn't available right now. Flip
          // to the always-available fallback for this run. In-memory only —
          // `setSelectedModel` doesn't persist, so the user's saved preference
          // is preserved for their next launch.
          //
          // A limited-offer model gets a sentence about it. Silence is fine for
          // deployment hours (the picker row says when they open), but here the
          // user pressed Enter on a row that was on screen a second ago and
          // would otherwise land on a different model with no explanation —
          // they lost a race for the wave's last slot.
          //
          // A WITHDRAWN model gets one too, and for a stronger reason: the
          // flip below is permanent for that pick, so silence would leave the
          // user's picker row looking fine forever while every session quietly
          // started somewhere else.
          if (next.withdrawn) {
            useChatStore
              .getState()
              .setMessages((prev) => [
                ...prev,
                getSystemMessage(
                  freebuffWithdrawnModelMessage(next.requestedModel),
                ),
              ])
          } else if (isFreebuffLimitedOfferModelId(next.requestedModel)) {
            const requested = getFreebuffModel(next.requestedModel).displayName
            const fallback = getFreebuffModel(
              FALLBACK_FREEBUFF_MODEL_ID,
            ).displayName
            useChatStore
              .getState()
              .setMessages((prev) => [
                ...prev,
                getSystemMessage(
                  `${requested}'s trial sessions just ran out, so this session started on ${fallback} instead. Check back later — we release more in batches.`,
                ),
              ])
          }
          useFreebuffModelStore
            .getState()
            .setSelectedModel(FALLBACK_FREEBUFF_MODEL_ID)
          // The unavailable response came from a POST attempt. Re-POST with
          // the fallback model; a GET would only redisplay the old ended row
          // and leave the restart banner stuck in its pending state.
          nextMethod = 'POST'
          schedule(0)
          return
        }

        // Startup takeover: the initial probe GET saw we already hold a seat
        // (from a prior CLI instance). Stop here and ask before POSTing to
        // rotate our instance id; otherwise opening a second freebuff would
        // immediately supersede the first one.
        // `previousStatus === null` fences this to the very first tick only.
        // Pin the selected model to whatever the server thinks we're on so
        // an explicit takeover preserves our queue position instead of
        // switching queues.
        if (
          method === 'GET' &&
          previousStatus === null &&
          next.status === 'active'
        ) {
          useFreebuffModelStore.getState().setSelectedModel(next.model)
          // A fast restart after Ctrl+C can observe the old server row before
          // best-effort DELETE lands. If the row belongs to a dead local
          // process, silently do the same POST as the Take over button.
          if (isFreebuffInstanceOwnedByDeadLocalProcess(next.instanceId)) {
            nextMethod = 'POST'
            schedule(0)
            return
          }
          apply({ status: 'takeover_prompt', model: next.model })
          return
        }

        // Bell on admission: the user committed to a model on the landing
        // screen (status 'none'), which POSTs and lands them straight on an
        // active session (admission is immediate).
        if (previousStatus === 'none' && next.status === 'active') {
          playAdmissionSound()
        }

        // active|ended → none means we've passed the server's hard cutoff.
        // Synthesize a no-instanceId ended state so the chat surface stays
        // mounted with the Enter-to-rejoin banner instead of looping back
        // through the landing screen. Carry forward whichever rate-limit
        // snapshot we have — preferring the fresh `none` snapshot, falling
        // back to whatever was on the prior active/ended row — so the
        // banner's "N of M used today" line stays populated.
        if (
          (previousStatus === 'active' || previousStatus === 'ended') &&
          next.status === 'none'
        ) {
          const current = useFreebuffSessionStore.getState().session
          const rateLimitsByModel =
            next.rateLimitsByModel ?? getRateLimitsByModel(current)
          apply({
            status: 'ended',
            accessTier:
              next.accessTier ??
              (current && 'accessTier' in current
                ? current.accessTier
                : undefined),
            rateLimitsByModel,
            subscription:
              getSubscriptionInfo(next) ?? getSubscriptionInfo(current),
            // Prefer the fresh block: a session that just ended was CHARGED,
            // so the server's balance is newer than the one we were holding.
            freebucks: getFreebucksInfo(next) ?? getFreebucksInfo(current),
          })
          return
        }

        if (compact && next.status === 'active') {
          const merged = mergeCompactActiveSession(
            useFreebuffSessionStore.getState().session,
            next,
          )
          needsFullActivePoll = merged === null
          apply(merged ?? next)
        } else {
          needsFullActivePoll = false
          apply(next)
        }
        if (needsFullActivePoll) {
          schedule(0)
          return
        }
        const priceDelay = nextFreebucksPriceChange(getFreebucksInfo(next)) - Date.now()
        const delay = Math.min(nextDelayMs(next) ?? Infinity, Math.max(0, priceDelay))
        if (Number.isFinite(delay)) schedule(delay)
      } catch (err) {
        if (
          cancelled ||
          fetchController.signal.aborted ||
          generation !== restartGeneration
        ) {
          return
        }
        const msg = err instanceof Error ? err.message : String(err)
        consecutiveFailures++
        const disposition = classifyFreebuffSessionRequestFailure(method, err)
        const shouldRetry = disposition === 'retry'
        const retryAfterMs =
          err instanceof FreebuffSessionRequestError
            ? err.retryAfterMs
            : undefined
        const delayMs = shouldRetry
          ? failedPollDelayMs({
              consecutiveFailures,
              retryAfterMs,
            })
          : null
        logger.warn(
          { error: msg, method, consecutiveFailures, delayMs, shouldRetry },
          shouldRetry
            ? '[freebuff-session] fetch failed; backing off'
            : '[freebuff-session] fetch failed; automatic retry stopped',
        )
        const retry =
          delayMs === null
            ? null
            : {
                attempt: consecutiveFailures + 1,
                retryAtMs: Date.now() + delayMs,
              }
        const failure = {
          message: msg,
          retry,
          outcomeUnknown: disposition === 'unknown',
        }
        if (err instanceof FreebuffSessionRequestError) {
          setFailure({
            ...failure,
            type: 'http',
            statusCode: err.statusCode,
          })
        } else if (isFreebuffSessionTimeoutError(err)) {
          setFailure({ ...failure, type: 'timeout' })
        } else {
          setFailure({ ...failure, type: 'other' })
        }
        if (delayMs !== null) schedule(delayMs)
      }
    }

    controller = {
      restart: async (mode) => {
        const generation = ++restartGeneration
        clearTimer()
        // Abort any in-flight fetch so it can't race us and overwrite state.
        abortController.abort()
        abortController = new AbortController()
        // Reset previousStatus so the admission bell still fires after
        // a forced restart, and so the active|ended → none synthesis below
        // doesn't bounce a 'landing' restart straight back to 'ended'.
        previousStatus = null
        needsFullActivePoll = false
        consecutiveFailures = 0
        setFailure(null)
        if (mode === 'landing') {
          nextMethod = 'GET'
          // Land on the picker immediately. We can't go through the normal
          // tick/apply path because a server-side row that hasn't been
          // swept yet would trip the startup-takeover branch into an
          // auto-POST — the exact silent-rejoin this mode exists to
          // prevent. But the picker still needs live quota snapshots, so kick
          // off a fire-and-forget GET and extract only picker metadata from
          // the response, ignoring whatever status it claims. Polling resumes
          // when the user commits to a model via startFreebuffSession.
          const landingSession = toLandingSession(
            useFreebuffSessionStore.getState().session,
          )
          apply(landingSession)
          const fetchController = abortController
          callFreebuffSession('GET', token, {
            signal: fetchController.signal,
          })
            .then((response) => {
              if (
                cancelled ||
                fetchController.signal.aborted ||
                generation !== restartGeneration
              ) {
                return
              }
              if (response.status === 'none') {
                // Preserve cached quota/location fields only when the tier is
                // unchanged (or an older response omitted it). Fresh response
                // fields win through the following object spread.
                const canReuseLandingMetadata =
                  response.accessTier === undefined ||
                  response.accessTier === landingSession.accessTier
                apply({
                  ...(canReuseLandingMetadata ? landingSession : {}),
                  ...response,
                  status: 'none',
                  accessTier: response.accessTier ?? landingSession.accessTier,
                  // A clean `none` response is authoritative for referral
                  // state. Do not retain the cached landing value when the
                  // server omits it (program disabled / identity removed).
                  referral: response.referral,
                  freebucks: getFreebucksInfo(response),
                })
              }
            })
            .catch(() => {
              // Silent — blank hints are acceptable if the fetch fails.
            })
          return
        }
        nextMethod = 'POST'
        await tick()
      },
      apply,
      abort: () => {
        clearTimer()
        abortController.abort()
      },
    }

    tick()

    return () => {
      cancelled = true
      abortController.abort()
      clearTimer()
      const current = useFreebuffSessionStore.getState().session
      controller = null
      clearReferralCache()

      // Fire-and-forget DELETE. Only release if we actually held a slot so
      // we don't generate spurious DELETEs (e.g. HMR before POST completes).
      if (holdsLiveFreebuffSlot(current)) {
        useFreebuffSessionStore
          .getState()
          .releaseSlot()
          .catch(() => {})
      }
      setSession(null)
      setFailure(null)
    }
  }, [])

  return { session, failure, lastRefund, refundPending: pendingRefund !== null }
}
