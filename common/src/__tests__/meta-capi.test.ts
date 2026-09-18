import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'

import {
  buildMetaConversionBody,
  metaConversionId,
  sendMetaConversion,
  type SendMetaConversionParams,
} from '../meta-capi'
import {
  metaTrackingOptedOut,
  validMetaBrowserId,
} from '../util/meta-conversions'

const params: SendMetaConversionParams = {
  pixelId: '123456789',
  accessToken: 'secret-never-in-body',
  eventName: 'CompleteRegistration',
  eventId: metaConversionId('CompleteRegistration', 'canonical-user'),
  userId: 'canonical-user',
  eventAt: new Date('2026-09-20T12:30:20.123Z'),
  surface: 'web',
  attribution: {
    fbc: 'fb.1.1790000000000.click',
    fbp: 'fb.1.1790000000000.1234',
    userAgent: 'Browser',
  },
}

describe('Meta conversion payload and attribution', () => {
  test('sends subscription money in major currency units without inventing an LTV', () => {
    const body = buildMetaConversionBody({
      ...params,
      eventName: 'Subscribe',
      conversionValue: { value: 2.67, currency: 'USD' },
    })
    expect(body.data[0]?.custom_data).toEqual({
      surface: 'web',
      value: 2.67,
      currency: 'USD',
    })
    expect(
      buildMetaConversionBody(params).data[0]?.custom_data,
    ).not.toHaveProperty('value')
  })
  test('refuses missing, non-positive, non-finite or unsupported subscription values', () => {
    for (const value of [
      undefined,
      { value: 0, currency: 'USD' },
      { value: Infinity, currency: 'USD' },
      { value: 10, currency: 'JPY' },
    ]) {
      expect(() =>
        buildMetaConversionBody({
          ...params,
          eventName: 'Subscribe',
          conversionValue: value as SendMetaConversionParams['conversionValue'],
        }),
      ).toThrow('positive confirmed USD payment')
    }
  })
  test('uses seconds and hashed canonical identity, without email, URL parameters, or token', () => {
    const body = buildMetaConversionBody(params)
    expect(body.data[0]?.event_time).toBe(1789907420)
    expect(body.data[0]?.user_data.external_id).toEqual([
      createHash('sha256').update('canonical-user').digest('hex'),
    ])
    expect(body.data[0]?.user_data.fbc).toBe(params.attribution.fbc)
    expect(body.data[0]?.action_source).toBe('website')
    expect(body.data[0]?.event_source_url).toBe('https://freebuff.com/')
    expect(JSON.stringify(body)).not.toContain('canonical-user')
    expect(JSON.stringify(body)).not.toContain('secret-never-in-body')
    expect(body.data[0]?.user_data).not.toHaveProperty('em')
  })
  test('reports native coding as other, without a fictional website event or browser user agent', () => {
    const event = buildMetaConversionBody({
      ...params,
      eventName: 'CodingActivation',
      surface: 'desktop',
    }).data[0]
    expect(event?.action_source).toBe('other')
    expect(event).not.toHaveProperty('event_source_url')
    expect(event?.user_data).not.toHaveProperty('client_user_agent')
    expect(metaConversionId('CompleteRegistration', params.userId)).not.toBe(
      metaConversionId('CodingActivation', params.userId),
    )
  })
  test('rejects malformed matching identifiers and honors browser opt-outs', () => {
    for (const value of [
      '',
      'email@example.com',
      'fb.1.123.click',
      `fb.1.1790000000000.${'a'.repeat(512)}`,
    ])
      expect(validMetaBrowserId(value)).toBeUndefined()
    expect(validMetaBrowserId(params.attribution.fbc)).toBe(
      params.attribution.fbc,
    )
    expect(metaTrackingOptedOut(new Headers({ 'Sec-GPC': '1' }))).toBe(true)
    expect(metaTrackingOptedOut(new Headers({ DNT: '1' }))).toBe(true)
    expect(metaTrackingOptedOut(new Headers())).toBe(false)
  })
})

describe('Meta conversion transport', () => {
  test('revocation after a transient failure suppresses the retry', async () => {
    let allowed = true
    let requests = 0
    const result = await sendMetaConversion({
      ...params,
      canSend: async () => allowed,
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        requests++
        allowed = false
        return new Response('', { status: 503 })
      }) as unknown as typeof fetch,
    })
    expect(result).toBe('suppressed')
    expect(requests).toBe(1)
  })
  test('retries transient failure with identical event body and original timestamp', async () => {
    const requests: Array<{ url: string; options: RequestInit }> = []
    await sendMetaConversion({
      ...params,
      sleepImpl: async () => {},
      fetchImpl: (async (url, options) => {
        requests.push({ url: String(url), options: options! })
        return requests.length === 1
          ? new Response('', { status: 429 })
          : Response.json({ events_received: 1 })
      }) as typeof fetch,
    })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toBe(
      'https://graph.facebook.com/v26.0/123456789/events',
    )
    expect(requests[0]?.options.body).toBe(requests[1]?.options.body)
    expect(new Headers(requests[0]?.options.headers).get('Authorization')).toBe(
      'Bearer secret-never-in-body',
    )
  })
  test('does not retry permanent rejection or echo sensitive response bodies', async () => {
    let requests = 0
    await expect(
      sendMetaConversion({
        ...params,
        fetchImpl: (async () => {
          requests++
          return new Response('secret-never-in-body', { status: 400 })
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow('Meta conversion rejected (400)')
    expect(requests).toBe(1)
  })
  test('does not mark a 200 response without an accepted event as success', async () => {
    await expect(
      sendMetaConversion({
        ...params,
        sleepImpl: async () => {},
        fetchImpl: (async () =>
          Response.json({ events_received: 0 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow('Meta conversion delivery failed')
  })
})
