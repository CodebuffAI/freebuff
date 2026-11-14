import { BlockList, isIP } from 'node:net'

/**
 * Whether a resolved address is globally routable, for any server-side fetch
 * of a URL someone else chose (BYOK endpoints, custom MCP servers, web fetch,
 * advertiser landing pages and their tracked redirects).
 *
 * One list for every caller: the advertiser fetcher kept its own copy and
 * missed the 6to4 relay anycast range and Teredo, both of which can carry a
 * private IPv4 address inside a public-looking one.
 */
const privateV4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  privateV4.addSubnet(address, prefix, 'ipv4')
// Documentation, and transition prefixes that can embed a private IPv4 address.
const blockedV6 = new BlockList()
blockedV6.addSubnet('2001:db8::', 32, 'ipv6')
blockedV6.addSubnet('2001::', 32, 'ipv6')
blockedV6.addSubnet('2002::', 16, 'ipv6')
// Only global unicast counts; this also excludes IPv4-mapped, NAT64,
// unique-local, link-local and multicast.
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4
    ? !privateV4.check(address, 'ipv4')
    : family === 6 &&
        globalV6.check(address, 'ipv6') &&
        !blockedV6.check(address, 'ipv6')
}

/** Hostnames that name a private network rather than a public site. */
export const PRIVATE_HOSTNAME = /(?:^|\.)(localhost|local|internal|lan|home\.arpa)$/
