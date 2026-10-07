import { WEBSITE_URL } from '@codebuff/sdk'
import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { getAdUserAgent } from '@codebuff/common/util/ad-user-agent'
import { FREEBUFF_EVENT_ID_HEADER } from '@codebuff/common/ads/ad-event-hygiene'
import {
  acknowledgeFirstPartyView,
  type FirstPartyViewAckRequest,
} from '@codebuff/common/ads/first-party-view-ack'
import { createFirstPartyViewAckTelemetry } from '@codebuff/common/util/axiom-only-log'
import { sanitizeTerminalStrings } from '@codebuff/common/util/terminal-safe-text'
import { useRenderer } from '@opentui/react'
import { useEffect, useRef, useState } from 'react'

import { useTerminalLayout } from './use-terminal-layout'
import { buildAdAuctionRequest } from '../ads/ad-request'
import {
  noteAdClicked,
  noteAdTurnState,
  noteAdsServed,
  registerAdRenderer,
  timedAdFetch,
  timedApiCall,
} from '../ads/ad-signals'
import {
  adEngagementRegistry,
  armAdAdoptionWatch,
} from '../ads/use-ad-engagement'
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
  MAX_RESPONSE_AD_POOL_SIZE,
  requestLazyResponseAds,
} from '../utils/lazy-response-ads'

import type { ChatMessage } from '../types/chat'
import type { DockClickContext } from './use-dock-panel'

const AD_ROTATION_INTERVAL_MS = 60 * 1000 // 60 seconds per ad
const MAX_ADS_AFTER_ACTIVITY = 3 // Show up to 3 ads after last activity, then pause fetching new ads
const ACTIVITY_THRESHOLD_MS = 30_000 // 30 seconds idle threshold for fetching new ads
const MAX_AD_CACHE_SIZE = 50 // Maximum number of ads to keep in cache

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
  partnerBrand?: 'greptile'
  /**
   * Reviewed fill and ink, `#rrggbb`, for custom partner rows. Ordinary ads
   * use them only with Greptile's explicit partner designation.
   */
  brandColor?: string
  brandInk?: string
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
   * On-demand ad pools keyed by assistant message id. The renderer repeats a
   * full pool when the response has more eligible slots than distinct ads.
   */
  responseAds: Record<string, AdResponse[]>
  /** Lazily fill the response's bounded ad pool as slots become eligible. */
  requestResponseAds: (messageId: string, count: number) => void
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
}

// Pure helper: add an ad set to the cache
function addToChoiceCache(ctrl: GravityController, ads: AdResponse[]): void {
  // Deduplicate by checking if any set has the same first impUrl
  const key = ads[0]?.impUrl
  if (key && ctrl.choiceCache.some((set) => set[0]?.impUrl === key)) return
  if (ctrl.choiceCache.length >= MAX_AD_CACHE_SIZE) ctrl.choiceCache.shift()
  ctrl.choiceCache.push(ads)
}

// Pure helper: get the next cached ad set
function nextFromChoiceCache(ctrl: GravityController): AdResponse[] | null {
  if (ctrl.choiceCache.length === 0) return null
  const set = ctrl.choiceCache[ctrl.choiceCacheIndex % ctrl.choiceCache.length]!
  ctrl.choiceCacheIndex = (ctrl.choiceCacheIndex + 1) % ctrl.choiceCache.length
  return set
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
 * Report a click on any CLI ad.
 *
 * Module-level rather than a closure inside the hook because the PARTNER rows
 * are not the hook's ads and still settle through the same endpoint: one
 * click path means an advertiser's click is counted the same way wherever it
 * was drawn. Never awaited by a caller — a click that waited on our own
 * telemetry before opening the link would be slower than the ad is worth.
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
  const ack = timedApiCall(() =>
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
  placementIds?: string[]
}

type GravityAdOptions = GravityAdOptionsBase &
  (
    | {
        /** Lazily fetch interspersed ads as the assistant response grows. */
        inline: true
        /** Reusable provider placement id for every lazy inline auction. */
        inlinePlacementId: string
      }
    | {
        inline?: false
        inlinePlacementId?: never
      }
  )

/**
 * Fetches the rotating ad slot and, with `inline`, one reusable placement each
 * time another interspersed response slot becomes eligible. Short answers make
 * no unnecessary inline requests; long answers repeat a pool of four ads.
 */
export const useGravityAd = (options?: GravityAdOptions): GravityAdState => {
  const enabled = options?.enabled ?? true
  const forceStart = options?.forceStart ?? false
  const provider: AdProvider = options?.provider ?? 'gravity'
  const surface = options?.surface
  const inline = options?.inline ?? false
  const inlinePlacementId = options?.inlinePlacementId
  const slotPlacementId = options?.slotPlacementId
  // Read by the tick through a ref, so pausing needs no timer restart.
  const slotPausedRef = useRef(false)
  slotPausedRef.current = options?.slotPaused ?? false
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

  // Single consolidated controller ref
  const ctrlRef = useRef<GravityController>({
    choiceCache: [],
    choiceCacheIndex: 0,
    impressionsFired: new Set(),
    adsShownSinceActivity: 0,
    tickInFlight: false,
    inlineQueue: createLazyResponseAdQueue<AdResponse>(),
    eligibleSlotCounts: new Map(),
  })

  // Ref for the tick function (avoids useCallback dependency issues)
  const tickRef = useRef<() => void>(() => {})

  // Ref to track whether ads should be hidden for use in async code
  const shouldHideAdsRef = useRef(shouldHideAds)
  shouldHideAdsRef.current = shouldHideAds

  // Fire impression and update credits (called when showing an ad)
  const recordImpressionOnce = (ad: AdResponse): void => {
    // Don't record impressions when ads should be hidden
    if (shouldHideAdsRef.current) return

    const ctrl = ctrlRef.current
    const { impUrl } = ad
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

  const recordClick = (ad: AdResponse, dock?: DockClickContext): void => {
    recordAdClick(ad, {
      ...(surface ? { surface } : {}),
      ...(dock ? { dock } : {}),
    })
  }

  type FetchAdResult = { ads: AdResponse[] } | null

  // Fetch an ad via web API
  const fetchAd = async (params?: {
    placementId?: string
    placementIds?: string[]
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
      logger.error({ err, provider }, '[ads] Failed to fetch ad')
    }

    return null
  }

  // Update tick function (uses ref to avoid useCallback dependency issues)
  tickRef.current = () => {
    void (async () => {
      const ctrl = ctrlRef.current
      if (ctrl.tickInFlight) return
      ctrl.tickInFlight = true

      try {
        if (!getAdsEnabled() || slotPausedRef.current) return

        // Derive "can fetch new ads" from counter and activity (no separate paused ref needed)
        const canFetchNew =
          ctrl.adsShownSinceActivity < MAX_ADS_AFTER_ACTIVITY &&
          isUserActive(ACTIVITY_THRESHOLD_MS)

        const result = canFetchNew
          ? await fetchAd({ placementId: slotPlacementId, placementIds })
          : null

        if (result) {
          addToChoiceCache(ctrl, result.ads)
          ctrl.adsShownSinceActivity += 1
          setAds(result.ads)
        } else {
          // Fall back to cached ads
          const cachedSet = nextFromChoiceCache(ctrl)
          if (cachedSet) {
            ctrl.adsShownSinceActivity += 1
            setAds(cachedSet)
          }
        }
      } finally {
        ctrl.tickInFlight = false
      }
    })()
  }

  // Reset ads shown counter on user activity
  useEffect(() => {
    if (!getAdsEnabled()) return
    return subscribeToActivity(() => {
      ctrlRef.current.adsShownSinceActivity = 0
    })
  }, [])

  // Start rotation when user sends first message (or immediately if forced).
  useEffect(() => {
    if (!shouldStart || !getAdsEnabled() || shouldHideAds) return

    setIsLoading(true)

    // Fetch first ad immediately, unless the dock already holds the slot.
    void (async () => {
      if (slotPausedRef.current) {
        setIsLoading(false)
        return
      }
      const result = await fetchAd({
        placementId: slotPlacementId,
        placementIds,
      })
      if (result) {
        const ctrl = ctrlRef.current
        addToChoiceCache(ctrl, result.ads)
        setAds(result.ads)
        ctrl.adsShownSinceActivity = 1
      }
      setIsLoading(false)
    })()

    // Start interval for rotation (consistent 60s intervals)
    const id = setInterval(() => tickRef.current(), AD_ROTATION_INTERVAL_MS)

    return () => {
      clearInterval(id)
    }
  }, [shouldStart, shouldHideAds, provider, surface, placementIds?.join(',')])

  // Called by BlocksRenderer only when its streamed node count makes another
  // between-node slot eligible, until the four-ad pool is full. Requests use
  // the same placement id and are serialized per answer so higher-value early
  // results retain their order. The renderer cycles that exact pool for later
  // slots without additional auctions or impression events.
  const requestResponseAds = (messageId: string, count: number): void => {
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
    const previousEligibleCount = ctrl.eligibleSlotCounts.get(messageId) ?? 0
    if (count > previousEligibleCount) {
      ctrl.eligibleSlotCounts.set(messageId, count)
      const telemetryProperties = {
        response_id: messageId,
        chat_session_id: useChatStore.getState().chatSessionId,
        eligible_slot_count: count,
        pool_size: MAX_RESPONSE_AD_POOL_SIZE,
        provider,
        surface,
        placement_id: inlinePlacementId,
        is_freebuff: IS_FREEBUFF,
      }
      trackInlineAdEvent(
        AnalyticsEvent.CLI_INLINE_AD_SLOT_ELIGIBLE,
        telemetryProperties,
      )

      if (
        count > MAX_RESPONSE_AD_POOL_SIZE &&
        previousEligibleCount <= MAX_RESPONSE_AD_POOL_SIZE
      ) {
        enqueueClientLog({
          level: 'info',
          event: 'cli.inline_ad_pool_reused',
          message: 'CLI inline-ad pool reused',
          client_session_id: telemetryProperties.chat_session_id,
          data: telemetryProperties,
        })
      }
    }

    void requestLazyResponseAds({
      queue: ctrl.inlineQueue,
      messageId,
      count,
      fetchOne: async () => {
        const result = await fetchAd({ placementId: inlinePlacementId })
        return result?.ads[0] ?? null
      },
      onAd: (ad) => {
        setResponseAds((prev) => ({
          ...prev,
          [messageId]: [...(prev[messageId] ?? []), ad],
        }))
      },
    })
  }

  // Don't return ads when ads should be hidden
  const visible = shouldStart && !shouldHideAds
  return {
    ads: visible ? ads : null,
    responseAds: visibleResponseAds(visible, responseAds),
    requestResponseAds,
    isLoading,
    recordClick,
    recordImpression: recordImpressionOnce,
  }
}
