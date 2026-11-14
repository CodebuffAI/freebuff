import { META_ADS_PERMISSION_COOKIE } from './meta-ads'
import { META_TRACKING_PERMISSION_COOKIE } from './meta-conversions'
import { PAID_SOCIAL_PERMISSION_COOKIE } from './paid-social-conversions'
import { X_ADVERTISER_PERMISSION_COOKIE } from './x-advertiser'

/** First-party eligibility marker, not a record of explicit consent. */
export const GOOGLE_ADS_PERMISSION_COOKIE = 'freebuff_google_ads_allowed'
export const GOOGLE_ADS_CLICK_COOKIE = 'freebuff_google_ads_click'
export const GOOGLE_ADS_CLICK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000
export const GOOGLE_ADS_CLICK_KEYS = ['gclid', 'gbraid', 'wbraid'] as const

export type GoogleAdsAttribution = {
  gclid?: string
  gbraid?: string
  wbraid?: string
  capturedAt: number
}

export function validGoogleAdsClickId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,512}$/.test(value)
    ? value
    : undefined
}

/** One identifier only, in Google's priority order; no URL or user data. */
export function normalizeGoogleAdsAttribution(
  value: unknown,
  now = Date.now(),
): GoogleAdsAttribution | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  const capturedAt = input.capturedAt
  if (
    typeof capturedAt !== 'number' ||
    !Number.isFinite(capturedAt) ||
    !Number.isFinite(now) ||
    capturedAt > now ||
    now - capturedAt >= GOOGLE_ADS_CLICK_WINDOW_MS
  )
    return
  for (const key of GOOGLE_ADS_CLICK_KEYS) {
    if (input[key] !== undefined && !validGoogleAdsClickId(input[key])) return
  }
  for (const key of GOOGLE_ADS_CLICK_KEYS) {
    const id = validGoogleAdsClickId(input[key])
    if (id) return { [key]: id, capturedAt }
  }
  return undefined
}

export function parseGoogleAdsClickCookie(
  value: string | undefined,
  now = Date.now(),
): GoogleAdsAttribution | undefined {
  if (!value || value.length > 4096) return
  try {
    return normalizeGoogleAdsAttribution(
      JSON.parse(decodeURIComponent(value)),
      now,
    )
  } catch {
    return undefined
  }
}

const DECLINABLE_PERMISSION_COOKIES = [
  GOOGLE_ADS_PERMISSION_COOKIE,
  META_TRACKING_PERMISSION_COOKIE,
  META_ADS_PERMISSION_COOKIE,
  PAID_SOCIAL_PERMISSION_COOKIE,
  X_ADVERTISER_PERMISSION_COOKIE,
]

export function googleAdsPermissionDeclined(
  readCookie: (name: string) => string | undefined,
): boolean {
  return DECLINABLE_PERMISSION_COOKIES.some((name) => readCookie(name) === '0')
}

export function googleAdsTrackingOptedOut(headers: {
  get(name: string): string | null
}): boolean {
  const dnt = headers.get('dnt')?.toLowerCase()
  return headers.get('sec-gpc') === '1' || dnt === '1' || dnt === 'yes'
}
