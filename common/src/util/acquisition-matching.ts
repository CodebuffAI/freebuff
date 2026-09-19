/**
 * Shape checks for the identity match keys the acquisition trackers store and
 * forward to Meta, TikTok and X. Browser-safe on purpose: the pixel helpers
 * import from here, so nothing in this file may touch node:crypto or node:net.
 */

/** Unsalted SHA-256 hex, as every vendor's `em`/`email`/`hashed_email` expects. */
export function validHashedEmailHex(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    ? value
    : undefined
}

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
// Bounded rather than exhaustive: the resolver already validated syntax with
// node's isIP before anything was stored. This only refuses junk on the way out.
const IPV6 = /^(?=.*:)[0-9a-f:.]{2,45}$/i

export function validMatchingIpAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return IPV4.test(value) || IPV6.test(value) ? value : undefined
}
