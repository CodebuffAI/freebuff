/**
 * Normalize an HTTP `User-Agent` into a bounded token for analytics.
 *
 * Records which client product made a request, for analytics. The official
 * CLI sends `Freebuff-CLI/<version>` (`getCliAdRequestUserAgent` in
 * cli/src/hooks/use-gravity-ad.ts). A user agent is client-supplied, so the
 * output describes a request; it is never treated as proof of anything.
 *
 * Two properties make this safe to attach to a high-volume event:
 *
 * - **PII.** Only the leading RFC 7231 product token is kept, so every
 *   parenthetical detail is dropped before anything is recorded:
 *   `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 …`
 *   becomes `mozilla/5.0`. Nothing after the first whitespace is read.
 * - **Cardinality.** Values are bounded in size and charset: the product is
 *   lowercased and stripped to `[a-z0-9._-]`, and anything empty or longer than
 *   32 chars collapses to the single constant `unrecognized`. A version must
 *   both look like a version and fit in 16 chars or it is omitted. Nothing is
 *   ever truncated into a new value.
 *
 *   This bounds each value, not the number of distinct values: a hostile client
 *   can still vary the product within 32 legal chars. That residual risk is
 *   accepted because an allowlist would defeat the entire point — spotting a
 *   client we have not seen before. It is why this field feeds analysis only,
 *   never enforcement, and why the chat-completions call site rides the
 *   existing 1% free-mode sample. If it is ever abused, the fix is an allowlist
 *   here, not at the call sites.
 */

const MAX_PRODUCT_LEN = 32
const MAX_VERSION_LEN = 16

/** Junk, or a header we could not parse into a product token. */
export const UNRECOGNIZED_CLIENT = 'unrecognized'

/** A version-ish token: starts with a digit, then dotted/alphanumeric parts. */
const VERSION_RE = /^\d[0-9A-Za-z.+-]*$/

export type NormalizedClientUserAgent = {
  /** Lowercased product token, e.g. `freebuff-cli`, or `unrecognized`. */
  product: string
  /** Version token when the product declared a parseable one. */
  version?: string
}

/**
 * Returns `undefined` for an absent/empty header so callers can spread the
 * result into an event payload without emitting empty keys.
 */
export function normalizeClientUserAgent(
  raw: string | null | undefined,
): NormalizedClientUserAgent | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  // RFC 7231: `product/version (comment) product/version …`. Everything from
  // the first whitespace on is commentary — drop it unread.
  const [firstToken = ''] = trimmed.split(/\s+/, 1)
  const slash = firstToken.indexOf('/')
  const rawProduct = slash === -1 ? firstToken : firstToken.slice(0, slash)
  const rawVersion = slash === -1 ? '' : firstToken.slice(slash + 1)

  // An `@` never appears in a legitimate product token, and stripping it would
  // turn `user@example.com/1.0` into the recorded value `userexample.com` — a
  // mangled but still-identifying address. Reject instead of sanitizing. (A
  // contact address in the conventional `Bot/1.0 (+me@example.com)` position is
  // already dropped: it is after the first whitespace.)
  if (rawProduct.includes('@')) return { product: UNRECOGNIZED_CLIENT }

  const product = rawProduct.toLowerCase().replace(/[^a-z0-9._-]/g, '')

  // Empty after sanitizing, or implausibly long: collapse to one constant
  // rather than record a truncated fabrication. Real product tokens are short
  // (`freebuff-cli` 12, `go-http-client` 14, `ai-sdk` 6), so anything past the
  // cap is junk — and collapsing it also removes the cheapest way to pump
  // cardinality, which is a long random string per request.
  if (!product || product.length > MAX_PRODUCT_LEN) {
    return { product: UNRECOGNIZED_CLIENT }
  }

  // Drop an over-long version rather than truncating it. Truncation fabricates
  // a value the client never sent — `1.0.0-beta+build.1` would be reported as
  // `1.0.0-beta+build`, which is both wrong and collides with `…build.2`. A
  // missing version is honest; an invented one would quietly corrupt exactly
  // the "is this client pinned to a stale version?" question this exists for.
  if (rawVersion.length > MAX_VERSION_LEN || !VERSION_RE.test(rawVersion)) {
    return { product }
  }
  return { product, version: rawVersion }
}

/**
 * Event-payload shape for the normalized agent. Separate fields (rather than
 * one joined string) keep "which clients exist" and "which versions of one
 * client" independently groupable in APL.
 */
export function clientUserAgentFields(raw: string | null | undefined): {
  client_ua_product?: string
  client_ua_version?: string
} {
  const normalized = normalizeClientUserAgent(raw)
  if (!normalized) return {}
  return {
    client_ua_product: normalized.product,
    ...(normalized.version ? { client_ua_version: normalized.version } : {}),
  }
}
