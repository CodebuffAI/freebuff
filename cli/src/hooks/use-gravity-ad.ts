import { WEBSITE_URL } from '@codebuff/sdk'
import type { PartnerBrand } from '@codebuff/common/ads/partner-brand'
import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { getAdUserAgent } from '@codebuff/common/util/ad-user-agent'
import { FREEBUFF_EVENT_ID_HEADER } from '@codebuff/common/ads/ad-event-hygiene'
import {
  acknowledgeFirstPartyView,
  firstPartyViewAckSettled,
  type FirstPartyViewAckRequest,
} from '@codebuff/common/ads/first-party-view-ack'
import { createFirstPartyViewAckTelemetry } from '@codebuff/common/util/axiom-only-log'
import { sanitizeTerminalStrings } from '@codebuff/common/util/terminal-safe-text'
import { useRenderer } from '@opentui/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useTerminalLayout } from './use-terminal-layout'
import { buildAdAuctionRequest } from '../ads/ad-request'
import {
  ensureAdTerminalFocusWatch,
  getAdTerminalFocus,
  noteAdClicked,
  noteAdTurnState,
  noteAdsServed,
  registerAdRenderer,
  getAdTranscriptViewport,
  subscribeAdTerminalFocus,
  subscribeAdUserSend,
  timedAdFetch,
  timedApiCall,
} from '../ads/ad-signals'
import { rowsIntersect, type MeasureRows } from '../ads/ad-engagement'
import {
  adEngagementRegistry,
  armAdAdoptionWatch,
  TRANSCRIPT_VISIBILITY_POLL_MS,
} from '../ads/use-ad-engagement'
import {
  isAdExpired,
  noteAdDrawn,
  noteAdExpiredEngagement,
} from '../ads/ad-expiry-clock'
import { AD_EXPIRY_CHECK_MS } from '@codebuff/common/ads/ad-expiry'
import {
  cardRequestNeedsNetworkHint,
  dockRequestNeedsNetworkHint,
  dropExpiredResponseAds,
  dropOurFillBesideNetwork,
  keepNewestResponseAd,
  suppressOurCards,
} from '../ads/ad-screen'
import { trackAdClickAck, watchAdClickReturn } from '../ads/click-return'
import { getAdsEnabled } from '../commands/ads'
import { useChatStore } from '../state/chat-store'
import { isUserActive, subscribeToActivity } from '../utils/activity-tracker'
import { getAuthToken } from '../utils/auth'
import { IS_FREEBUFF } from '../utils/constants'
import { logger } from '../utils/logger'
import { enqueueClientLog } from '../utils/log-shipper'
import { AI_MESSAGE_ID_PREFIX } from '../utils/ai-message-id'
import { trackEvent } from '../utils/analytics'
import {
  getAdDeviceInfo,
  getCliAdRequestUserAgent,
} from '../utils/ad-client-identity'
import { clientEnvironmentHeaders } from '../utils/client-environment'
import {
  createLazyResponseAdQueue,
  requestLazyResponseAds,
} from '../utils/lazy-response-ads'
import { RESPONSE_AD_END_SLOT_COUNT } from '../utils/response-ad-positions'

import type { ChatMessage } from '../types/chat'
import type { DockClickContext } from './use-dock-panel'
import { getSessionInlineAdStyle } from './use-dock-panel'
import { inlineAdRequestPlan } from '../ads/inline-link-ad'

const AD_ROTATION_INTERVAL_MS = 60 * 1000 // 60 seconds per ad
/**
 * Timer jitter a rotation tick tolerates: a tick is due once the last rotation
 * is at least the interval minus this old. Every rotation re-phases the timer,
 * so ticks normally land a full interval after the last rotation.
 */
export const AD_ROTATION_TICK_SLACK_MS = 1_000
const MAX_ADS_AFTER_ACTIVITY = 3 // Show up to 3 ads after last activity, then pause fetching new ads
const ACTIVITY_THRESHOLD_MS = 30_000 // 30 seconds idle threshold for fetching new ads
const MAX_AD_CACHE_SIZE = 50 // Maximum number of ads to keep in cache

/**
 * Whether the terminal's focus lets an ad be fetched or counted. Only a
 * reported `false` blocks: `undefined` means the terminal never reported
 * focus (no DEC 1004 support), which must read as focused, or every such
 * terminal would draw ads it never counts.
 */
export function adFocusAllows(focused: boolean | undefined): boolean {
  return focused !== false
}

/**
 * What one rotation tick of the slot above the input does.
 * - `skip`: nothing (ads off, the slot held by a proposal, or the terminal
 *   unfocused: no fetch, no swap, so no new impression either).
 * - `fetch`: auction a new ad (the activity rule: fewer than
 *   {@link MAX_ADS_AFTER_ACTIVITY} shown since the user last typed, and they
 *   typed within {@link ACTIVITY_THRESHOLD_MS}).
 * - `cache`: no auction; re-show a cached ad if there is one.
 * - `expire`: the drawn ad has been shown too long (`ad-expiry-clock.ts`):
 *   clear the slot. Decided before every reason to skip, so an unfocused
 *   terminal (whose ticks all skip) still loses its ad.
 *
 * After an expiry the slot stays empty until the person is active again
 * (`expiredIdle`): no cached re-show, and the next active tick fetches.
 */
export function rotationTickPlan(params: {
  adsEnabled: boolean
  slotPaused: boolean
  focused: boolean | undefined
  adsShownSinceActivity: number
  userActive: boolean
  /** `Date.now()` of the slot's last rotation; null or absent before any. */
  lastRotationAt?: number | null
  now?: number
  /** The drawn ad has expired under the shared rule. */
  currentExpired?: boolean
  /** The slot was cleared by an expiry and the person has not been active since. */
  expiredIdle?: boolean
}): 'skip' | 'fetch' | 'cache' | 'expire' {
  if (!params.adsEnabled) return 'skip'
  if (params.currentExpired) return 'expire'
  if (params.slotPaused) return 'skip'
  if (!adFocusAllows(params.focused)) return 'skip'
  // A rotation on focus return (or a first fetch run late) may have happened
  // since the last tick: never rotate twice within one interval.
  if (
    params.lastRotationAt != null &&
    params.now !== undefined &&
    params.now - params.lastRotationAt <
      AD_ROTATION_INTERVAL_MS - AD_ROTATION_TICK_SLACK_MS
  )
    return 'skip'
  if (params.adsShownSinceActivity < MAX_ADS_AFTER_ACTIVITY && params.userActive)
    return 'fetch'
  return params.expiredIdle ? 'skip' : 'cache'
}

/**
 * On focus returning: rotate now only when a full interval has passed since
 * the slot last rotated (ticks while unfocused were skipped, not queued).
 */
export function rotationDueOnFocus(params: {
  lastRotationAt: number | null
  now: number
  intervalMs?: number
}): boolean {
  if (params.lastRotationAt === null) return true
  return (
    params.now - params.lastRotationAt >=
    (params.intervalMs ?? AD_ROTATION_INTERVAL_MS)
  )
}

/**
 * An impression reported while the terminal is unfocused waits for focus;
 * a click (`force`) is proof of a view and always goes now.
 */
export function impressionDisposition(params: {
  focused: boolean | undefined
  force?: boolean
}): 'fire' | 'defer' {
  return params.force || adFocusAllows(params.focused) ? 'fire' : 'defer'
}

/**
 * Whether an answer's end-of-answer card may be auctioned now: the answer has
 * completed (the renderer only asks then), the terminal is not unfocused, and
 * the answer's end, where the card will draw, is in the transcript viewport.
 * `endVisible: undefined` (unmeasurable) does not hold the request back.
 */
export function inlineRequestDisposition(params: {
  count: number
  focused: boolean | undefined
  endVisible?: boolean
  /**
   * A sponsored offer holds the dock. It is never hidden, so the card waits
   * (retried until the offer has gone, while the answer is still newest).
   */
  offerInDock?: boolean
}): 'request' | 'defer' | 'none' {
  if (params.count <= 0) return 'none'
  if (params.offerInDock) return 'defer'
  if (!adFocusAllows(params.focused)) return 'defer'
  return params.endVisible === false ? 'defer' : 'request'
}

/** Whether the rows `measure` reports lie in the transcript viewport. */
export function answerEndVisible(
  measure: MeasureRows | undefined,
): boolean | undefined {
  if (!measure) return undefined
  try {
    return rowsIntersect(measure(), getAdTranscriptViewport())
  } catch {
    return undefined
  }
}

/**
 * The rotation clock after the slot gave way for `yieldedAt..now`: the
 * hidden time does not count, so the held ad gets the rest of its interval.
 * `firstTickInMs` is when the next rotation is due; null `lastRotationAt`
 * (nothing shown yet) starts a fresh interval.
 */
export function resumeRotationAfterYield(params: {
  lastRotationAt: number | null
  yieldedAt: number
  now: number
  intervalMs?: number
}): { lastRotationAt: number | null; firstTickInMs: number } {
  const interval = params.intervalMs ?? AD_ROTATION_INTERVAL_MS
  if (params.lastRotationAt === null)
    return { lastRotationAt: null, firstTickInMs: interval }
  const hiddenMs = Math.max(0, params.now - params.yieldedAt)
  const shownMs = Math.max(0, params.yieldedAt - params.lastRotationAt)
  return {
    lastRotationAt: params.lastRotationAt + hiddenMs,
    firstTickInMs: Math.max(0, interval - shownMs),
  }
}

/** The dock giving way, while it does: since when, and what it holds. */
export type SlotYieldHold = { since: number; impUrls: string[] }

/**
 * A rotation's answer that landed while the slot had given way (a fetch
 * already in flight when the card came into view): kept, not drawn, and
 * shown when the slot comes back, with no second request. `undefined` is
 * "nothing held"; `null` is a held "clear the slot" (a withheld answer).
 */
export type HeldRotation = AdResponse[] | null | undefined

/**
 * What one rotation answer does to the slot: `show` it now, or keep it
 * `held` because the slot has given way since the request left.
 */
export function deliverRotation(
  ctrl: { heldRotation: HeldRotation },
  show: AdResponse[] | null | undefined,
  yielded: boolean,
): 'show' | 'held' | 'none' {
  if (show === undefined) return 'none'
  if (!yielded) return 'show'
  ctrl.heldRotation = show
  return 'held'
}

/**
 * The slot giving way (`yielded` true) or coming back (false). Returns the
 * next hold. Giving way holds the drawn ads' engagement records open.
 * Coming back, in order: a rotation answer held meanwhile is shown (a full
 * interval from now); else a first fetch skipped meanwhile runs; else the
 * clock resumes with the rest of the held ad's interval. The held records
 * are released after the swap, so an ad replaced meanwhile ends as a
 * rotation.
 */
export function applySlotYield(
  hold: SlotYieldHold | null,
  params: {
    yielded: boolean
    now: number
    /** impUrls the slot draws now. */
    drawnImpUrls: readonly string[]
    /** The slot is started and not hidden. */
    slotActive: boolean
    focused: boolean | undefined
    ctrl: {
      lastRotationAt: number | null
      initialFetchPending: boolean
      heldRotation: HeldRotation
    }
    hold: (impUrl: string) => void
    release: (impUrl: string) => void
    show: (ads: AdResponse[] | null) => void
    runInitialFetch: () => void
    restartRotationTimer: (firstDelayMs?: number) => void
    intervalMs?: number
    /**
     * The held ad expired while hidden (it kept ageing): drop it instead of
     * showing it again.
     */
    heldExpired?: boolean
    expire?: () => void
  },
): SlotYieldHold | null {
  if (params.yielded) {
    if (hold) return hold
    const impUrls = [...params.drawnImpUrls]
    for (const impUrl of impUrls) params.hold(impUrl)
    return { since: params.now, impUrls }
  }
  if (!hold) return null
  const ctrl = params.ctrl
  const held = ctrl.heldRotation
  ctrl.heldRotation = undefined
  if (params.slotActive && held !== undefined) {
    params.show(held)
    ctrl.lastRotationAt = params.now
    params.restartRotationTimer()
  } else if (
    params.slotActive &&
    ctrl.initialFetchPending &&
    adFocusAllows(params.focused)
  ) {
    params.runInitialFetch()
    params.restartRotationTimer()
  } else if (params.slotActive && params.heldExpired && params.expire) {
    params.expire()
    params.restartRotationTimer()
  } else if (params.slotActive) {
    const resumed = resumeRotationAfterYield({
      lastRotationAt: ctrl.lastRotationAt,
      yieldedAt: hold.since,
      now: params.now,
      intervalMs: params.intervalMs,
    })
    ctrl.lastRotationAt = resumed.lastRotationAt
    params.restartRotationTimer(resumed.firstTickInMs)
  }
  for (const impUrl of hold.impUrls) params.release(impUrl)
  return null
}

/**
 * The impUrls on screen for the focus-return path: the dock's ads unless the
 * slot has given way, and every drawn end-of-answer card.
 */
export function drawnAdImpUrls(params: {
  dockAds: readonly AdResponse[] | null
  dockYielded: boolean
  responseAds: Record<string, readonly AdResponse[]>
}): Set<string> {
  const drawn = new Set<string>()
  if (!params.dockYielded)
    for (const ad of params.dockAds ?? []) drawn.add(ad.impUrl)
  for (const list of Object.values(params.responseAds))
    for (const ad of list) drawn.add(ad.impUrl)
  return drawn
}

/** The controller fields the focus-return path reads and writes. */
export type FocusReturnState = {
  lastRotationAt: number | null
  initialFetchPending: boolean
  deferredImpressions: Map<string, AdResponse>
}

/**
 * Focus returning: send impressions held while unfocused for ads still drawn
 * (ads no longer drawn are dropped), run a skipped first fetch or an overdue
 * rotation (re-phasing the rotation timer, so the next regular tick is a full
 * interval later), and retry a card request held while unfocused.
 */
export function handleAdFocusReturn(
  state: FocusReturnState,
  deps: {
    now: number
    /** impUrls of every ad currently drawn (dock and transcript cards). */
    drawnImpUrls: ReadonlySet<string>
    /** The slot above the input is running (started and not hidden). */
    slotActive: boolean
    recordImpression: (ad: AdResponse) => void
    runInitialFetch: () => void
    rotate: () => void
    restartRotationTimer: () => void
    retryDeferredInline: () => void
    intervalMs?: number
  },
): 'initial_fetch' | 'rotate' | 'none' {
  const deferred = [...state.deferredImpressions.values()]
  state.deferredImpressions.clear()
  for (const ad of deferred) {
    if (deps.drawnImpUrls.has(ad.impUrl)) deps.recordImpression(ad)
  }

  let rotated: 'initial_fetch' | 'rotate' | 'none' = 'none'
  if (deps.slotActive) {
    if (state.initialFetchPending) {
      deps.runInitialFetch()
      rotated = 'initial_fetch'
    } else if (
      rotationDueOnFocus({
        lastRotationAt: state.lastRotationAt,
        now: deps.now,
        intervalMs: deps.intervalMs,
      })
    ) {
      deps.rotate()
      rotated = 'rotate'
    }
    if (rotated !== 'none') deps.restartRotationTimer()
  }

  deps.retryDeferredInline()
  return rotated
}

// Ad response type (normalized shape across providers; credits added after impression)
export type AdResponse = {
  adText: string
  title: string
  cta: string
  url: string
  favicon: string
  clickUrl: string
  impUrl: string
  placementId?: string
  provider?: AdProvider
  credits?: number // Set after impression is recorded (in cents)
  /**
   * `Date.now()` when the auction RESPONSE was received (COD-365). The origin
   * of `renderDelayMs` on the impression ack: receipt to card mount, so our
   * own server latency (already on `ads.fetch_completed.duration_ms`) stays
   * out of a client metric. Absent on ads that predate the stamp; the ack
   * then simply omits the delay and the server stores unknown.
   */
  receivedAtMs?: number
  /**
   * Optional expanded creative for the dock's detail panel (COD-457). Only
   * first-party creatives carry these; a Gravity or house ad arrives
   * without them and the panel falls back to `adText`, no bullets, no diagram.
   */
  expandedBody?: string
  bullets?: string[]
  diagram?: string
  /** Explicit server-owned partner designation. */
  partnerBrand?: PartnerBrand
  /**
   * Reviewed fill and ink, `#rrggbb`, for custom partner rows. Ordinary ads
   * use them only with Greptile's explicit partner designation.
   */
  brandColor?: string
  brandInk?: string
  /**
   * Set only on an end-of-answer ad auctioned for the one-line link
   * (`Inline-Link-After-Agent-CLI`); absent means the card. Client-side only.
   */
  inlineStyle?: 'link'
}

/**
 * The one "no inline ads" value. It MUST keep its identity across renders:
 * Chat's layout effect lists `responseAds` as a dependency and writes it into
 * the message-block store, so a fresh `{}` per render (every render whenever
 * ads are hidden) re-ran that effect after every commit, scheduling another
 * store write and a synchronous re-render of every message block. During fast
 * streaming that is the chain of commits-with-pending-updates that React counts
 * toward "Maximum update depth exceeded" (#185).
 */
export const NO_RESPONSE_ADS: Record<string, AdResponse[]> = Object.freeze(
  {},
) as Record<string, AdResponse[]>

export function visibleResponseAds(
  visible: boolean,
  responseAds: Record<string, AdResponse[]>,
): Record<string, AdResponse[]> {
  return visible ? responseAds : NO_RESPONSE_ADS
}

/**
 * Whether the hook neither fetches nor acknowledges. A hidden hook makes no
 * auction, so nothing is served that the screen cannot draw.
 *
 * That matters beyond cost: the ad-signal detector reads `viewed / served`
 * per account (docs/freebuff-ad-signal-detection.md), so an ad fetched for a
 * slot that is not on screen counts against the user. Freebuff ignores the
 * compact-height rule because its chat slot always draws; a caller whose
 * slot can be hidden passes `enabled: false` for exactly as long as it is.
 */
export function shouldHideGravityAds(params: {
  enabled: boolean
  terminalHeight: number
  isFreeMode: boolean
}): boolean {
  const isVeryCompactHeight = params.terminalHeight <= 17
  return !params.enabled || (isVeryCompactHeight && !params.isFreeMode)
}

/**
 * Milliseconds from auction-response receipt to now, or undefined when the ad
 * carries no receipt time. Never negative: a clock that moved backwards is a
 * zero, not a rejection, mirroring the server's clamp.
 */
export function renderDelaySinceReceipt(
  ad: Pick<AdResponse, 'receivedAtMs'>,
  now: number = Date.now(),
): number | undefined {
  if (typeof ad.receivedAtMs !== 'number' || !Number.isFinite(ad.receivedAtMs))
    return undefined
  return Math.max(0, Math.round(now - ad.receivedAtMs))
}

/**
 * Which upstream ad network to query. The server maps each provider onto the
 * same normalized response shape, so the rest of the hook is provider-agnostic.
 */
export type AdProvider = 'gravity' | 'first_party'
// Product surfaces the ads API maps to Gravity placements. 'waiting_room' is the
// legacy wire name for the freebuff landing screen; 'cli_chat' is the inline
// transcript ad in the coding-agent chat. Values must match the server's
// AD_SURFACES enum, so don't rename them.
export type AdSurface = 'waiting_room' | 'cli_chat'

export type GravityAdState = {
  ads: AdResponse[] | null
  /**
   * End-of-answer ads keyed by assistant message id: at most
   * {@link RESPONSE_AD_END_SLOT_COUNT} per answer.
   */
  responseAds: Record<string, AdResponse[]>
  /** Auction an answer's end-of-answer card once the answer has completed. */
  requestResponseAds: (
    messageId: string,
    count: number,
    measureEnd?: MeasureRows,
  ) => void
  isLoading: boolean
  recordClick: (ad: AdResponse, dock?: DockClickContext) => void
  recordImpression: (ad: AdResponse) => void
}

// Consolidated controller state for the ad rotation logic
type GravityController = {
  choiceCache: AdResponse[][] // Cache of ad sets (choice or single-ad units)
  choiceCacheIndex: number
  impressionsFired: Set<string>
  adsShownSinceActivity: number
  tickInFlight: boolean
  inlineQueue: ReturnType<typeof createLazyResponseAdQueue<AdResponse>>
  eligibleSlotCounts: Map<string, number>
  /** `Date.now()` of the slot's last fetch or rotation, null before the first. */
  lastRotationAt: number | null
  /** The first fetch was skipped because the terminal was unfocused. */
  initialFetchPending: boolean
  /** Impressions reported while unfocused, sent when focus returns. */
  deferredImpressions: Map<string, AdResponse>
  /**
   * Answers whose card was asked for while the terminal was unfocused or the
   * answer's end was off screen, with the measure of that end. Retried on
   * focus return and on a poll; cleared when the user sends a new prompt.
   */
  deferredInlineRequests: Map<string, MeasureRows | undefined>
  /** Polls deferred card requests while any are held. */
  deferredInlinePoll: ReturnType<typeof setInterval> | null
  /** A rotation answer that landed while the slot had given way. */
  heldRotation: HeldRotation
  /** The slot was cleared by an expiry; no cached re-show until activity. */
  expiredIdle: boolean
}

type ChoiceCache = Pick<GravityController, 'choiceCache' | 'choiceCacheIndex'>

// Pure helper: add an ad set to the cache
function addToChoiceCache(ctrl: ChoiceCache, ads: AdResponse[]): void {
  // Deduplicate by checking if any set has the same first impUrl
  const key = ads[0]?.impUrl
  if (key && ctrl.choiceCache.some((set) => set[0]?.impUrl === key)) return
  if (ctrl.choiceCache.length >= MAX_AD_CACHE_SIZE) ctrl.choiceCache.shift()
  ctrl.choiceCache.push(ads)
}

// Pure helper: get the next cached ad set, passing over expired ones (an
// expired impression is never drawn again).
function nextFromChoiceCache(
  ctrl: ChoiceCache,
  isExpired: (impUrl: string) => boolean = () => false,
): AdResponse[] | null {
  for (let tries = 0; tries < ctrl.choiceCache.length; tries++) {
    const set =
      ctrl.choiceCache[ctrl.choiceCacheIndex % ctrl.choiceCache.length]!
    ctrl.choiceCacheIndex =
      (ctrl.choiceCacheIndex + 1) % ctrl.choiceCache.length
    if (!set.some((ad) => isExpired(ad.impUrl))) return set
  }
  return null
}

/**
 * COD-906: the server CHOSE no ad for this request (the new-user ad ramp,
 * docs/experiments.md) -- not a no-fill. Only `{ ads: [], withheld: true }`
 * counts; any other body is read as before.
 */
export function isWithheldAdResponse(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const body = data as { ads?: unknown; withheld?: unknown }
  return (
    body.withheld === true && Array.isArray(body.ads) && body.ads.length === 0
  )
}

/** A fetch: served ads, a withheld request, or nothing usable. */
export type AdFetchResult =
  | { ads: AdResponse[] }
  | { withheld: true }
  | null

/**
 * What one rotation tick does with its fetch. Served ads are cached and
 * shown; a withheld request clears the slot (COD-906: re-showing a cached
 * ad would undo the server's decision); a failed or empty fetch falls back
 * to the cache as before, and leaves the slot alone when the cache is empty.
 * `undefined` means "leave the slot as it is".
 */
export function rotationStep(
  ctrl: ChoiceCache,
  result: AdFetchResult,
  isExpired?: (impUrl: string) => boolean,
): { show: AdResponse[] | null | undefined; countsAsShown: boolean } {
  if (result && 'withheld' in result) return { show: null, countsAsShown: false }
  if (result) {
    addToChoiceCache(ctrl, result.ads)
    return { show: result.ads, countsAsShown: true }
  }
  const cachedSet = nextFromChoiceCache(ctrl, isExpired)
  return cachedSet
    ? { show: cachedSet, countsAsShown: true }
    : { show: undefined, countsAsShown: false }
}

/**
 * A streamed LLM answer (possibly still in flight). Other top-level
 * 'ai'-variant messages (bash echoes, system notices, mode dividers) are
 * excluded via the `ai-` id prefix.
 */
export function isAnswerMessage(m: ChatMessage): boolean {
  return (
    !m.parentId && m.variant === 'ai' && m.id.startsWith(AI_MESSAGE_ID_PREFIX)
  )
}

export function isInlineAdEligibleAnswer(m: ChatMessage): boolean {
  return isAnswerMessage(m) && m.metadata?.allowInlineAds === true
}

export function claimAdImpression(
  impressionsFired: Set<string>,
  impUrl: string,
): boolean {
  if (impressionsFired.has(impUrl)) return false
  impressionsFired.add(impUrl)
  return true
}

/**
 * Narrow testable boundary: only our own inventory uses the resilient view
 * acknowledgement transport. Third-party providers retain their legacy pixel
 * acknowledgement path below.
 */
export function dispatchFirstPartyViewAcknowledgement(
  provider: AdProvider | undefined,
  request: Omit<FirstPartyViewAckRequest, 'onAttempt'>,
  onAttempt: NonNullable<FirstPartyViewAckRequest['onAttempt']>,
  acknowledge: typeof acknowledgeFirstPartyView = acknowledgeFirstPartyView,
): boolean {
  if (provider !== 'first_party') return false
  void acknowledge({ ...request, onAttempt })
  return true
}

/**
 * Send a click report once this ad's view ack has settled, or after
 * `FIRST_PARTY_VIEW_BEFORE_CLICK_WAIT_MS`. Only first-party views are tracked
 * in flight; any other ad, or one whose view already landed, sends at once.
 */
export function sendClickAfterView<T>(
  impUrl: string,
  send: () => Promise<T>,
  viewSettled: (token: string) => Promise<void> = firstPartyViewAckSettled,
): Promise<T> {
  return viewSettled(impUrl).then(send)
}

/**
 * Report a click on any CLI ad.
 *
 * Module-level rather than a closure inside the hook because the PARTNER rows
 * are not the hook's ads and still settle through the same endpoint: one
 * click path means an advertiser's click is counted the same way wherever it
 * was drawn. Never awaited by a caller — a click that waited on our own
 * telemetry before opening the link would be slower than the ad is worth.
 *
 * The report itself waits, bounded, behind this ad's view ack
 * ({@link sendClickAfterView}): callers fire the view first, open the link,
 * and the server still sees the view before the click (ad click IVT).
 */
export function recordAdClick(
  ad: Pick<AdResponse, 'impUrl'> & { url?: string },
  options?: { surface?: AdSurface; dock?: DockClickContext },
): void {
  const authToken = getAuthToken()
  if (!authToken) {
    logger.warn('[ads] No auth token, skipping ad click recording')
    return
  }

  // COD-694: watch for the user's next prompt, the CLI's "came back" signal.
  watchAdClickReturn(ad.impUrl)
  noteAdClicked()
  // COD-757: watch for the agent installing the clicked vendor's package.
  armAdAdoptionWatch(ad.impUrl, ad.url)

  // One id per logical click (COD-365); a repeat POST of the same ad is a
  // new gesture and a new id, and the server answers `alreadyRecorded`.
  const clientEventId = crypto.randomUUID()
  const dock = options?.dock
  const ack = sendClickAfterView(ad.impUrl, () =>
    timedApiCall(() =>
      fetch(`${WEBSITE_URL}/api/v1/ads/click`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
          'User-Agent': getCliAdRequestUserAgent(),
          ...clientEnvironmentHeaders(),
          [FREEBUFF_EVENT_ID_HEADER]: clientEventId,
        },
        body: JSON.stringify({
          impUrl: ad.impUrl,
          clientEventId,
          ...(options?.surface ? { surface: options.surface } : {}),
          // The dock's own fields ride the ACK (COD-457), so the canonical
          // server-side `ads.clicked` carries them and one click stays one
          // event. Emitting a second client-side click here double-counted.
          ...(dock
            ? {
                dockFrom: dock.from,
                dockDwellMs: dock.dwellMs,
                dockAccidentalClick: dock.accidental,
              }
            : {}),
        }),
      }),
    ),
  )
    .then((res) => {
      if (!res.ok) {
        logger.debug({ status: res.status }, '[ads] Failed to record ad click')
      }
    })
    .catch((err) => {
      logger.debug({ err }, '[ads] Failed to record ad click')
    })
  // The return report for this click waits for it to be recorded (COD-694).
  trackAdClickAck(ad.impUrl, ack)
}

function trackInlineAdEvent(
  event: AnalyticsEvent,
  properties: Record<string, unknown>,
): void {
  try {
    trackEvent(event, properties)
  } catch (error) {
    // Telemetry must never interfere with fetching or rendering an ad.
    logger.debug({ error, event }, '[ads] Failed to track inline ad event')
  }
}

type GravityAdOptionsBase = {
  enabled?: boolean
  /** Skip the "wait for first user message" gate. Used by the freebuff
   *  landing screen, which has no conversation but still needs ads. */
  forceStart?: boolean
  /** Ad network to request first. The server owns fallback ordering. */
  provider?: AdProvider
  /** Product surface requesting the ad. The server maps this to placements. */
  surface?: AdSurface
  /** Explicit provider placement id for the rotating `ads[0]` slot. */
  slotPlacementId?: string
  /**
   * Stop rotating `ads[0]` while something else holds its slot (the sponsor
   * dock). An ad fetched then would be served and never rendered; ads are
   * fetched only when they can be rendered. Inline ads are unaffected.
   */
  slotPaused?: boolean
  /**
   * The slot gives way to an end-of-answer card in the transcript viewport
   * (one ad on screen at a time): no ad drawn, no fetch, no impression, and
   * the rotation clock stops. When it ends the slot shows the ad it held,
   * with the rest of that ad's interval.
   */
  slotYielded?: boolean
  placementIds?: string[]
}

type GravityAdOptions = GravityAdOptionsBase &
  (
    | {
        /** Lazily fetch interspersed ads as the assistant response grows. */
        inline: true
        /** Reusable provider placement id for every lazy inline auction. */
        inlinePlacementId: string
        /**
         * The placement for the one-line link that replaces the card when
         * the policy says `link` AND `CLI_INLINE_LINK_AD_LIVE` is on
         * (`ads/inline-link-ad.ts`). Ignored while the gate is off.
         */
        inlineLinkPlacementId?: string
      }
    | {
        inline?: false
        inlinePlacementId?: never
        inlineLinkPlacementId?: never
      }
  )

/**
 * Fetches the rotating ad slot and, with `inline`, one card per answer, placed
 * after the answer's last content and auctioned once the answer has completed.
 *
 * Nothing is fetched and no impression is sent while the terminal reports
 * itself unfocused (`adFocusAllows`); a terminal that never reports focus
 * counts as focused.
 */
export const useGravityAd = (options?: GravityAdOptions): GravityAdState => {
  const enabled = options?.enabled ?? true
  const forceStart = options?.forceStart ?? false
  const provider: AdProvider = options?.provider ?? 'gravity'
  const surface = options?.surface
  const inline = options?.inline ?? false
  const inlinePlacementId = options?.inlinePlacementId
  const inlineLinkPlacementId = options?.inlineLinkPlacementId
  const slotPlacementId = options?.slotPlacementId
  // Read by the tick through a ref, so pausing needs no timer restart.
  const slotPausedRef = useRef(false)
  slotPausedRef.current = options?.slotPaused ?? false
  const slotYielded = options?.slotYielded ?? false
  const slotYieldedRef = useRef(false)
  slotYieldedRef.current = slotYielded
  const placementIds = options?.placementIds
  const [ads, setAdsState] = useState<AdResponse[] | null>(null)
  // The rotating slot's creatives as last set, so a swap can be told to the
  // engagement registry (COD-757) before React unmounts the old cards: their
  // records then end as `rotation`, not `unmount`.
  const adsRef = useRef<AdResponse[] | null>(null)
  const setAds = (
    next:
      | AdResponse[]
      | null
      | ((cur: AdResponse[] | null) => AdResponse[] | null),
  ): void => {
    const resolved = typeof next === 'function' ? next(adsRef.current) : next
    try {
      adEngagementRegistry().noteSlotSwap(
        (adsRef.current ?? []).map((ad) => ad.impUrl),
        (resolved ?? []).map((ad) => ad.impUrl),
      )
    } catch {
      // engagement must never break rotation
    }
    adsRef.current = resolved
    // The dock draws what it is set to (a yielded slot holds instead).
    for (const ad of resolved ?? []) noteAdDrawn(ad.impUrl)
    setAdsState(resolved)
  }
  const [responseAds, setResponseAds] = useState<Record<string, AdResponse[]>>(
    {},
  )
  const [isLoading, setIsLoading] = useState(false)

  const { terminalHeight } = useTerminalLayout()

  // The live facts the ad client context reads (COD-757).
  const renderer = useRenderer()
  useEffect(() => {
    if (!renderer) return
    return registerAdRenderer(() => ({
      useMouse: renderer.useMouse,
      width: renderer.width,
      height: renderer.height,
    }))
  }, [renderer])
  useEffect(
    () =>
      useChatStore.subscribe((state, prev) =>
        noteAdTurnState(state.isChainInProgress, prev.isChainInProgress),
      ),
    [],
  )
  const shouldHideAds = shouldHideGravityAds({
    enabled,
    terminalHeight,
    isFreeMode: IS_FREEBUFF,
  })

  // Use Zustand selector instead of manual subscription - only rerenders when value changes
  const hasUserMessagedStore = useChatStore((s) =>
    s.messages.some((m) => m.variant === 'user'),
  )
  // forceStart lets callers (e.g. the landing screen) opt out of the
  // "wait for the first user message" gate.
  const shouldStart = forceStart || hasUserMessagedStore
  const shouldStartRef = useRef(shouldStart)
  shouldStartRef.current = shouldStart

  // Single consolidated controller ref
  const ctrlRef = useRef<GravityController>({
    choiceCache: [],
    choiceCacheIndex: 0,
    impressionsFired: new Set(),
    adsShownSinceActivity: 0,
    tickInFlight: false,
    inlineQueue: createLazyResponseAdQueue<AdResponse>(),
    eligibleSlotCounts: new Map(),
    lastRotationAt: null,
    initialFetchPending: false,
    deferredImpressions: new Map(),
    deferredInlineRequests: new Map(),
    deferredInlinePoll: null,
    heldRotation: undefined,
    expiredIdle: false,
  })
  const responseAdsRef = useRef<Record<string, AdResponse[]>>({})
  responseAdsRef.current = responseAds
  // The cards actually drawable (our own left out beside a network dock).
  const drawableResponseAdsRef = useRef<Record<string, AdResponse[]>>({})

  // Ref for the tick function (avoids useCallback dependency issues)
  const tickRef = useRef<() => void>(() => {})
  const initialFetchRef = useRef<() => Promise<void>>(async () => {})
  const requestResponseAdsRef = useRef<
    (messageId: string, count: number, measureEnd?: MeasureRows) => void
  >(() => {})
  const restartRotationTimerRef = useRef<(firstDelayMs?: number) => void>(
    () => {},
  )

  // Ref to track whether ads should be hidden for use in async code
  const shouldHideAdsRef = useRef(shouldHideAds)
  shouldHideAdsRef.current = shouldHideAds

  // Fire impression and update credits (called when showing an ad)
  const recordImpressionOnce = (
    ad: AdResponse,
    options?: { force?: boolean },
  ): void => {
    // Don't record impressions when ads should be hidden
    if (shouldHideAdsRef.current) return

    const ctrl = ctrlRef.current
    const { impUrl } = ad
    if (ctrl.impressionsFired.has(impUrl)) return
    if (
      impressionDisposition({
        focused: getAdTerminalFocus(),
        force: options?.force,
      }) === 'defer'
    ) {
      ctrl.deferredImpressions.set(impUrl, ad)
      return
    }
    ctrl.deferredImpressions.delete(impUrl)
    if (!claimAdImpression(ctrl.impressionsFired, impUrl)) return

    const recordLocalImpression = async (): Promise<void> => {
      const authToken = getAuthToken()
      if (!authToken) {
        logger.warn('[ads] No auth token, skipping local impression recording')
        return
      }

      // Include mode in request - Freebuff should not grant credits (no balance concept).
      const agentMode = useChatStore.getState().agentMode
      // Measured HERE, at the moment the card is shown, against the receipt
      // stamp `fetchAd` put on the ad (COD-365). The first-party transport
      // sends it as a header; the third-party body carries it too.
      const renderDelayMs = renderDelaySinceReceipt(ad)

      const dispatchedFirstPartyAck = dispatchFirstPartyViewAcknowledgement(
        ad.provider,
        {
          token: impUrl,
          url: `${WEBSITE_URL}/api/v1/ads/impression`,
          init: {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authToken}`,
              'User-Agent': getCliAdRequestUserAgent(),
              ...clientEnvironmentHeaders(),
            },
            body: JSON.stringify({
              impUrl,
              mode: agentMode,
              userAgent: getAdUserAgent(),
              os: getAdDeviceInfo().os,
            }),
          },
          surface: surface ?? 'cli_chat',
          placementId: ad.placementId ?? slotPlacementId ?? 'unknown',
          clientFamily: 'cli',
          ...(renderDelayMs !== undefined ? { renderDelayMs } : {}),
        },
        (observation) => {
          const telemetry = createFirstPartyViewAckTelemetry(observation)
          if (telemetry) {
            enqueueClientLog({
              level: 'info',
              event: AnalyticsEvent.ADS_FIRST_PARTY_VIEW_ACK,
              message: 'First-party view acknowledgement',
              data: telemetry,
            })
          }
        },
      )
      if (dispatchedFirstPartyAck) {
        return
      }

      // One id per logical event (COD-365). This path has no retry, so one
      // mint per call is one per event; the header is what the server reads.
      const clientEventId = crypto.randomUUID()
      const res = await timedApiCall(() =>
        fetch(`${WEBSITE_URL}/api/v1/ads/impression`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
            'User-Agent': getCliAdRequestUserAgent(),
            ...clientEnvironmentHeaders(),
            [FREEBUFF_EVENT_ID_HEADER]: clientEventId,
          },
          body: JSON.stringify({
            impUrl,
            mode: agentMode,
            // The same shared ad user agent (getAdUserAgent) and OS this ad was
            // auctioned with, so the impression the server records for us
            // matches the auction request.
            userAgent: getAdUserAgent(),
            os: getAdDeviceInfo().os,
            clientEventId,
            ...(renderDelayMs !== undefined ? { renderDelayMs } : {}),
          }),
        }),
      )

      if (!res.ok) {
        logger.debug(
          { status: res.status },
          '[ads] Failed to record local ad impression',
        )
        return
      }

      const data = await res.json()
      if (data.creditsGranted > 0) {
        logger.info(
          { creditsGranted: data.creditsGranted },
          '[ads] Ad impression credits granted',
        )
        // Also update credits in visible ads
        setAds((cur) => {
          if (!cur) return cur
          return cur.map((a) =>
            a.impUrl === impUrl ? { ...a, credits: data.creditsGranted } : a,
          )
        })
      }
    }

    recordLocalImpression().catch((err) => {
      logger.debug({ err }, '[ads] Failed to record ad impression')
    })
  }

  // The focus listener is subscribed once; it calls the latest closure.
  const recordImpressionRef = useRef(recordImpressionOnce)
  recordImpressionRef.current = recordImpressionOnce

  const recordClick = (ad: AdResponse, dock?: DockClickContext): void => {
    // A click is proof the ad was on screen. Its view normally went out when
    // it was seen; this sends it now if it never did (deduped otherwise), so
    // the click report below has a view to wait behind.
    recordImpressionOnce(ad, { force: true })
    recordAdClick(ad, {
      ...(surface ? { surface } : {}),
      ...(dock ? { dock } : {}),
    })
  }

  type FetchAdResult = AdFetchResult

  // Fetch an ad via web API
  const fetchAd = async (params?: {
    placementId?: string
    placementIds?: string[]
    /** The other slot shows an ad-network ad: network fills only. */
    networkAdInView?: boolean
  }): Promise<FetchAdResult> => {
    // Don't fetch ads when they should be hidden
    if (shouldHideAdsRef.current) return null
    if (!getAdsEnabled()) return null

    const request = await buildAdAuctionRequest({
      provider,
      ...(surface ? { surface } : {}),
      ...(params?.placementId ? { placementId: params.placementId } : {}),
      ...(params?.placementIds?.length
        ? { placementIds: params.placementIds }
        : {}),
      allowSponsoredRoute: true,
      ...(params?.networkAdInView ? { networkAdInView: true } : {}),
    })
    if (!request) return null

    try {
      const response = await timedAdFetch(() =>
        fetch(request.url, request.init),
      )

      if (!response.ok) {
        let responseBody: unknown
        try {
          const contentType = response.headers.get('content-type') ?? ''
          responseBody = contentType.includes('application/json')
            ? await response.json()
            : await response.text()
        } catch {
          responseBody = 'Unable to parse error response'
        }
        logger.warn(
          { provider, status: response.status, response: responseBody },
          '[ads] Web API returned error',
        )
        return null
      }

      const data = await response.json()

      if (isWithheldAdResponse(data)) return { withheld: true }

      if (
        Array.isArray(data.ads) &&
        data.ads.length > 0 &&
        dropOurFillBesideNetwork(
          { provider: data.provider ?? provider },
          params?.networkAdInView === true,
        )
      ) {
        // Asked for the network only (the other slot shows a network ad)
        // and answered with ours by a server that ignores the hint: never
        // drawn, never counted, not this slot's answer.
        logger.debug(
          { placementId: params?.placementId },
          '[ads] Dropped our own fill beside an ad-network ad',
        )
        return null
      }

      if (Array.isArray(data.ads) && data.ads.length > 0) {
        // Receipt stamp for `renderDelayMs` (COD-365): the response is in
        // hand, the card is not yet on screen.
        const receivedAtMs = Date.now()
        noteAdsServed(data.ads.length, receivedAtMs)
        return {
          // Every string an ad network or advertiser wrote is drawn in the
          // terminal: strip escape sequences and controls here, once, so an
          // OSC 52 / OSC 8 / CSI in a title or body never reaches the screen.
          ads: sanitizeTerminalStrings(data.ads as AdResponse[]).map((ad) => ({
            ...ad,
            provider: data.provider ?? provider,
            receivedAtMs,
          })),
        }
      }
    } catch (err) {
      // `url` names which of the two ad routes threw. Only Bun's own network
      // errors carry the request as `path`, so without it a parse failure or
      // any other throw is unattributable to a host -- and the two routes do
      // not fail alike (2026-10-14: every connection failure in six hours was
      // against freebuff.com's `/api/ads`, none against `/api/v1/ads`).
      logger.error(
        { err, provider, url: request.url },
        '[ads] Failed to fetch ad',
      )
    }

    return null
  }

  // The slot's first fetch. Skipped while the terminal is unfocused; the
  // focus listener runs it when focus returns.
  initialFetchRef.current = async () => {
    const ctrl = ctrlRef.current
    try {
      if (slotPausedRef.current) return
      if (slotYieldedRef.current || !adFocusAllows(getAdTerminalFocus())) {
        ctrl.initialFetchPending = true
        return
      }
      ctrl.initialFetchPending = false
      ctrl.lastRotationAt = Date.now()
      const networkAdInView = dockRequestNeedsNetworkHint()
      const result = await fetchAd({
        placementId: slotPlacementId,
        placementIds,
        ...(networkAdInView ? { networkAdInView } : {}),
      })
      if (result && 'ads' in result) {
        addToChoiceCache(ctrl, result.ads)
        // The slot may have given way while the request was out: keep the
        // answer for when it comes back rather than set an ad nobody sees.
        if (deliverRotation(ctrl, result.ads, slotYieldedRef.current) === 'show')
          setAds(result.ads)
        ctrl.adsShownSinceActivity = 1
      }
    } finally {
      setIsLoading(false)
    }
  }

  // The dock's drawn ad has been shown too long. A yielded slot draws
  // nothing; its held ad is checked when the slot comes back.
  const slotAdExpired = (): boolean =>
    !slotYieldedRef.current &&
    (adsRef.current ?? []).some((ad) => isAdExpired(ad.impUrl))

  // Clear the slot for an expiry: the records end as `rotation` with
  // `endedBy: 'expired'`, and nothing is re-shown from the cache until the
  // person is active again.
  const expireSlot = (): void => {
    for (const ad of adsRef.current ?? []) noteAdExpiredEngagement(ad.impUrl)
    ctrlRef.current.expiredIdle = true
    setAds(null)
  }

  // Every AD_EXPIRY_CHECK_MS: the dock and the end-of-answer cards.
  const checkExpiry = (): void => {
    if (slotAdExpired()) expireSlot()
    const { next, expired } = dropExpiredResponseAds(
      responseAdsRef.current,
      (impUrl) => isAdExpired(impUrl),
    )
    if (expired.length === 0) return
    for (const ad of expired) {
      ctrlRef.current.deferredImpressions.delete(ad.impUrl)
      noteAdExpiredEngagement(ad.impUrl)
    }
    responseAdsRef.current = next
    setResponseAds(next)
  }
  const checkExpiryRef = useRef(checkExpiry)
  checkExpiryRef.current = checkExpiry

  // Update tick function (uses ref to avoid useCallback dependency issues)
  tickRef.current = () => {
    void (async () => {
      const ctrl = ctrlRef.current
      if (ctrl.tickInFlight) return
      ctrl.tickInFlight = true

      try {
        const now = Date.now()
        const plan = rotationTickPlan({
          adsEnabled: getAdsEnabled(),
          slotPaused: slotPausedRef.current || slotYieldedRef.current,
          focused: getAdTerminalFocus(),
          adsShownSinceActivity: ctrl.adsShownSinceActivity,
          userActive: isUserActive(ACTIVITY_THRESHOLD_MS),
          lastRotationAt: ctrl.lastRotationAt,
          now,
          currentExpired: slotAdExpired(),
          expiredIdle: ctrl.expiredIdle,
        })
        if (plan === 'expire') {
          expireSlot()
          return
        }
        if (plan === 'skip') return
        ctrl.lastRotationAt = now

        const networkAdInView = dockRequestNeedsNetworkHint()
        const result =
          plan === 'fetch'
            ? await fetchAd({
                placementId: slotPlacementId,
                placementIds,
                ...(networkAdInView ? { networkAdInView } : {}),
              })
            : null

        const step = rotationStep(ctrl, result, (impUrl) =>
          isAdExpired(impUrl),
        )
        if (step.countsAsShown) ctrl.adsShownSinceActivity += 1
        // Given way since the request left: held, shown when the slot is back.
        if (deliverRotation(ctrl, step.show, slotYieldedRef.current) === 'show')
          setAds(step.show ?? null)
      } finally {
        ctrl.tickInFlight = false
      }
    })()
  }

  // Retry a held end-of-answer card request: only the latest answer's, and
  // only while it is still the latest (a new prompt drops it, see below).
  // requestResponseAds re-checks focus and visibility and holds it again if
  // either still blocks.
  const retryDeferredInline = (): void => {
    const ctrl = ctrlRef.current
    if (ctrl.deferredInlineRequests.size === 0) return
    const pending = new Map(ctrl.deferredInlineRequests)
    ctrl.deferredInlineRequests.clear()
    const answers = useChatStore.getState().messages.filter(isAnswerMessage)
    const latest = answers[answers.length - 1]?.id
    if (latest && pending.has(latest)) {
      requestResponseAdsRef.current(
        latest,
        RESPONSE_AD_END_SLOT_COUNT,
        pending.get(latest),
      )
    }
  }
  const retryDeferredInlineRef = useRef(retryDeferredInline)
  retryDeferredInlineRef.current = retryDeferredInline

  // While a card request is held, re-check it on a poll, so scrolling the
  // answer's end into view releases it.
  const stopDeferredInlinePoll = (): void => {
    const ctrl = ctrlRef.current
    if (ctrl.deferredInlinePoll) clearInterval(ctrl.deferredInlinePoll)
    ctrl.deferredInlinePoll = null
  }
  const ensureDeferredInlinePoll = (): void => {
    const ctrl = ctrlRef.current
    if (ctrl.deferredInlinePoll) return
    ctrl.deferredInlinePoll = setInterval(() => {
      try {
        retryDeferredInlineRef.current()
      } catch (err) {
        logger.debug({ err }, '[ads] Deferred card retry failed')
      }
      if (ctrlRef.current.deferredInlineRequests.size === 0) {
        stopDeferredInlinePoll()
      }
    }, TRANSCRIPT_VISIBILITY_POLL_MS)
    ;(ctrl.deferredInlinePoll as { unref?: () => void }).unref?.()
  }

  // A new prompt drops a held card request: the user has moved on.
  useEffect(() => {
    const stop = subscribeAdUserSend(() => {
      ctrlRef.current.deferredInlineRequests.clear()
      stopDeferredInlinePoll()
    })
    return () => {
      stop()
      stopDeferredInlinePoll()
    }
  }, [])

  // Focus returning (a focus-in report, or a key or submit after a focus-out report).
  useEffect(() => {
    ensureAdTerminalFocusWatch()
    return subscribeAdTerminalFocus((focused) => {
      if (!focused) return
      const ctrl = ctrlRef.current
      try {
        handleAdFocusReturn(ctrl, {
          now: Date.now(),
          drawnImpUrls: drawnAdImpUrls({
            dockAds: adsRef.current,
            dockYielded: slotYieldedRef.current,
            responseAds: drawableResponseAdsRef.current,
          }),
          slotActive:
            shouldStartRef.current &&
            !shouldHideAdsRef.current &&
            !slotYieldedRef.current,
          recordImpression: (ad) => recordImpressionRef.current(ad),
          runInitialFetch: () => void initialFetchRef.current(),
          rotate: () => tickRef.current(),
          restartRotationTimer: () => restartRotationTimerRef.current(),
          retryDeferredInline: () => retryDeferredInlineRef.current(),
        })
      } catch (err) {
        logger.debug({ err }, '[ads] Focus-return handling failed')
      }
    })
  }, [])

  // Reset ads shown counter on user activity
  useEffect(() => {
    if (!getAdsEnabled()) return
    return subscribeToActivity(() => {
      ctrlRef.current.adsShownSinceActivity = 0
      ctrlRef.current.expiredIdle = false
    })
  }, [])

  // The slot giving way to an end-of-answer card and coming back
  // (`applySlotYield`). The held ad's engagement record stays open (not
  // flushed as an unmount) and counts its hidden time.
  const yieldRef = useRef<SlotYieldHold | null>(null)
  useEffect(() => {
    const registry = (): ReturnType<typeof adEngagementRegistry> | null => {
      try {
        return adEngagementRegistry()
      } catch {
        return null
      }
    }
    yieldRef.current = applySlotYield(yieldRef.current, {
      yielded: slotYielded,
      now: Date.now(),
      drawnImpUrls: (adsRef.current ?? []).map((ad) => ad.impUrl),
      slotActive: shouldStartRef.current && !shouldHideAdsRef.current,
      focused: getAdTerminalFocus(),
      ctrl: ctrlRef.current,
      hold: (impUrl) => registry()?.hold(impUrl, 'inline_card_in_view'),
      release: (impUrl) => registry()?.release(impUrl),
      show: (next) => setAds(next),
      runInitialFetch: () => void initialFetchRef.current(),
      restartRotationTimer: (firstDelayMs) =>
        restartRotationTimerRef.current(firstDelayMs),
      heldExpired:
        !slotYielded &&
        (adsRef.current ?? []).some((ad) => isAdExpired(ad.impUrl)),
      expire: () => expireSlot(),
    })
  }, [slotYielded])

  // Start rotation when user sends first message (or immediately if forced).
  useEffect(() => {
    if (!shouldStart || !getAdsEnabled() || shouldHideAds) return

    setIsLoading(true)

    // Fetch first ad immediately, unless the dock already holds the slot.
    void initialFetchRef.current()

    // Start interval for rotation (consistent 60s intervals). A rotation
    // run on focus return restarts it, so the next tick is a full interval
    // after that rotation.
    let id = setInterval(() => tickRef.current(), AD_ROTATION_INTERVAL_MS)
    let first: ReturnType<typeof setTimeout> | null = null
    // With `firstDelayMs`, the next tick comes after that delay (the rest of
    // an interval interrupted by the slot giving way), then every interval.
    restartRotationTimerRef.current = (firstDelayMs?: number) => {
      clearInterval(id)
      if (first) clearTimeout(first)
      first = null
      if (firstDelayMs === undefined) {
        id = setInterval(() => tickRef.current(), AD_ROTATION_INTERVAL_MS)
        return
      }
      first = setTimeout(() => {
        first = null
        tickRef.current()
        id = setInterval(() => tickRef.current(), AD_ROTATION_INTERVAL_MS)
      }, firstDelayMs)
    }

    // Expiry is checked more often than the slot rotates, and also covers
    // the end-of-answer cards.
    const expiryCheck = setInterval(
      () => checkExpiryRef.current(),
      AD_EXPIRY_CHECK_MS,
    )

    return () => {
      clearInterval(id)
      clearInterval(expiryCheck)
      if (first) clearTimeout(first)
      restartRotationTimerRef.current = () => {}
    }
  }, [shouldStart, shouldHideAds, provider, surface, placementIds?.join(',')])

  // Called by BlocksRenderer once an answer has completed, for its single
  // end-of-answer card. One auction per answer at most: the queue counts the
  // attempt, so a no-fill is not retried and a re-render asks for nothing new.
  // Held (and retried) while the terminal is unfocused or the answer's end is
  // off screen, so a card is not fetched where it will not be seen.
  const requestResponseAds = (
    messageId: string,
    rawCount: number,
    measureEnd?: MeasureRows,
  ): void => {
    const count = Math.min(rawCount, RESPONSE_AD_END_SLOT_COUNT)
    if (
      !inline ||
      !inlinePlacementId ||
      count <= 0 ||
      shouldHideAdsRef.current ||
      !getAdsEnabled()
    ) {
      return
    }

    const messages = useChatStore.getState().messages
    const answer = messages.find((m) => m.id === messageId)
    if (!answer || !isInlineAdEligibleAnswer(answer)) {
      return
    }

    const ctrl = ctrlRef.current
    if (
      inlineRequestDisposition({
        count,
        focused: getAdTerminalFocus(),
        endVisible: answerEndVisible(measureEnd),
        offerInDock: slotPausedRef.current,
      }) === 'defer'
    ) {
      ctrl.deferredInlineRequests.set(messageId, measureEnd)
      ensureDeferredInlinePoll()
      return
    }
    ctrl.deferredInlineRequests.delete(messageId)
    // Card or link, decided once per auction. With the CLI gate off this is
    // always the card placement, so the request is exactly the card's.
    const plan = inlineAdRequestPlan({
      cardPlacementId: inlinePlacementId,
      linkPlacementId: inlineLinkPlacementId,
      policyStyle: getSessionInlineAdStyle(),
    })
    const previousEligibleCount = ctrl.eligibleSlotCounts.get(messageId) ?? 0
    if (count > previousEligibleCount) {
      ctrl.eligibleSlotCounts.set(messageId, count)
      const telemetryProperties = {
        response_id: messageId,
        chat_session_id: useChatStore.getState().chatSessionId,
        eligible_slot_count: count,
        pool_size: RESPONSE_AD_END_SLOT_COUNT,
        provider,
        surface,
        placement_id: plan.placementId,
        is_freebuff: IS_FREEBUFF,
      }
      trackInlineAdEvent(
        AnalyticsEvent.CLI_INLINE_AD_SLOT_ELIGIBLE,
        telemetryProperties,
      )
    }

    void requestLazyResponseAds({
      queue: ctrl.inlineQueue,
      messageId,
      count,
      fetchOne: async () => {
        // The dock holds an ad-network ad: a card of ours would not be drawn
        // beside it, so ask for the network only (dropped if ours comes back).
        const networkAdInView = cardRequestNeedsNetworkHint()
        const result = await fetchAd({
          placementId: plan.placementId,
          ...(networkAdInView ? { networkAdInView } : {}),
        })
        const ad = result && 'ads' in result ? (result.ads[0] ?? null) : null
        if (!ad || plan.style !== 'link') return ad
        // Drawn as the link, and its view acknowledged under the link's id.
        return {
          ...ad,
          placementId: ad.placementId ?? plan.placementId,
          inlineStyle: 'link' as const,
        }
      },
      onAd: (ad) => {
        // Only the newest answer's card is drawn: one card on screen at a
        // time, however the transcript is scrolled.
        const answerOrder = useChatStore
          .getState()
          .messages.filter(isAnswerMessage)
          .map((m) => m.id)
        const { next, superseded, dropped } = keepNewestResponseAd(
          responseAdsRef.current,
          messageId,
          ad,
          answerOrder,
        )
        // A late card for an older answer, or for one no longer in the
        // transcript: nothing drawn changes.
        if (dropped) return
        for (const old of superseded) {
          ctrl.deferredImpressions.delete(old.impUrl)
          try {
            adEngagementRegistry().noteYield(old.impUrl, 'newer_inline_card')
          } catch {
            // engagement must never break the card
          }
        }
        responseAdsRef.current = next
        setResponseAds(next)
      },
    })
  }

  requestResponseAdsRef.current = requestResponseAds

  // Don't return ads when ads should be hidden
  const visible = shouldStart && !shouldHideAds
  // Coming back with an answer held while blank: drawn from this render, so
  // the old ad never flashes before the swap the yield effect commits.
  const heldRotation = ctrlRef.current.heldRotation
  const slotAds =
    !slotYielded && yieldRef.current && heldRotation !== undefined
      ? heldRotation
      : ads
  // Rule 1: an ad-network ad held by the dock means our own cards are not
  // drawn (a sponsored offer in the dock holds no ad).
  const dockHeldAd = slotPausedRef.current ? null : (slotAds?.[0] ?? null)
  const drawableResponseAds = useMemo(
    () => suppressOurCards(responseAds, dockHeldAd),
    [responseAds, dockHeldAd?.provider, dockHeldAd?.impUrl],
  )
  drawableResponseAdsRef.current = drawableResponseAds
  return {
    // Still returned while the slot gives way: the caller keeps the slot's
    // rows (blank) so the layout does not move, and draws it again after.
    ads: visible ? slotAds : null,
    responseAds: visibleResponseAds(visible, drawableResponseAds),
    requestResponseAds,
    isLoading,
    recordClick,
    recordImpression: recordImpressionOnce,
  }
}
