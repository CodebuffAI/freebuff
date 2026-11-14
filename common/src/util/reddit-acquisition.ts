/** Public, bounded attribution shared by the browser, installer bridge and CAPI. */
export const REDDIT_ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
export const REDDIT_ACTIVATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export type RedditAcquisitionEvent = 'SignUp' | 'CodingActivation'
export type { CodingActivationSurface as RedditAcquisitionSurface } from './coding-activation-surface'
export type RedditClickAttribution = {
  clickId?: string
  uuid?: string
  capturedAt: number
}

export function normalizeRedditAttribution(
  value: unknown,
  now = Date.now(),
): RedditClickAttribution | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (
    typeof row.capturedAt !== 'number' ||
    !Number.isFinite(row.capturedAt) ||
    row.capturedAt > now ||
    now - row.capturedAt >= REDDIT_ATTRIBUTION_WINDOW_MS
  )
    return undefined
  const bounded = (v: unknown, max: number) =>
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= max &&
    /^[A-Za-z0-9_.:-]+$/.test(v)
      ? v
      : undefined
  const clickId = bounded(row.clickId, 512)
  const uuid = bounded(row.uuid, 256)
  return clickId || uuid
    ? { clickId, uuid, capturedAt: row.capturedAt }
    : undefined
}

export function redditAttributionFromCookies(
  read: (name: string) => string | undefined,
  now = Date.now(),
) {
  return normalizeRedditAttribution(
    {
      clickId: read('freebuff_rdt_cid') ?? read('_rdt_cid'),
      uuid: read('_rdt_uuid'),
      capturedAt: Number(read('freebuff_rdt_captured_at')) || now,
    },
    now,
  )
}

export function withinRedditActivationWindow(signupAt: Date, now: Date) {
  const age = now.getTime() - signupAt.getTime()
  return age >= 0 && age < REDDIT_ACTIVATION_WINDOW_MS
}

/** Current-browser withdrawal always wins over an installer's saved context. */
export function redditSignupContext(input: {
  optedOut: boolean
  readCookie(name: string): string | undefined
  download?: RedditClickAttribution
  now?: number
}): { attribution?: RedditClickAttribution } | null {
  if (input.optedOut || input.readCookie('freebuff_meta_ads_funnel') === '1')
    return null
  const now = input.now ?? Date.now()
  const browser = redditAttributionFromCookies(input.readCookie, now)
  const download = normalizeRedditAttribution(input.download, now)
  // A new login browser has its own UUID even though it never saw the ad.
  // That UUID must not hide the installer's click. A fresh browser click wins
  // outright; otherwise retain the installer click with its original age and
  // use the actual signup browser's UUID when available.
  if (browser?.clickId || !download?.clickId)
    return { attribution: browser ?? download }
  return {
    attribution: {
      clickId: download.clickId,
      uuid: browser?.uuid ?? download.uuid,
      capturedAt: download.capturedAt,
    },
  }
}
