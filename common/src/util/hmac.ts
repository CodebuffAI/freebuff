/**
 * One HMAC-SHA256 construction for every keyed hash and signature in the repo
 * (COD-407).
 *
 * Five modules in `@codebuff/internal` each built their own
 * `createHmac('sha256', secret).update(...).digest(...)`. They were
 * byte-identical in the construction and differed only in ENCODING (hex for
 * stored hashes, base64url for tokens) and in what they fed it -- the salts
 * and prefixes that make one domain's output unusable in another. Those stay
 * at the call sites: they are the load-bearing part. This module owns only
 * the arithmetic.
 *
 * Server-only: it needs `node:crypto`. `common` is published wholesale to the
 * public mirror, and that is fine here -- there is no secret in a hash
 * function, only in what callers pass to it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

type HmacInput = string | Buffer

/** Raw HMAC-SHA256 bytes. Prefer one of the encoded forms below. */
export function hmacSha256(secret: HmacInput, message: HmacInput): Buffer {
  return createHmac('sha256', secret).update(message).digest()
}

/**
 * Lowercase hex, 64 characters. The encoding every STORED keyed hash uses
 * (the identity-match and client-IP hashes, the decision user key) so that a
 * value produced by one module can be compared to one stored by another
 * without re-hashing.
 */
export function hmacSha256Hex(secret: HmacInput, message: HmacInput): string {
  return hmacSha256(secret, message).toString('hex')
}

/**
 * Unpadded base64url, 43 characters. The encoding every SIGNED TOKEN uses
 * (tracked links, click ids, run tokens): URL- and cookie-safe with no
 * escaping.
 */
export function hmacSha256Base64Url(
  secret: HmacInput,
  message: HmacInput,
): string {
  return hmacSha256(secret, message).toString('base64url')
}

/**
 * Constant-time string equality for comparing a presented secret, token or
 * signature to the expected one. In Node and Bun, use this; code that cannot
 * import `node:crypto` (Convex V8 functions) uses `constantTimeStringEquals`
 * from `./constant-time`, which answers identically.
 *
 * The answer is exactly `expected === presented`. The strings are compared as
 * UTF-16 code units, not UTF-8 bytes: UTF-8 encodes every lone surrogate as
 * U+FFFD, so two different strings could compare equal.
 *
 * A length mismatch is an early (and safe) `false`: the attacker already
 * knows the length of a valid signature, so nothing is leaked by refusing
 * before the byte compare, and `timingSafeEqual` throws on unequal lengths
 * rather than answering.
 */
export function constantTimeEquals(
  expected: string,
  presented: string,
): boolean {
  const a = Buffer.from(expected, 'utf16le')
  const b = Buffer.from(presented, 'utf16le')
  return a.length === b.length && timingSafeEqual(a, b)
}
