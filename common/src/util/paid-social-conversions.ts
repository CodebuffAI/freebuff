import {
  validHashedEmailHex,
  validMatchingIpAddress,
} from './acquisition-matching'

export const PAID_SOCIAL_PLATFORMS = ['x', 'tiktok'] as const
export type PaidSocialPlatform = (typeof PAID_SOCIAL_PLATFORMS)[number]
export const PAID_SOCIAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Eligibility for an auth handoff, not an explicit consent record. */
export const PAID_SOCIAL_PERMISSION_COOKIE = 'freebuff_paid_social_allowed'
export const paidSocialClickCookie = (platform: PaidSocialPlatform) =>
  `freebuff_${platform}_click`
/** TikTok's own first-party browser cookie, set by its pixel on public pages. */
export const TIKTOK_BROWSER_COOKIE = '_ttp'
// Public, static OAuth endpoints only. No arbitrary URL, query, user ID, or
// project path may enter the vendor's required website-event page context.
export const PAID_SOCIAL_SIGNUP_PATHS = [
  '/api/auth/callback/github',
  '/api/auth/callback/google',
  '/api/auth/callback/apple',
] as const
export type PaidSocialSignupPath = (typeof PAID_SOCIAL_SIGNUP_PATHS)[number]
export function paidSocialSignupPath(
  value: unknown,
): PaidSocialSignupPath | undefined {
  return PAID_SOCIAL_SIGNUP_PATHS.find((path) => path === value)
}
export type PaidSocialAttribution = {
  clickId?: string
  /** Unsalted SHA-256 of the trimmed, lowercased account email. */
  hashedEmail?: string
  /** Client address resolved at enrollment. Forwarded to TikTok as `ip`. */
  ipAddress?: string
  /** TikTok's `_ttp` browser cookie; never retained for X. */
  ttp?: string
  userAgent: string
  signupPath?: PaidSocialSignupPath
  /** First-party cohort dimensions only: never put these in a vendor payload. */
  campaign?: PaidSocialCampaign
}
const CAMPAIGN_KEYS = ['utm_campaign', 'utm_content', 'utm_term'] as const
export type PaidSocialCampaign = Partial<
  Record<(typeof CAMPAIGN_KEYS)[number], string>
>
export function paidSocialCampaign(
  value: unknown,
): PaidSocialCampaign | undefined {
  if (!value || typeof value !== 'object') return undefined
  const fields: PaidSocialCampaign = {}
  for (const key of CAMPAIGN_KEYS) {
    const field = (value as Record<string, unknown>)[key]
    if (typeof field === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(field))
      fields[key] = field
  }
  return Object.keys(fields).length ? fields : undefined
}
export function paidSocialCampaignParams(params: URLSearchParams) {
  return paidSocialCampaign(
    Object.fromEntries(CAMPAIGN_KEYS.map((key) => [key, params.get(key)])),
  )
}
export type PaidSocialEvent = 'CompleteRegistration' | 'CodingActivation'

export function validPaidSocialClickId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    /^[A-Za-z0-9._~-]+$/.test(value)
    ? value
    : undefined
}

export const validPaidSocialHashedEmail = validHashedEmailHex

export function validTikTokBrowserId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,256}$/.test(value)
    ? value
    : undefined
}

/** Validate both enrollment and stored data, retaining only approved fields. */
export function normalizePaidSocialAttribution(
  platform: PaidSocialPlatform,
  value: unknown,
): PaidSocialAttribution | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const input = value as Record<string, unknown>
  const clickId = validPaidSocialClickId(input.clickId)
  if (input.clickId !== undefined && !clickId) return undefined
  if (
    typeof input.userAgent !== 'string' ||
    !input.userAgent.trim() ||
    input.userAgent.length > 512
  )
    return undefined
  const signupPath = paidSocialSignupPath(input.signupPath)
  const hashedEmail = validPaidSocialHashedEmail(input.hashedEmail)
  if (input.hashedEmail !== undefined && !hashedEmail) return undefined
  const ipAddress = validMatchingIpAddress(input.ipAddress)
  if (input.ipAddress !== undefined && !ipAddress) return undefined
  const ttp =
    platform === 'tiktok' ? validTikTokBrowserId(input.ttp) : undefined
  if (platform === 'tiktok' && input.ttp !== undefined && !ttp) return undefined
  if (platform === 'x' ? !clickId && !hashedEmail : !signupPath)
    return undefined
  return {
    clickId,
    ...(hashedEmail ? { hashedEmail } : {}),
    ...(ipAddress ? { ipAddress } : {}),
    ...(ttp ? { ttp } : {}),
    userAgent: input.userAgent,
    signupPath,
    campaign: paidSocialCampaign(input.campaign),
  }
}

export function paidSocialOptedOut(headers: {
  get(name: string): string | null
}) {
  return headers.get('sec-gpc') === '1' || headers.get('dnt') === '1'
}

export function withinPaidSocialWindow(from: Date, now: Date): boolean {
  const age = now.getTime() - from.getTime()
  return age >= 0 && age < PAID_SOCIAL_WINDOW_MS
}

/** Timestamp the landing capture: cookie expiry alone is not a server-side fence. */
export function parsePaidSocialClickData(
  value: string | undefined,
  now: Date,
): { clickId: string; campaign?: PaidSocialCampaign } | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value))
    if (!parsed || typeof parsed !== 'object') return undefined
    const { clickId, capturedAt, campaign } = parsed as {
      clickId?: unknown
      capturedAt?: unknown
      campaign?: unknown
    }
    const validId = validPaidSocialClickId(clickId)
    return validId &&
      typeof capturedAt === 'number' &&
      Number.isFinite(capturedAt) &&
      withinPaidSocialWindow(new Date(capturedAt), now)
      ? { clickId: validId, campaign: paidSocialCampaign(campaign) }
      : undefined
  } catch {
    return undefined
  }
}

export function parsePaidSocialClick(value: string | undefined, now: Date) {
  return parsePaidSocialClickData(value, now)?.clickId
}
