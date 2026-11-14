/**
 * THE SERVED-CREATIVE CONTRACT for the display-ad placements, and the mapper
 * that lets every placement component draw a served ad or a mock sponsor
 * through one shape.
 *
 * A display-ad fill is an ordinary served ad: the same JSON both rails return
 * for every placement (`ads[0]` of `POST /api/v1/ads` or `POST /api/ads`), so
 * nothing new is minted for it. {@link ServedDisplayAd} names the fields these
 * units read, and {@link parseServedDisplayAd} refuses a fill that cannot be
 * drawn or billed. The fields:
 *
 * - `impUrl`: the ad's identity AND its billed impression token. Every
 *   impression and click call names the ad by it.
 * - `clickUrl`: the tracked link to open (`url` only when absent).
 * - `url`: the landing page; its host is the shown domain.
 * - `title` / `adText` / `cta`: headline, body and CTA label.
 * - `favicon`: the advertiser's logo URL (`''` when it uploaded none).
 * - `brandColor` / `brandInk`: `ad_placement_creative.brand_color` /
 *   `brand_ink`, the fill and the text drawn on it (`#rrggbb`). Optional:
 *   an absent ink is derived, an absent fill takes the caller's fallback.
 * - `sponsorName`: the advertiser's company name, sent on branded fills only.
 * - `placementId` / `provider`: always the requested id and `first_party`.
 *
 * Nothing here bills. The billed calls are the ones every served unit makes
 * (impression ack after the surface's viewability rule, click report with
 * `impUrl`); `display_ads.*` analytics (`telemetry.ts`) stay mock-only.
 */
import { isValidBrandHex } from '../inline-ad-layout'
import { DISPLAY_AD_PLACEMENT_IDS } from './placements'
import { isDisplayAdPlacementId } from './serving'
import { resolveSponsorTheme } from './sponsor-theme'

import type { DisplayAdPlacementId, DisplayAdSlot } from './placements'
import type { SponsorColors } from './sponsor-theme'
import type { PlacedSponsor } from './sponsors'

/** One served display-ad fill, as a client receives it. */
export interface ServedDisplayAd {
  placementId: DisplayAdPlacementId
  provider: 'first_party'
  impUrl: string
  clickUrl: string
  url: string
  title: string
  adText: string
  cta: string
  favicon: string
  brandColor?: string
  brandInk?: string
  sponsorName?: string
}

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? value.trim().slice(0, max) : null

function httpUrl(value: unknown, allowRelative = false): string | null {
  if (typeof value !== 'string' || value === '') return null
  if (allowRelative && value.startsWith('/') && !value.startsWith('//'))
    return value
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null
  } catch {
    return null
  }
}

/**
 * A served fill for `placementId`, or null when it cannot be drawn or billed:
 * no `impUrl`, no title or landing URL, a foreign provider, or another
 * placement's fill. `provider` is the response's top-level provider when the
 * ad itself does not carry one. Relative URLs are accepted only with
 * `allowRelative` (the browser rail's same-origin first-party paths).
 */
export function parseServedDisplayAd(
  raw: unknown,
  placementId: DisplayAdPlacementId,
  options: { provider?: unknown; allowRelative?: boolean } = {},
): ServedDisplayAd | null {
  if (!raw || typeof raw !== 'object') return null
  const ad = raw as Record<string, unknown>
  const provider = ad.provider ?? options.provider
  if (provider !== 'first_party') return null
  if (ad.placementId !== undefined && ad.placementId !== placementId)
    return null
  const impUrl = httpUrl(ad.impUrl, options.allowRelative)
  const url = httpUrl(ad.url)
  const title = text(ad.title, 200)
  if (!impUrl || !url || !title) return null
  const clickUrl = httpUrl(ad.clickUrl, options.allowRelative) ?? url
  const sponsorName = text(ad.sponsorName, 120)
  return {
    placementId,
    provider: 'first_party',
    impUrl,
    clickUrl,
    url,
    title,
    adText: text(ad.adText, 600) ?? '',
    cta: text(ad.cta, 80) ?? '',
    favicon: httpUrl(ad.favicon, options.allowRelative) ?? '',
    ...(isValidBrandHex(ad.brandColor as string)
      ? { brandColor: ad.brandColor as string }
      : {}),
    ...(isValidBrandHex(ad.brandInk as string)
      ? { brandInk: ad.brandInk as string }
      : {}),
    ...(sponsorName ? { sponsorName } : {}),
  }
}

/** The slot a display-ad placement id draws, on whichever surface. */
export function displayAdSlotForPlacement(id: string): DisplayAdSlot | null {
  if (!isDisplayAdPlacementId(id)) return null
  for (const [slot, ids] of Object.entries(DISPLAY_AD_PLACEMENT_IDS)) {
    if ((Object.values(ids) as string[]).includes(id))
      return slot as DisplayAdSlot
  }
  return null
}

/** What the billed calls need, carried beside the drawn sponsor. */
export interface ServedDisplayAdTracking {
  placementId: DisplayAdPlacementId
  provider: 'first_party'
  impUrl: string
  clickUrl: string
}

/**
 * A served ad in the shape placements draw. Same fields as a mock
 * {@link PlacedSponsor}, except: `id` is the impression token (unique per
 * serve), `url` is the tracked click URL, the logo is a URL (`logoUrl`) rather
 * than inline path data, there is no MCP server config, and `served` carries
 * what the billed calls need.
 */
export interface ServedPlacedSponsor
  extends Omit<PlacedSponsor, 'id' | 'logo' | 'mcp'> {
  id: string
  logo?: undefined
  mcp?: undefined
  logoUrl?: string
  served: ServedDisplayAdTracking
}

/** What a display-ad component draws: a mock sponsor or a served ad. */
export type DisplaySponsor = PlacedSponsor | ServedPlacedSponsor

export function isServedSponsor(
  sponsor: DisplaySponsor,
): sponsor is ServedPlacedSponsor {
  return 'served' in sponsor && sponsor.served !== undefined
}

/** Used when a served creative states no brand fill. */
export const SERVED_DISPLAY_AD_FALLBACK_COLORS: SponsorColors = {
  fill: '#1f1f1f',
}

function shownDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Map a served fill to the drawn shape. `fallbackColors` stands in for a
 * creative with no `brandColor` (a surface may pass its own accent).
 */
export function servedDisplayAdToSponsor(
  ad: ServedDisplayAd,
  options: { fallbackColors?: SponsorColors } = {},
): ServedPlacedSponsor {
  const colors: SponsorColors = ad.brandColor
    ? { fill: ad.brandColor, ...(ad.brandInk ? { ink: ad.brandInk } : {}) }
    : (options.fallbackColors ?? SERVED_DISPLAY_AD_FALLBACK_COLORS)
  const domain = shownDomain(ad.url)
  const name = ad.sponsorName || domain
  return {
    id: ad.impUrl,
    name,
    domain,
    url: ad.clickUrl || ad.url,
    colors,
    lettermark: (name.match(/[A-Za-z0-9]/)?.[0] ?? '•').toUpperCase(),
    copy: {
      headline: ad.title,
      body: ad.adText,
      cta: ad.cta,
      tagline: ad.title,
    },
    theme: resolveSponsorTheme(colors),
    ...(ad.favicon ? { logoUrl: ad.favicon } : {}),
    served: {
      placementId: ad.placementId,
      provider: ad.provider,
      impUrl: ad.impUrl,
      clickUrl: ad.clickUrl,
    },
  }
}
