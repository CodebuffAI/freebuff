import { describe, expect, test } from 'bun:test'
import { createAdReportClient } from '../ad-report'

const AD = {
  title: 'Example ad',
  url: 'https://example.com',
  adText: 'Visible copy',
  surface: 'cli',
  impUrl: 'impression-1',
  reason: 'This ad makes a misleading claim.',
}

describe('CLI ad reporting transport', () => {
  test('an account change at the transport boundary cannot reattribute an open report', async () => {
    let requests = 0
    const send = createAdReportClient({
      getToken: () => 'new-account-token',
      fetchImpl: (async () => {
        requests++
        return Response.json({ ok: true })
      }) as unknown as typeof fetch,
    })
    await expect(send(AD, 'opening-account-token')).rejects.toThrow(
      'account changed',
    )
    expect(requests).toBe(0)
    await send(AD, 'new-account-token')
    expect(requests).toBe(1)
  })

  test('sends the selected snapshot with CLI session auth, never private context or a click', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const send = createAdReportClient({
      baseUrl: 'https://freebuff.example/',
      getToken: () => 'session-token',
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init })
        return Response.json({ ok: true })
      }) as typeof fetch,
    })
    await send({
      ...AD,
      reason: `  ${AD.reason}  `,
      prompt: 'private',
      clickUrl: 'https://example.com/click',
    } as typeof AD)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://freebuff.example/api/ads/report')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.redirect).toBe('error')
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe(
      'Bearer session-token',
    )
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(AD)
  })

  test('requires a typed explanation before contacting the report endpoint', async () => {
    let requests = 0
    const send = createAdReportClient({
      getToken: () => 'token',
      fetchImpl: (async () => {
        requests++
        return Response.json({ ok: true })
      }) as unknown as typeof fetch,
    })
    for (const reason of [undefined, '  ', 'too short', 'a'.repeat(2001)]) {
      await expect(send({ ...AD, reason })).rejects.toThrow()
    }
    expect(requests).toBe(0)
  })

  test('requires both a successful HTTP response and explicit acknowledgement', async () => {
    for (const response of [
      Response.json({ ok: true }, { status: 503 }),
      Response.json({ ok: false }),
      new Response('not JSON'),
    ]) {
      const send = createAdReportClient({
        getToken: () => 'token',
        fetchImpl: (async () => response) as unknown as typeof fetch,
      })
      await expect(send(AD)).rejects.toThrow('Could not send')
    }
  })

  test('missing sign-in never sends a request', async () => {
    let requests = 0
    const send = createAdReportClient({
      getToken: () => null,
      fetchImpl: (async () => {
        requests++
        return Response.json({ ok: true })
      }) as unknown as typeof fetch,
    })
    await expect(send(AD)).rejects.toThrow('Sign in')
    expect(requests).toBe(0)
  })
})
