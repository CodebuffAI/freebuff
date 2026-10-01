import dns from 'node:dns'
import net from 'node:net'
import { promisify } from 'node:util'

import ipaddr from 'ipaddr.js'

/**
 * Resolves a hostname to one or more IP addresses. Injectable so callers (and
 * tests) can supply a deterministic resolver instead of hitting real DNS.
 */
export type HostLookup = (hostname: string) => Promise<string[]>

/** Error thrown when a URL is rejected for SSRF reasons. */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfError'
  }
}

const lookupAsync = promisify(dns.lookup)

const defaultLookup: HostLookup = async (hostname) => {
  const results = await lookupAsync(hostname, { all: true, verbatim: true })
  return results.map((result) => result.address)
}

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

  return addr.range() !== 'unicast'
}

/**
 * Strips IPv6 brackets that `URL.hostname` keeps (e.g. "[::1]" -> "::1").
 */
function unwrapHost(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1)
  }
  return hostname
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
 */
export async function assertUrlAllowed(
  url: URL,
  opts: { lookupHost?: HostLookup; resolveDns?: boolean } = {},
): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('Only http:// and https:// URLs are supported')
  }

  const host = unwrapHost(url.hostname)

  if (net.isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new SsrfError(
        `Refusing to fetch private or reserved address: ${host}`,
      )
    }
    return
  }

  if (opts.resolveDns === false) {
    return
  }

  const lookupHost = opts.lookupHost ?? defaultLookup
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
    if (isBlockedAddress(ip)) {
      throw new SsrfError(
        `Host "${host}" resolves to a private or reserved address (${ip})`,
      )
    }
  }
}
