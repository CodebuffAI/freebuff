import dns from 'node:dns'
import net from 'node:net'
import { promisify } from 'node:util'

import ipaddr from 'ipaddr.js'

/**
 * Resolves a hostname to one or more IP addresses. Injectable so callers (and
 * tests) can supply a deterministic resolver instead of hitting real DNS.
 */
export type HostLookup = (hostname: string) => Promise<string[]>

/** Whether an address may not be fetched. */
export type AddressPolicy = (ip: string) => boolean

/** Error thrown when a URL is rejected for SSRF reasons. */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfError'
  }
}

const lookupAsync = promisify(dns.lookup)

export const defaultLookup: HostLookup = async (hostname) => {
  const results = await lookupAsync(hostname, { all: true, verbatim: true })
  return results.map((result) => result.address)
}

/**
 * Ranges that are not globally routable but that ipaddr.js classifies as
 * `unicast`: IPv4-compatible IPv6 (`::a.b.c.d`, deprecated), benchmarking
 * (198.18.0.0/15), site-local IPv6 (deprecated) and local-use NAT64.
 */
const EXTRA_BLOCKED_RANGES: ReadonlyArray<[ipaddr.IPv4 | ipaddr.IPv6, number]> =
  [
    ipaddr.parseCIDR('::/96'),
    ipaddr.parseCIDR('198.18.0.0/15'),
    ipaddr.parseCIDR('fec0::/10'),
    ipaddr.parseCIDR('64:ff9b:1::/48'),
  ]

/**
 * Returns true if an IP address is anything other than a globally-routable
 * public unicast address (i.e. loopback, private, link-local, unique-local,
 * carrier-grade NAT, multicast, reserved, unspecified, etc.). Unparseable
 * input is treated as blocked.
 */
export function isBlockedAddress(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6
  try {
    addr = ipaddr.parse(ip)
  } catch {
    return true
  }

  // Normalize IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1) so they are
  // classified by their embedded IPv4 range rather than as generic IPv6.
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6
    if (v6.isIPv4MappedAddress()) {
      addr = v6.toIPv4Address()
    }
  }

  if (addr.range() !== 'unicast') return true
  const parsed = addr
  return EXTRA_BLOCKED_RANGES.some(([range, bits]) =>
    range.kind() === 'ipv4'
      ? parsed.kind() === 'ipv4' &&
        (parsed as ipaddr.IPv4).match(range as ipaddr.IPv4, bits)
      : parsed.kind() === 'ipv6' &&
        (parsed as ipaddr.IPv6).match(range as ipaddr.IPv6, bits),
  )
}

/**
 * Strips IPv6 brackets that `URL.hostname` keeps (e.g. "[::1]" -> "::1").
 */
export function unwrapHost(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1)
  }
  return hostname
}

/**
 * Resolves `host` and returns its addresses only if EVERY one is allowed;
 * otherwise throws an {@link SsrfError}. One blocked answer refuses the host,
 * because a connection may use any of them.
 */
export async function resolveAllowedAddresses(
  host: string,
  opts: { lookupHost?: HostLookup; isBlocked?: AddressPolicy } = {},
): Promise<string[]> {
  const lookupHost = opts.lookupHost ?? defaultLookup
  const isBlocked = opts.isBlocked ?? isBlockedAddress
  let addresses: string[]
  try {
    addresses = await lookupHost(host)
  } catch (error) {
    throw new SsrfError(
      `Could not resolve host "${host}": ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    )
  }

  if (addresses.length === 0) {
    throw new SsrfError(`Could not resolve host "${host}"`)
  }

  for (const ip of addresses) {
    if (isBlocked(ip)) {
      throw new SsrfError(
        `Host "${host}" resolves to a private or reserved address (${ip})`,
      )
    }
  }
  return addresses
}

/**
 * Throws an {@link SsrfError} if the URL is not safe to fetch from the server:
 * non-http(s) schemes, IP literals in a private/reserved range, or hostnames
 * that resolve to such a range.
 *
 * IP literals are always checked synchronously (no DNS needed). Hostname
 * resolution is performed via `lookupHost` unless `resolveDns` is false — this
 * lets callers that supply their own `fetch` (e.g. unit tests with stubbed
 * responses) skip the network lookup while still rejecting literal addresses.
 *
 * This check alone does not pin the address a later connection uses; the
 * default `read_url` transport (`pinned-fetch.ts`) validates again at connect
 * time and connects only to the addresses it validated.
 */
export async function assertUrlAllowed(
  url: URL,
  opts: {
    lookupHost?: HostLookup
    resolveDns?: boolean
    isBlocked?: AddressPolicy
  } = {},
): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('Only http:// and https:// URLs are supported')
  }

  const host = unwrapHost(url.hostname)
  const isBlocked = opts.isBlocked ?? isBlockedAddress

  if (net.isIP(host) !== 0) {
    if (isBlocked(host)) {
      throw new SsrfError(
        `Refusing to fetch private or reserved address: ${host}`,
      )
    }
    return
  }

  if (opts.resolveDns === false) {
    return
  }

  await resolveAllowedAddresses(host, {
    lookupHost: opts.lookupHost,
    isBlocked,
  })
}
