/**
 * SERVED display ads in the CLI (`CLI-Splash`, `CLI-Statusline`, `CLI-Deals`):
 * the fetch, the hold, and the billed impression and click.
 *
 * Rendering rule, per placement (the components apply it):
 *
 * 1. The local preview flag (`cliDisplayAdEnabled`) is on: draw the MOCK
 *    sponsor with analytics-only events. Nothing here runs.
 * 2. Else, the policy announced this id in `displayPlacementIds`: ask for one
 *    served ad ({@link getDisplayAd}) and draw it through the same component,
 *    billed. No fill draws nothing.
 * 3. Else draw nothing and request nothing.
 *
 * Modelled on `partner-ads.ts`: the same policy check before any request, the
 * same {@link DISPLAY_AD_TTL_MS} hold of a fill or a no-fill, the same
 * first-party-only refusal. Billing reuses the partner helpers, which are the
 * CLI's generic first-party ones: the impression is acknowledged on insertion
 * (a terminal has no viewport), once per `impUrl` across remounts; a click
 * acknowledges the view first, then reports through `recordAdClick`.
 *
 * Hiding a served unit (× / "hide for today" / `/deals off`) stays local: no
 * served-ad dismiss path exists for these placements, and none is invented.
 */
import {
  isServedSponsor,
  parseServedDisplayAd,
  servedDisplayAdToSponsor,
  type DisplaySponsor,
  type ServedPlacedSponsor,
} from '@codebuff/common/ads/display-ads/served'
import { isDisplayAdPlacementId } from '@codebuff/common/ads/display-ads/serving'
import { sanitizeTerminalStrings } from '@codebuff/common/util/terminal-safe-text'
import { useEffect, useState } from 'react'

import { isAdExpired, noteAdDrawn, useAdExpired } from './ad-expiry-clock'
import { buildAdAuctionRequest } from './ad-request'
import { timedAdFetch } from './ad-signals'
import { recordPartnerClick, recordPartnerImpression } from './partner-ads'
import { getAdsEnabled } from '../commands/ads'
import {
  getSessionDisplayPlacementIds,
  resolveAdPolicy,
} from '../hooks/use-dock-panel'
import { subscribeToActivity } from '../utils/activity-tracker'
import { getAuthToken } from '../utils/auth'
import { logger } from '../utils/logger'

import type { AdResponse } from '../hooks/use-gravity-ad'

/** A served sponsor as the CLI holds it: what billing needs beyond the draw. */
export interface CliServedSponsor extends ServedPlacedSponsor {
  /** The landing page (the click-adoption watch reads it). */
  landingUrl: string
  /** Receipt stamp for `renderDelayMs` on the impression ack. */
  receivedAtMs: number
}

/** What a CLI display unit draws: a mock sponsor or a served one. */
export type CliDisplaySponsor =
  | Exclude<DisplaySponsor, ServedPlacedSponsor>
  | CliServedSponsor

export function isCliServedSponsor(
  sponsor: CliDisplaySponsor,
): sponsor is CliServedSponsor {
  return isServedSponsor(sponsor)
}

/** One served answer is held this long, a no-fill as firmly as a fill. */
export const DISPLAY_AD_TTL_MS = 30 * 60_000

type AuctionBody = { ads?: unknown[]; provider?: unknown }

export interface DisplayAdDeps {
  adsEnabled: () => boolean
  authToken: () => string | null
  /** The display ids the policy announced, or `[]`. */
  announcedPlacements: () => Promise<readonly string[]>
  /** One auction, already routed and authorized. `null` on any failure. */
  fetchAuction: (placementId: string) => Promise<AuctionBody | null>
  now: () => number
}

const held = new Map<
  string,
  { sponsor: CliServedSponsor | null; expiresAt: number }
>()
const inFlight = new Map<string, Promise<CliServedSponsor | null>>()
let cacheToken: string | null = null

/**
 * The served ads actually drawn this session (impression recorded on
 * insertion), by `impUrl`. `/deals use N` may only click one of these: a click
 * acknowledges the view first, so clicking an undrawn card would bill an
 * impression nobody saw.
 */
const drawn = new Set<string>()

export function wasServedDisplayAdDrawn(sponsor: CliServedSponsor): boolean {
  return drawn.has(sponsor.served.impUrl)
}

export function resetServedDisplayAds(): void {
  held.clear()
  inFlight.clear()
  drawn.clear()
  cacheToken = null
}

/** A held answer is one account's: drop it when the account changes. */
function syncCacheOwner(authToken: string): void {
  if (cacheToken !== null && cacheToken !== authToken) {
    held.clear()
    inFlight.clear()
    drawn.clear()
  }
  cacheToken = authToken
}

/** The display ids this session may request, resolving the policy if needed. */
export async function announcedDisplayPlacements(): Promise<readonly string[]> {
  const cached = getSessionDisplayPlacementIds()
  if (cached) return cached
  await resolveAdPolicy()
  return getSessionDisplayPlacementIds() ?? []
}

/** What a display-ad auction asks for. Exported so a test can check it. */
export function displayAuctionParams(
  placementId: string,
): Parameters<typeof buildAdAuctionRequest>[0] {
  return { surface: 'cli_chat', placementId, allowSponsoredRoute: false }
}

async function requestDisplayAuction(
  placementId: string,
): Promise<AuctionBody | null> {
  const built = await buildAdAuctionRequest(displayAuctionParams(placementId))
  if (!built) return null
  const response = await timedAdFetch(() => fetch(built.url, built.init))
  if (!response.ok) {
    logger.debug(
      { status: response.status, placementId },
      '[ads] Display placement request failed',
    )
    return null
  }
  return (await response.json()) as AuctionBody
}

const productionDeps: DisplayAdDeps = {
  adsEnabled: getAdsEnabled,
  authToken: () => getAuthToken() ?? null,
  announcedPlacements: announcedDisplayPlacements,
  fetchAuction: requestDisplayAuction,
  now: Date.now,
}

/**
 * One display placement's served ad, or null: ads off, signed out, the policy
 * did not announce the id (no request is made), no fill, or a fill that does
 * not parse as a first-party display ad for this id.
 */
export async function getDisplayAd(
  placementId: string,
  deps: DisplayAdDeps = productionDeps,
): Promise<CliServedSponsor | null> {
  if (!isDisplayAdPlacementId(placementId)) return null
  if (!deps.adsEnabled()) return null
  const authToken = deps.authToken()
  if (!authToken) return null
  syncCacheOwner(authToken)

  const answer = held.get(placementId)
  // A held fill that has been on screen too long is not served again: the
  // slot asks for a new one (`ad-expiry-clock.ts`).
  if (
    answer &&
    deps.now() < answer.expiresAt &&
    !(answer.sponsor && isAdExpired(answer.sponsor.served.impUrl))
  )
    return answer.sponsor
  const pending = inFlight.get(placementId)
  if (pending) return pending

  const request = (async (): Promise<CliServedSponsor | null> => {
    const announced = await deps.announcedPlacements()
    if (!announced.includes(placementId)) return null
    const data = await deps.fetchAuction(placementId)
    const raw = data?.ads?.[0]
    if (!raw) return null
    // Advertiser-written text is drawn in the terminal: no escape sequences.
    const ad = parseServedDisplayAd(sanitizeTerminalStrings(raw), placementId, {
      provider: data?.provider,
    })
    if (!ad) return null
    return {
      ...servedDisplayAdToSponsor(ad),
      landingUrl: ad.url,
      receivedAtMs: deps.now(),
    }
  })()
    .catch((err) => {
      logger.debug({ err, placementId }, '[ads] Failed to fetch display ad')
      return null
    })
    .then((sponsor) => {
      inFlight.delete(placementId)
      held.set(placementId, {
        sponsor,
        expiresAt: deps.now() + DISPLAY_AD_TTL_MS,
      })
      return sponsor
    })

  inFlight.set(placementId, request)
  return request
}

/** The served sponsor in the shape the CLI's billed helpers take. */
export function servedSponsorAdResponse(sponsor: CliServedSponsor): AdResponse {
  return {
    impUrl: sponsor.served.impUrl,
    clickUrl: sponsor.served.clickUrl,
    url: sponsor.landingUrl,
    provider: sponsor.served.provider,
    placementId: sponsor.served.placementId,
    receivedAtMs: sponsor.receivedAtMs,
    title: sponsor.copy.headline,
    adText: sponsor.copy.body,
    cta: sponsor.copy.cta,
    favicon: sponsor.logoUrl ?? '',
  }
}

export interface ServedDisplayAdBilling {
  impression: (sponsor: CliServedSponsor) => void
  click: (sponsor: CliServedSponsor) => void
}

const defaultBilling: ServedDisplayAdBilling = {
  impression: (sponsor) =>
    recordPartnerImpression(servedSponsorAdResponse(sponsor)),
  click: (sponsor) => recordPartnerClick(servedSponsorAdResponse(sponsor)),
}
let billing: ServedDisplayAdBilling = defaultBilling

/** Test seam: capture billed calls; no argument restores the default. */
export function setServedDisplayAdBillingForTests(
  next?: ServedDisplayAdBilling,
): void {
  billing = next ?? defaultBilling
}

/** Billed impression, on insertion. The helper dedupes by `impUrl`. */
export function recordServedDisplayImpression(sponsor: CliServedSponsor): void {
  drawn.add(sponsor.served.impUrl)
  noteAdDrawn(sponsor.served.impUrl)
  billing.impression(sponsor)
}

/** Billed click (view first), then the caller opens `sponsor.url` (clickUrl). */
export function recordServedDisplayClick(sponsor: CliServedSponsor): void {
  billing.click(sponsor)
}

export type GetDisplayAd = (
  placementId: string,
) => Promise<CliServedSponsor | null>

/**
 * The served sponsor for one placement while `active`, else null. Requests
 * nothing while inactive (the mock flag is on, or the unit is hidden).
 *
 * A drawn sponsor that expires (`ad-expiry-clock.ts`) is taken off; the unit
 * asks again on the person's next input, for a new fill.
 */
export function useServedDisplayAd(
  placementId: string,
  active: boolean,
  get: GetDisplayAd = getDisplayAd,
): CliServedSponsor | null {
  const [sponsor, setSponsor] = useState<CliServedSponsor | null>(null)
  const [round, setRound] = useState(0)
  const expired = useAdExpired(sponsor?.served.impUrl)
  useEffect(() => {
    if (!active) return
    let live = true
    void get(placementId).then((next) => {
      if (live) setSponsor(next)
    })
    return () => {
      live = false
    }
  }, [placementId, active, get, round])
  useEffect(() => {
    if (!active || !expired) return
    return subscribeToActivity(() => setRound((r) => r + 1))
  }, [active, expired])
  return active && !expired ? sponsor : null
}

/** The billed impression for a drawn served unit, on insertion. */
export function useServedDisplayImpression(
  sponsor: CliServedSponsor | null,
): void {
  const impUrl = sponsor?.served.impUrl
  useEffect(() => {
    if (sponsor) recordServedDisplayImpression(sponsor)
    // One call per impression token; the helper dedupes across remounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impUrl])
}
