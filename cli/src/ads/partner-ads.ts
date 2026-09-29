/**
 * PARTNER PLACEMENTS in the CLI: one advertiser's own chrome in a terminal.
 *
 * Two slots, both `cli_chat`: a row above the input while the draft is about
 * pull requests, and a row under `/review` in the slash menu. Desktop draws
 * the same deal as a pill with the advertiser's logo in it; a terminal has no
 * images, so the row is their colour, their headline and the disclosure.
 *
 * WHAT THIS MODULE OWNS, and nothing else does:
 *
 * - THE POLICY CHECK. A partner slot is requested only when the session's ad
 *   policy named it. While the deal is off the policy names nothing, so no
 *   request is made to be refused.
 * - THE HOLD. One answer per placement for {@link PARTNER_AD_TTL_MS}, a
 *   no-fill held exactly as firmly as a fill.
 * - ONE IMPRESSION PER HELD ANSWER. The rows mount and unmount constantly --
 *   the slash menu opens on a keystroke -- so the acknowledged set is
 *   module-level, not per component.
 *
 * It deliberately does NOT own how the row draws. `partner-ad-line.tsx` does,
 * and the advertiser console previews it from the same layout function.
 */
import { getPartnerLineLayout } from '@codebuff/common/ads/inline-ad-layout'
import { getAdUserAgent } from '@codebuff/common/util/ad-user-agent'
import { createFirstPartyViewAckTelemetry } from '@codebuff/common/util/axiom-only-log'
import { sanitizeTerminalStrings } from '@codebuff/common/util/terminal-safe-text'
import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { WEBSITE_URL } from '@codebuff/sdk'

import { buildAdAuctionRequest } from './ad-request'
import { getAdsEnabled } from '../commands/ads'
import {
  getSessionPartnerPlacementIds,
  resetAdPolicySession,
  resolveAdPolicy,
} from '../hooks/use-dock-panel'
import {
  dispatchFirstPartyViewAcknowledgement,
  recordAdClick,
  renderDelaySinceReceipt,
} from '../hooks/use-gravity-ad'
import { useChatStore } from '../state/chat-store'
import {
  getAdDeviceInfo,
  getCliAdRequestUserAgent,
} from '../utils/ad-client-identity'
import { getAuthToken } from '../utils/auth'
import { logger } from '../utils/logger'
import { enqueueClientLog } from '../utils/log-shipper'

import type { AdResponse } from '../hooks/use-gravity-ad'

/** The placement id each CLI partner row auctions. Mirrors `PLACEMENT_SLOTS`. */
export const CLI_PARTNER_PLACEMENT_IDS = {
  composer: 'CLI-Partner-Composer-PR',
  slashReview: 'CLI-Partner-Slash-Review',
} as const

/**
 * How long one partner answer is held before the slot re-auctions.
 *
 * The same thirty minutes Desktop holds, and for the same two reasons at
 * once: the IMPRESSION RATE (at most one per slot per window, rather than one
 * per keystroke in the composer or per open of the slash menu) and the
 * STALENESS of a creative frozen at fetch time in a session that can outlive
 * a working day. A paused campaign therefore stops showing within one break,
 * and browsing your commands is not a billable event.
 */
export const PARTNER_AD_TTL_MS = 30 * 60_000

type HeldAnswer = { ad: AdResponse | null; expiresAt: number }

const held = new Map<string, HeldAnswer>()
const inFlight = new Map<string, Promise<AdResponse | null>>()
/**
 * The impressions already acknowledged, keyed by the impression token.
 *
 * MODULE-LEVEL, not a hook ref, and that is the whole point: the row unmounts
 * every time the slash menu closes or the draft stops mentioning a PR, and
 * remounts against the SAME held fill. A per-component guard would reset
 * exactly when it is needed, and the CPM meter would become a function of how
 * often somebody opens a menu.
 */
const ackedImpressions = new Set<string>()
/**
 * The credentials the three collections above belong to.
 *
 * A held fill is one account's answer and one account's impression tokens. A
 * token is minted per impression and would never be reused across accounts,
 * but a set that outlived a sign-out would still be the previous account's
 * data sitting in memory -- and the held fill could be drawn to whoever
 * signed in next inside the same half hour.
 */
let cacheToken: string | null = null

export function resetPartnerAds(): void {
  held.clear()
  inFlight.clear()
  ackedImpressions.clear()
  cacheToken = null
}

/**
 * Drop everything this process cached for a different account.
 *
 * Self-healing rather than wired into the logout path: `logoutUser` lives
 * under `utils/auth`, which this module's request builder imports, so calling
 * out to it from there would be a cycle. Comparing the token on the way in
 * catches a sign-out, a sign-in and a switch between accounts with one rule
 * and no cooperation from anybody.
 */
function syncCacheOwner(authToken: string): void {
  if (cacheToken === authToken) return
  if (cacheToken !== null) {
    resetPartnerAds()
    // The announced partner slots are per account too: they say whether the
    // deal is live for THIS session, and the next account's answer may
    // differ.
    resetAdPolicySession()
  }
  cacheToken = authToken
}

/** The auction answer, as this module reads it off the wire. */
type PartnerAuctionBody = {
  ads?: AdResponse[]
  provider?: AdResponse['provider']
}

/**
 * The seams, injected rather than mocked (`docs/testing.md`).
 *
 * The hold, the dedupe and the four refusals below are the whole behaviour of
 * this module and every one of them is a timing or an ordering rule --
 * exactly the kind that a test has to drive a clock and a request count
 * through, and exactly the kind that module mocking makes unreadable.
 */
export interface PartnerAdDeps {
  adsEnabled: () => boolean
  authToken: () => string | null
  /** The partner slots the policy named, or `[]` if it named none. */
  announcedPlacements: () => Promise<readonly string[]>
  /** One auction, already routed and authorized. `null` on any failure. */
  fetchAuction: (placementId: string) => Promise<PartnerAuctionBody | null>
  now: () => number
}

/**
 * The partner slots this session may request, fetching the policy if it has
 * not been fetched yet.
 *
 * The rows mount long before the dock's first rotation, so waiting for the
 * dock hook to resolve the policy would mean the first draft mentioning a PR
 * never sees an ad. `resolveAdPolicy` is shared and deduped, so asking here
 * costs at most the one fetch the session was going to make anyway.
 */
async function announcedPartnerPlacements(): Promise<readonly string[]> {
  const cached = getSessionPartnerPlacementIds()
  if (cached) return cached
  await resolveAdPolicy()
  return getSessionPartnerPlacementIds() ?? []
}

/** What a partner auction asks for. Exported so a test can build the real body. */
export function partnerAuctionParams(
  placementId: string,
): Parameters<typeof buildAdAuctionRequest>[0] {
  return {
    surface: 'cli_chat',
    placementId,
    // A partner id is not in the operator placement table Freebuff Web's
    // route resolves against, and a partner slot has no sponsored proposal to
    // offer regardless.
    allowSponsoredRoute: false,
  }
}

async function requestPartnerAuction(
  placementId: string,
): Promise<PartnerAuctionBody | null> {
  const built = await buildAdAuctionRequest(partnerAuctionParams(placementId))
  if (!built) return null
  const response = await fetch(built.url, built.init)
  if (!response.ok) {
    logger.debug(
      { status: response.status, placementId },
      '[ads] Partner placement request failed',
    )
    return null
  }
  return (await response.json()) as PartnerAuctionBody
}

const productionDeps: PartnerAdDeps = {
  adsEnabled: getAdsEnabled,
  authToken: () => getAuthToken() ?? null,
  announcedPlacements: announcedPartnerPlacements,
  fetchAuction: requestPartnerAuction,
  now: Date.now,
}

/**
 * One partner slot's ad, or null.
 *
 * FOUR REFUSALS, all of them the same answer to the caller -- null, draw
 * nothing -- because a partner slot has no fallback. Every other slot in the
 * CLI can fall back to another network, our own book or the house promo; this
 * one is one advertiser's chrome, and the only honest thing to put there when
 * the deal is not serving is nothing at all.
 *
 *  - ADS ARE OFF for this session (`/ads:disable`, a subscription, BYOK). The
 *    caller gates on this too; it is re-checked here because a held answer
 *    must not outlive the setting that allowed it.
 *  - THE POLICY did not name this placement. The deal is not live for this
 *    session and the server would refuse the request anyway, so asking would
 *    spend a round trip to be told so.
 *  - NO `impUrl`. An ad that cannot be acknowledged cannot be billed, and an
 *    unbillable partner impression is one we would be giving away.
 *  - NOT OUR OWN INVENTORY. The client-side echo of the serving fence
 *    (`dropForeignPartnerFills`): only the first-party CPM leg carries this
 *    deal, and a fill from anywhere else in an advertiser's colours is the
 *    one thing this format may never draw.
 */
export async function getPartnerAd(
  placementId: string,
  deps: PartnerAdDeps = productionDeps,
): Promise<AdResponse | null> {
  if (!deps.adsEnabled()) return null
  const authToken = deps.authToken()
  if (!authToken) return null
  syncCacheOwner(authToken)

  const answer = held.get(placementId)
  if (answer && deps.now() < answer.expiresAt) return answer.ad
  const pending = inFlight.get(placementId)
  if (pending) return pending

  const request = (async (): Promise<AdResponse | null> => {
    const announced = await deps.announcedPlacements()
    if (!announced.includes(placementId)) return null
    const data = await deps.fetchAuction(placementId)
    // Advertiser-written text is drawn in the terminal: no escape sequences.
    const ad = data?.ads?.[0] ? sanitizeTerminalStrings(data.ads[0]) : undefined
    if (!ad?.impUrl) return null
    const provider = data?.provider ?? ad.provider
    if (provider !== 'first_party') return null
    return {
      ...ad,
      provider,
      placementId,
      // Receipt stamp for `renderDelayMs` (COD-365): the answer is in hand,
      // the row is not yet on screen.
      receivedAtMs: deps.now(),
    }
  })()
    .catch((err) => {
      logger.debug({ err, placementId }, '[ads] Failed to fetch partner ad')
      return null
    })
    .then((ad) => {
      inFlight.delete(placementId)
      // A no-fill is held for the same window as a fill. Without that, a slot
      // the deal is paced out of would re-auction on every keystroke in the
      // composer -- the busiest slot in the app asking hardest precisely when
      // there is nothing to give it.
      held.set(placementId, { ad, expiresAt: deps.now() + PARTNER_AD_TTL_MS })
      return ad
    })

  inFlight.set(placementId, request)
  return request
}

/**
 * Acknowledge a partner impression, at most once per held answer.
 *
 * Always the first-party transport, because a partner fill is always our own
 * inventory -- {@link getPartnerAd} refuses anything else -- and that is the
 * path with the retry and the render-delay header every other Freebuff ad
 * measures itself with.
 */
export function recordPartnerImpression(ad: AdResponse): void {
  if (!ad.impUrl || ackedImpressions.has(ad.impUrl)) return
  const authToken = getAuthToken()
  if (!authToken) return
  ackedImpressions.add(ad.impUrl)

  const renderDelayMs = renderDelaySinceReceipt(ad)
  const dispatched = dispatchFirstPartyViewAcknowledgement(
    ad.provider,
    {
      token: ad.impUrl,
      url: `${WEBSITE_URL}/api/v1/ads/impression`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
          'User-Agent': getCliAdRequestUserAgent(),
        },
        body: JSON.stringify({
          impUrl: ad.impUrl,
          mode: useChatStore.getState().agentMode,
          userAgent: getAdUserAgent(),
          os: getAdDeviceInfo().os,
        }),
      },
      surface: 'cli_chat',
      placementId: ad.placementId ?? 'unknown',
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
  if (!dispatched) {
    // Unreachable while `getPartnerAd` refuses a foreign fill, and left as a
    // log rather than a second transport: a partner impression we cannot bill
    // is one to notice, not one to send another way.
    ackedImpressions.delete(ad.impUrl)
    logger.debug(
      { placementId: ad.placementId, provider: ad.provider },
      '[ads] Partner fill was not first-party; impression not acknowledged',
    )
  }
}

/** Report a click on a partner row, through the one CLI click path. */
export function recordPartnerClick(ad: AdResponse): void {
  recordAdClick(ad, { surface: 'cli_chat' })
}

/**
 * Re-exported so the row component and the console preview cannot drift: the
 * terminal draws what this returns, in the width it was given.
 */
export { getPartnerLineLayout }
