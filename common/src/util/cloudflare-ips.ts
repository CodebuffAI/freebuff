import { BlockList, isIP } from 'node:net'

/**
 * Cloudflare's published IP ranges (https://www.cloudflare.com/ips-v4/ and
 * .../ips-v6/). These are the addresses from which Cloudflare proxies traffic
 * to an origin, so an origin that wants to accept only Cloudflare-proxied
 * requests (or that needs to know whether a peer is Cloudflare) can allowlist
 * them.
 *
 * The lists are bundled so the check works offline and never depends on a
 * network round-trip. Use `fetchCloudflareIps` to refresh them from
 * Cloudflare's published endpoints when a fresher view is wanted.
 */
export const CLOUDFLARE_IPV4_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
] as const

export const CLOUDFLARE_IPV6_RANGES: readonly string[] = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
] as const

const cloudflareV4 = new BlockList()
for (const cidr of CLOUDFLARE_IPV4_RANGES) {
  const [address, prefix] = cidr.split('/')
  cloudflareV4.addSubnet(address, Number(prefix), 'ipv4')
}
const cloudflareV6 = new BlockList()
for (const cidr of CLOUDFLARE_IPV6_RANGES) {
  const [address, prefix] = cidr.split('/')
  cloudflareV6.addSubnet(address, Number(prefix), 'ipv6')
}

/**
 * Whether the given address belongs to one of Cloudflare's published IP
 * ranges. Returns false for anything that isn't a valid IPv4/IPv6 address.
 */
export function isCloudflareIp(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return cloudflareV4.check(address, 'ipv4')
  if (family === 6) return cloudflareV6.check(address, 'ipv6')
  return false
}

export interface CloudflareIpLists {
  v4: string[]
  v6: string[]
}

const CLOUDFLARE_IPS_V4_URL = 'https://www.cloudflare.com/ips-v4/'
const CLOUDFLARE_IPS_V6_URL = 'https://www.cloudflare.com/ips-v6/'

function parseCidrLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/**
 * Fetch the current Cloudflare IP ranges from Cloudflare's published
 * endpoints. Falls back to the bundled ranges if either request fails or
 * returns no usable data, so callers always get a complete list.
 */
export async function fetchCloudflareIps(
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<CloudflareIpLists> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const [v4Res, v6Res] = await Promise.all([
      fetchFn(CLOUDFLARE_IPS_V4_URL, { signal: controller.signal }),
      fetchFn(CLOUDFLARE_IPS_V6_URL, { signal: controller.signal }),
    ])
    const [v4Text, v6Text] = await Promise.all([
      v4Res.ok ? v4Res.text() : Promise.resolve(''),
      v6Res.ok ? v6Res.text() : Promise.resolve(''),
    ])
    const v4 = parseCidrLines(v4Text)
    const v6 = parseCidrLines(v6Text)
    return {
      v4: v4.length > 0 ? v4 : [...CLOUDFLARE_IPV4_RANGES],
      v6: v6.length > 0 ? v6 : [...CLOUDFLARE_IPV6_RANGES],
    }
  } catch {
    return {
      v4: [...CLOUDFLARE_IPV4_RANGES],
      v6: [...CLOUDFLARE_IPV6_RANGES],
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Build a BlockList from arbitrary CIDR lists (e.g. a freshly fetched set).
 * Useful for callers that want to test against updated ranges without
 * mutating the bundled lists.
 */
export function buildCloudflareBlockList(lists: CloudflareIpLists): {
  v4: BlockList
  v6: BlockList
} {
  const v4 = new BlockList()
  const v6 = new BlockList()
  for (const cidr of lists.v4) {
    const [address, prefix] = cidr.split('/')
    if (address && prefix) v4.addSubnet(address, Number(prefix), 'ipv4')
  }
  for (const cidr of lists.v6) {
    const [address, prefix] = cidr.split('/')
    if (address && prefix) v6.addSubnet(address, Number(prefix), 'ipv6')
  }
  return { v4, v6 }
}
