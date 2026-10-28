import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import {
  buildRedditCustomConversionBody,
  redditConversionId,
  RedditCapiDeliveryError,
  sendRedditCustomConversion,
} from '../reddit-capi'

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex')

describe('Reddit CAPI', () => {
  test('builds a documented v3 custom-event payload', () => {
    const body = buildRedditCustomConversionBody({
      customEventName: 'FirstPrompt',
      conversionId: 'conversion-1',
      actionSource: 'WEBSITE',
      eventSourceUrl: 'https://freebuff.com/chat?utm_source=reddit',
      testId: 'test-123',
      eventAt: 123,
      user: {
        email: 'Al.ice+Apple@Example.Com',
        externalId: ' user-123 ',
        ipAddress: '203.0.113.10',
        userAgent: 'Browser',
        clickId: 'reddit-click',
        uuid: 'pixel-uuid',
      },
    })

    expect(body).toEqual({
      data: {
        test_id: 'test-123',
        events: [
          {
            event_at: 123,
            action_source: 'WEBSITE',
            event_source_url:
              'https://freebuff.com/chat?utm_source=reddit&rdt_cid=reddit-click',
            type: {
              tracking_type: 'CUSTOM',
              custom_event_name: 'FirstPrompt',
            },
            click_id: 'reddit-click',
            metadata: { conversion_id: 'conversion-1' },
            user: {
              email: sha256('alice@example.com'),
              external_id: sha256('user-123'),
              ip_address: '203.0.113.10',
              user_agent: 'Browser',
              uuid: 'pixel-uuid',
            },
          },
        ],
      },
    })
    expect(body.data.events[0]?.user).not.toHaveProperty('click_id')
    expect(body.data).not.toHaveProperty('partner')
  })

  test('uses a stable opaque conversion id per user and event', () => {
    expect(redditConversionId('FirstPrompt', 'user-123')).toBe(
      sha256('FirstPrompt:user-123'),
    )
    expect(redditConversionId('Retention1d', 'user-123')).not.toBe(
      redditConversionId('FirstPrompt', 'user-123'),
    )
  })

  test('retries one transient failure', async () => {
    let attempts = 0
    const result = await sendRedditCustomConversion({
      enabled: true,
      accessToken: 'secret',
      customEventName: 'Retention1d',
      conversionId: 'conversion-1',
      actionSource: 'OTHER',
      user: { externalId: 'user-1' },
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        attempts += 1
        return attempts === 1
          ? new Response('retry', { status: 503 })
          : Response.json({ data: { message: 'ok' } })
      }) as unknown as typeof fetch,
    })

    expect(result).toBe('sent')
    expect(attempts).toBe(2)
  })

  test('does not retry permanent failures', async () => {
    let attempts = 0
    await expect(
      sendRedditCustomConversion({
        enabled: true,
        accessToken: 'secret',
        customEventName: 'FirstPrompt',
        conversionId: 'conversion-1',
        actionSource: 'WEBSITE',
        user: { externalId: 'user-1' },
        sleepImpl: async () => {},
        fetchImpl: (async () => {
          attempts += 1
          return new Response('invalid', { status: 400 })
        }) as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(RedditCapiDeliveryError)
    expect(attempts).toBe(1)
  })

  test('is disabled without production enablement or a token', async () => {
    let called = false
    const result = await sendRedditCustomConversion({
      enabled: false,
      accessToken: 'secret',
      customEventName: 'FirstPrompt',
      conversionId: 'conversion-1',
      actionSource: 'WEBSITE',
      user: {},
      fetchImpl: (async () => {
        called = true
        return Response.json({})
      }) as unknown as typeof fetch,
    })
    expect(result).toBe('disabled')
    expect(called).toBe(false)
  })
})

test('canonical signup uses the standard SIGN_UP type and activation remains Custom', () => {
  const base = {
    conversionId: redditConversionId('SignUp', 'fixture-account'),
    actionSource: 'WEBSITE' as const,
    eventAt: 1792497600000,
    user: { clickId: 'fixture-click' },
  }
  const signup = buildRedditCustomConversionBody({
    ...base,
    customEventName: 'SignUp',
  }).data.events[0]!
  expect(signup.type).toEqual({ tracking_type: 'SIGN_UP' })
  expect(signup.metadata.conversion_id).toBe(base.conversionId)
  const activation = buildRedditCustomConversionBody({
    ...base,
    customEventName: 'CodingActivation',
    actionSource: 'OTHER',
  }).data.events[0]!
  expect(activation.type).toEqual({
    tracking_type: 'CUSTOM',
    custom_event_name: 'CodingActivation',
  })
  expect(activation.action_source).toBe('OTHER')
})
