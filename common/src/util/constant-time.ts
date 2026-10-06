/**
 * Constant-time string equality for runtimes without `node:crypto` (Convex V8
 * functions). Node and Bun code uses `constantTimeEquals` from `./hmac`, which
 * delegates to `timingSafeEqual`; the two answer identically, and both answer
 * exactly `a === b`.
 *
 * Every code unit is visited once whatever the inputs hold, so the time taken
 * depends on the length and not on where the strings first differ. A length
 * mismatch returns early: the length of a valid secret or signature is not
 * itself secret.
 */
export function constantTimeStringEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return difference === 0
}
