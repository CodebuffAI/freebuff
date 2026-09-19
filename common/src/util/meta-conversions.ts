/** Shared browser/server contract; this marker is eligibility, not a consent UI. */
export const META_TRACKING_PERMISSION_COOKIE = 'freebuff_meta_allowed'
/** Meta's own first-party click cookie, which the pixel and our fallback both write. */
export const META_CLICK_COOKIE = '_fbc'
export const META_CONVERSION_EVENT_NAMES = [
  'CompleteRegistration',
  'CodingActivation',
  'Subscribe',
] as const
export type MetaConversionEventName =
  (typeof META_CONVERSION_EVENT_NAMES)[number]

export const META_ACTIVATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export type MetaConversionValue = { value: number; currency: 'USD' }

export function isMetaConversionValue(
  value: unknown,
): value is MetaConversionValue {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<MetaConversionValue>
  return (
    candidate.currency === 'USD' &&
    typeof candidate.value === 'number' &&
    Number.isFinite(candidate.value) &&
    candidate.value > 0
  )
}

export function metaTrackingOptedOut(headers: {
  get(name: string): string | null
}) {
  return headers.get('sec-gpc') === '1' || headers.get('dnt') === '1'
}

/** Reject unbounded or malformed values; fbc/fbp are passed unhashed to Meta. */
export function validMetaBrowserId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= 512 &&
    /^fb\.\d+\.\d{13}\.[A-Za-z0-9_-]+$/.test(value)
    ? value
    : undefined
}

/** A landing `fbclid`, as Meta's own pixel would accept it into `_fbc`. */
export function validMetaClickId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,400}$/.test(value)
    ? value
    : undefined
}

/**
 * Meta's documented first-party `_fbc` value, `fb.1.<creation ms>.<fbclid>`,
 * built by us so a click still reaches the server when the pixel script is
 * blocked — which on a developer audience is the common case, not the edge.
 * `1` is the subdomain index for a cookie on the registrable domain.
 */
export function metaClickCookieValue(
  fbclid: unknown,
  now: number,
): string | undefined {
  const clickId = validMetaClickId(fbclid)
  return clickId ? `fb.1.${Math.floor(now)}.${clickId}` : undefined
}
