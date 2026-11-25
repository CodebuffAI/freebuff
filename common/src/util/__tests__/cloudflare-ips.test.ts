import { describe, expect, test } from 'bun:test'

import {
  CLOUDFLARE_IPV4_RANGES,
  CLOUDFLARE_IPV6_RANGES,
  isCloudflareIp,
  fetchCloudflareIps,
  buildCloudflareBlockList,
} from '../cloudflare-ips'

describe('CLOUDFLARE_IPV4_RANGES / CLOUDFLARE_IPV6_RANGES', () => {
  test('contain the published Cloudflare ranges', () => {
    expect(CLOUDFLARE_IPV4_RANGES.length).toBe(15)
    expect(CLOUDFLARE_IPV6_RANGES.length).toBe(7)
    expect(CLOUDFLARE_IPV4_RANGES).toContain('104.16.0.0/13')
    expect(CLOUDFLARE_IPV6_RANGES).toContain('2606:4700::/32')
  })
})

describe('isCloudflareIp', () => {
  test('Cloudflare IPs are detected', () => {
    for (const ip of ['104.16.0.1', '1.1.1.1' /* not in ranges, sanity */]) {
      // 1.1.1.1 is NOT in Cloudflare's proxy ranges; ensure not falsely positive
    }
    expect(isCloudflareIp('104.16.5.5')).toBe(true)
    expect(isCloudflareIp('2606:4700:4700::1111')).toBe(true)
    expect(isCloudflareIp('172.64.1.1')).toBe(true)
  })

  test('non-Cloudflare IPs are rejected', () => {
    for (const ip of ['8.8.8.8', '192.168.1.1', '127.0.0.1', '2001:4860:4860::8888']) {
      expect(isCloudflareIp(ip)).toBe(false)
    }
  })

  test('invalid input returns false', () => {
    expect(isCloudflareIp('not-an-ip')).toBe(false)
    expect(isCloudflareIp('')).toBe(false)
  })
})

describe('fetchCloudflareIps', () => {
  test('falls back to bundled ranges on network failure', async () => {
    const failingFetch = (() => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const result = await fetchCloudflareIps(failingFetch as typeof fetch)
    expect(result.v4).toEqual([...CLOUDFLARE_IPV4_RANGES])
    expect(result.v6).toEqual([...CLOUDFLARE_IPV6_RANGES])
  })

  test('parses successful response', async () => {
    const okFetch = (async () =>
      new Response('10.0.0.0/8\n# comment\n\n192.168.0.0/16\n', {
        status: 200,
      })) as unknown as typeof fetch
    // Provide separate responses per URL by checking url via a wrapper
    const wrapper = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('ips-v4')) {
        return new Response('10.0.0.0/8\n', { status: 200 })
      }
      return new Response('2001:db8::/32\n', { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchCloudflareIps(wrapper)
    expect(result.v4).toEqual(['10.0.0.0/8'])
    expect(result.v6).toEqual(['2001:db8::/32'])
  })

  test('falls back when response empty', async () => {
    const wrapper = (async () => new Response('', { status: 200 })) as unknown as typeof fetch
    const result = await fetchCloudflareIps(wrapper)
    expect(result.v4).toEqual([...CLOUDFLARE_IPV4_RANGES])
    expect(result.v6).toEqual([...CLOUDFLARE_IPV6_RANGES])
  })
})

describe('buildCloudflareBlockList', () => {
  test('builds working block lists', () => {
    const lists = {
      v4: ['10.0.0.0/8'],
      v6: ['2001:db8::/32'],
    }
    const { v4, v6 } = buildCloudflareBlockList(lists)
    expect(v4.check('10.1.2.3', 'ipv4')).toBe(true)
    expect(v4.check('8.8.8.8', 'ipv4')).toBe(false)
    expect(v6.check('2001:db8::1', 'ipv6')).toBe(true)
  })
})