import http from 'node:http'
import { gzipSync } from 'node:zlib'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { pinnedFetch } from '../tools/pinned-fetch'
import { readUrl } from '../tools/read-url'
import { isBlockedAddress } from '../tools/ssrf'

import type { AddressInfo } from 'node:net'

/**
 * A local server stands in for an internal service. Every test asserts on
 * `hits`: a refused fetch must never reach it.
 */
let server: http.Server
let port = 0
let hits: { path: string; host: string | undefined }[] = []

beforeAll(async () => {
  server = http.createServer((request, response) => {
    hits.push({ path: request.url ?? '', host: request.headers.host })
    if (request.url === '/redirect-internal') {
      response.writeHead(302, {
        location: `http://internal.example:${port}/secret`,
      })
      response.end()
      return
    }
    if (request.url === '/gzip') {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-encoding': 'gzip',
      })
      response.end(gzipSync('compressed hello'))
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('internal secret')
  })
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server.close()
})

/** A resolver that answers from a script, one answer list per call. */
function flippingResolver(...answers: string[][]) {
  const calls: string[] = []
  const lookupHost = async (hostname: string) => {
    calls.push(hostname)
    return answers[Math.min(calls.length - 1, answers.length - 1)]!
  }
  return { lookupHost, calls }
}

const PUBLIC = '93.184.216.34'

describe('readUrl pins the connection to the address it validated', () => {
  it('refuses a name that answers public for the check and private for the connection', async () => {
    hits = []
    // `localhost` so that a transport resolving the name on its own (the old
    // behaviour) really does reach the local server.
    const { lookupHost, calls } = flippingResolver([PUBLIC], ['127.0.0.1'])
    const result = await readUrl({
      url: `http://localhost:${port}/secret`,
      lookupHost,
    })

    expect(hits).toEqual([])
    expect(result[0].value).toEqual({
      url: `http://localhost:${port}/secret`,
      errorMessage:
        'Host "localhost" resolves to a private or reserved address (127.0.0.1)',
    })
    // Resolved by the check, and again by the connection through the same
    // validating resolver.
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it('refuses when any one answer is private, even beside a public one', async () => {
    hits = []
    const { lookupHost } = flippingResolver([PUBLIC], [PUBLIC, '10.0.0.7'])
    const result = await readUrl({
      url: `http://localhost:${port}/secret`,
      lookupHost,
    })
    expect(hits).toEqual([])
    expect(result[0].value).toMatchObject({
      errorMessage: expect.stringContaining('(10.0.0.7)'),
    })
  })

  for (const [label, address] of [
    ['IPv4-mapped IPv6 loopback', '::ffff:127.0.0.1'],
    ['cloud metadata', '169.254.169.254'],
    ['CGNAT', '100.64.1.1'],
    ['unique-local IPv6', 'fd00::1'],
    ['RFC 1918', '192.168.1.10'],
  ] as const) {
    it(`refuses a connection-time answer in ${label}`, async () => {
      hits = []
      const { lookupHost } = flippingResolver([PUBLIC], [address])
      const result = await readUrl({
        url: `http://localhost:${port}/secret`,
        lookupHost,
      })
      expect(hits).toEqual([])
      expect(result[0].value).toMatchObject({
        errorMessage: expect.stringContaining(`(${address})`),
      })
    })
  }

  it('re-validates every redirect hop', async () => {
    hits = []
    // Only 127.0.0.1 counts as "public" here; the redirect target's name
    // answers 127.0.0.2, which the policy refuses.
    const isBlocked = (ip: string) => ip !== '127.0.0.1'
    const lookupHost = async (hostname: string) =>
      hostname === 'internal.example' ? ['127.0.0.2'] : ['127.0.0.1']
    const result = await readUrl({
      url: `http://public.example:${port}/redirect-internal`,
      lookupHost,
      isBlocked,
    })
    expect(hits.map((hit) => hit.path)).toEqual(['/redirect-internal'])
    expect(result[0].value).toMatchObject({
      errorMessage: expect.stringContaining('(127.0.0.2)'),
    })
  })
})

describe('pinnedFetch', () => {
  const allowLoopback = (ip: string) => ip !== '127.0.0.1'

  it('connects to the validated address and keeps the hostname', async () => {
    hits = []
    const { lookupHost } = flippingResolver(['127.0.0.1'])
    const response = await pinnedFetch(
      `http://pinned.example:${port}/page?q=1`,
      { lookupHost, isBlocked: allowLoopback },
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('internal secret')
    expect(hits).toEqual([
      { path: '/page?q=1', host: `pinned.example:${port}` },
    ])
  })

  it('refuses a refused answer at connect time, before any byte is sent', async () => {
    hits = []
    const { lookupHost } = flippingResolver(['10.9.9.9'])
    await expect(
      pinnedFetch(`http://pinned.example:${port}/`, {
        lookupHost,
        isBlocked: allowLoopback,
      }),
    ).rejects.toThrow('resolves to a private or reserved address (10.9.9.9)')
    expect(hits).toEqual([])
  })

  it('decodes a compressed body like fetch does', async () => {
    const { lookupHost } = flippingResolver(['127.0.0.1'])
    const response = await pinnedFetch(`http://pinned.example:${port}/gzip`, {
      lookupHost,
      isBlocked: allowLoopback,
    })
    expect(await response.text()).toBe('compressed hello')
    expect(response.headers.get('content-encoding')).toBeNull()
  })

  it('aborts on the signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      pinnedFetch(`http://pinned.example:${port}/`, {
        signal: controller.signal,
        isBlocked: allowLoopback,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('address policy', () => {
  it('refuses the ranges ipaddr.js calls unicast but nothing public uses', () => {
    for (const ip of [
      '::7f00:1', // IPv4-compatible ::127.0.0.1
      '::a9fe:a9fe', // IPv4-compatible ::169.254.169.254
      '198.18.0.1',
      'fec0::1',
      '64:ff9b:1::1',
    ]) {
      expect({ ip, blocked: isBlockedAddress(ip) }).toEqual({
        ip,
        blocked: true,
      })
    }
    for (const ip of ['8.8.8.8', '2606:4700:4700::1111', '1.1.1.1']) {
      expect({ ip, blocked: isBlockedAddress(ip) }).toEqual({
        ip,
        blocked: false,
      })
    }
  })
})
