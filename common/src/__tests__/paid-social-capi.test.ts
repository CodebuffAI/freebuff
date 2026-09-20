import { describe, expect, mock, test } from 'bun:test'
import {
  buildPaidSocialRequest,
  hashPaidSocialEmail,
  paidSocialId,
  sendPaidSocialConversion,
  xEventId,
  xOAuthHeader,
  type PaidSocialConfig,
  type SendPaidSocialConversionParams,
} from '../paid-social-capi'

const x: Extract<PaidSocialConfig, { platform: 'x' }> = {
  platform: 'x',
  pixelId: 'abc',
  signupEventId: 'tw-abc-signup',
  activationEventId: 'activation',
  consumerKey: 'consumer',
  consumerSecret: 'secret',
  accessToken: 'access',
  accessTokenSecret: 'token-secret',
}
const tiktok: PaidSocialConfig = {
  platform: 'tiktok',
  pixelId: 'TIKTOK1',
  accessToken: 'token',
}
const xPixelToken: PaidSocialConfig = {
  platform: 'x',
  pixelId: 'abc',
  signupEventId: 'tw-abc-signup',
  activationEventId: 'activation',
  pixelToken: 'pixel-token',
}
const base: Omit<SendPaidSocialConversionParams, 'config'> = {
  eventName: 'CompleteRegistration',
  eventId: 'stable-occurrence',
  eventAt: new Date('2026-09-18T12:00:00Z'),
  userId: 'internal-account',
  attribution: {
    clickId: 'click-id',
    userAgent: 'Browser',
    ipAddress: '203.0.113.9',
    ttp: 'CiXyZ.tt.1',
    signupPath: '/api/auth/callback/github',
    campaign: { utm_campaign: 'internal-only-campaign' },
  },
}
const emailHash =
  '5806dc6b2f04fb728708a8f7b81c14edcd4fba36f77914cf0c9368d9a3a25f76'
describe('paid social transport contracts', () => {
  test('normalizes a real email before unsalted SHA256 and rejects invalid input', () => {
    expect(hashPaidSocialEmail('  Test@X.com  ')).toBe(emailHash)
    for (const value of [
      undefined,
      null,
      1,
      '',
      'not-email',
      'a@@b.com',
      'a b@c.com',
      `${'x'.repeat(255)}@x.com`,
    ])
      expect(hashPaidSocialEmail(value)).toBeUndefined()
  })
  test.each([x, xPixelToken])(
    'X accepts genuine signup and native email matching without a click',
    (config) => {
      for (const eventName of [
        'CompleteRegistration',
        'CodingActivation',
      ] as const) {
        const request = buildPaidSocialRequest({
          ...base,
          config,
          eventName,
          attribution: { userAgent: 'Browser', hashedEmail: emailHash },
        })
        expect(request.body).toEqual({
          conversions: [
            {
              conversion_time: '2026-09-18T12:00:00.000Z',
              event_id: `${config.pixelToken ? 'tw-abc-' : ''}${eventName === 'CompleteRegistration' ? 'signup' : 'activation'}`,
              identifiers: [{ hashed_email: emailHash }],
              conversion_id: 'stable-occurrence',
            },
          ],
        })
        expect(JSON.stringify(request.body)).not.toContain('internal-account')
        expect(JSON.stringify(request.body)).not.toContain('user_agent')
        expect(JSON.stringify(request.body)).not.toContain('url')
      }
    },
  )
  test('X includes both genuine matching identifiers when available', () => {
    const request = buildPaidSocialRequest({
      ...base,
      config: xPixelToken,
      attribution: { ...base.attribution, hashedEmail: emailHash },
    })
    expect(request.body.conversions).toMatchObject([
      { identifiers: [{ twclid: 'click-id', hashed_email: emailHash }] },
    ])
  })
  test.each([
    { clickId: undefined },
    { clickId: undefined, hashedEmail: 'raw@example.com' },
    { clickId: undefined, hashedEmail: emailHash.toUpperCase() },
    { clickId: 'https://private/path', hashedEmail: emailHash },
    { clickId: '', hashedEmail: emailHash },
    { hashedEmail: 'not-a-hash' },
    { ipAddress: '999.1.1.1' },
    { userAgent: '' },
    { userAgent: ' '.repeat(10) },
    { userAgent: 'a'.repeat(513) },
  ])(
    'X rejects missing or malformed matching data before network delivery',
    async (fields) => {
      const fetchImpl = mock(async () =>
        Response.json({ data: { conversions_processed: 1 } }),
      ) as unknown as typeof fetch
      await expect(
        sendPaidSocialConversion({
          ...base,
          config: xPixelToken,
          attribution: { ...base.attribution, ...fields },
          fetchImpl,
        }),
      ).rejects.toThrow('Invalid paid social matching data')
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )
  test('TikTok organic registration omits the click but forwards the hashed email, address and _ttp', () => {
    const request = buildPaidSocialRequest({
      ...base,
      config: tiktok,
      attribution: {
        ...base.attribution,
        clickId: undefined,
        hashedEmail: emailHash,
      },
    })
    expect(request.body.data).toMatchObject([
      {
        user: {
          ttp: 'CiXyZ.tt.1',
          external_id: paidSocialId('tiktok', 'internal-account'),
          email: emailHash,
          ip: '203.0.113.9',
          user_agent: 'Browser',
        },
      },
    ])
    const body = JSON.stringify(request.body)
    expect(body).not.toContain('ttclid')
    expect(body.toLowerCase()).not.toContain('test@x.com')
  })
  test.each([
    { userAgent: '' },
    { userAgent: 'x'.repeat(513) },
    { clickId: 'malformed click' },
    { ttp: 'bad ttp' },
    { ipAddress: 'not-an-ip' },
  ])('TikTok still rejects invalid browser matching data', (fields) => {
    expect(() =>
      buildPaidSocialRequest({
        ...base,
        config: tiktok,
        attribution: { ...base.attribution, ...fields },
      }),
    ).toThrow()
  })
  test('X sends the configured event with stable occurrence, ISO time and only click matching', () => {
    const request = buildPaidSocialRequest({ ...base, config: x })
    expect(request.url).toBe(
      'https://ads-api.x.com/12/measurement/conversions/abc',
    )
    expect(request.body).toEqual({
      conversions: [
        {
          conversion_time: '2026-09-18T12:00:00.000Z',
          event_id: 'signup',
          identifiers: [{ twclid: 'click-id' }],
          conversion_id: 'stable-occurrence',
        },
      ],
    })
    expect(request.headers.Authorization).toStartWith('OAuth ')
    expect(JSON.stringify(request)).not.toContain('internal-only-campaign')
    expect(JSON.stringify(request.body)).not.toContain('internal-account')
  })
  test('X accepts a bare or matching full event ID and rejects mismatched pixels', () => {
    expect(xEventId('abc', 'event1')).toBe('event1')
    expect(xEventId('abc', 'tw-abc-event1')).toBe('event1')
    expect(xEventId('abc', 'tw-other-event1')).toBeUndefined()
    expect(() =>
      buildPaidSocialRequest({
        ...base,
        config: { ...x, signupEventId: 'tw-other-event' },
      }),
    ).toThrow()
  })
  test.each(['signup', 'tw-abc-signup'])(
    'X pixel-token authentication needs no OAuth credentials and sends a full event ID: %s',
    (signupEventId) => {
      const request = buildPaidSocialRequest({
        ...base,
        config: { ...xPixelToken, signupEventId },
      })
      expect(request.headers).toEqual({
        'Content-Type': 'application/json',
        'X-Pixel-Token': 'pixel-token',
      })
      expect(request.body).toEqual({
        conversions: [
          {
            conversion_time: '2026-09-18T12:00:00.000Z',
            event_id: 'tw-abc-signup',
            identifiers: [{ twclid: 'click-id' }],
            conversion_id: 'stable-occurrence',
          },
        ],
      })
    },
  )
  test('X pixel-token authentication rejects a full event ID for another pixel', () => {
    expect(() =>
      buildPaidSocialRequest({
        ...base,
        config: { ...xPixelToken, signupEventId: 'tw-other-signup' },
      }),
    ).toThrow('Invalid X conversion event configuration')
  })
  test('native X events have no fabricated website context', () => {
    const request = buildPaidSocialRequest({
      ...base,
      config: x,
      eventName: 'CodingActivation',
    })
    expect(JSON.stringify(request.body)).toContain('activation')
    expect(JSON.stringify(request.body)).not.toContain('url')
  })
  test('TikTok uses the exact server schema and only the allowlisted actual callback', () => {
    const request = buildPaidSocialRequest({ ...base, config: tiktok })
    expect(request.url).toBe(
      'https://business-api.tiktok.com/open_api/v1.3/event/track/',
    )
    expect(request.headers['Access-Token']).toBe('token')
    expect(request.body).toEqual({
      event_source: 'web',
      event_source_id: 'TIKTOK1',
      data: [
        {
          event: 'CompleteRegistration',
          event_time: 1789732800,
          event_id: 'stable-occurrence',
          user: {
            ttclid: 'click-id',
            ttp: 'CiXyZ.tt.1',
            external_id: paidSocialId('tiktok', 'internal-account'),
            ip: '203.0.113.9',
            user_agent: 'Browser',
          },
          page: { url: 'https://freebuff.com/api/auth/callback/github' },
        },
      ],
    })
    expect(JSON.stringify(request.body)).not.toContain('internal-only-campaign')
    expect(JSON.stringify(request.body)).not.toContain('internal-account')
  })
  test('TikTok reports native activation as a custom event on the product page of its surface', () => {
    for (const surface of ['desktop', 'cli'] as const) {
      const request = buildPaidSocialRequest({
        ...base,
        config: tiktok,
        eventName: 'CodingActivation',
        surface,
      })
      expect(request.body.data).toMatchObject([
        {
          event: 'CodingActivation',
          event_id: 'stable-occurrence',
          page: { url: `https://freebuff.com/${surface}` },
          user: { ttclid: 'click-id', user_agent: 'Browser' },
        },
      ])
    }
    for (const surface of [undefined, 'web'] as const)
      expect(() =>
        buildPaidSocialRequest({
          ...base,
          config: tiktok,
          eventName: 'CodingActivation',
          surface,
        }),
      ).toThrow('native surface')
  })
  test('TikTok refuses arbitrary/private/query-bearing registration contexts', () => {
    for (const signupPath of [
      undefined,
      '/web/project/private',
      '/api/auth/callback/github?code=secret',
    ])
      expect(() =>
        buildPaidSocialRequest({
          ...base,
          config: tiktok,
          attribution: { ...base.attribution, signupPath: signupPath as any },
        }),
      ).toThrow()
  })
  test('OAuth signature is deterministic with fixed nonce/time and safely encodes secrets', () => {
    // Independently calculated with Python stdlib HMAC-SHA1 + RFC3986 quoting.
    const header = xOAuthHeader(
      {
        ...x,
        consumerKey: 'key!*',
        consumerSecret: 'secret /&',
        accessToken: 'token +',
        accessTokenSecret: 'secret"+',
      },
      'https://ads-api.x.com/12/measurement/conversions/abc123',
      'fixed-nonce',
      '1789732800',
    )
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"')
    expect(header).toContain(
      'oauth_signature="aBcvI3%2Bw4nmOJE11j4OnhCCb8Lw%3D"',
    )
    expect(header).not.toContain('token-secret')
    expect(header).not.toContain('consumerSecret')
  })
  test.each([
    { config: x, response: { data: { conversions_processed: 1 } } },
    { config: xPixelToken, response: { data: { conversions_processed: 1 } } },
    { config: tiktok, response: { code: 0, data: {} } },
  ])('requires vendor acknowledgement', async ({ config, response }) => {
    const fetchImpl = mock(async () =>
      Response.json(response),
    ) as unknown as typeof fetch
    expect(await sendPaidSocialConversion({ ...base, config, fetchImpl })).toBe(
      'sent',
    )
  })
  test.each([
    {},
    { code: 7 },
    { data: { conversions_processed: 0 } },
    { data: { conversions_processed: 1 }, errors: ['rejected'] },
  ])(
    'does not call a malformed/rejected response success',
    async (response) => {
      await expect(
        sendPaidSocialConversion({
          ...base,
          config: x,
          fetchImpl: mock(async () =>
            Response.json(response),
          ) as unknown as typeof fetch,
        }),
      ).rejects.toThrow('not acknowledged')
    },
  )
  test.each([{}, { code: 40002 }, { code: '0' }])(
    'TikTok nonzero/malformed 200 responses are not successful',
    async (response) => {
      await expect(
        sendPaidSocialConversion({
          ...base,
          config: tiktok,
          fetchImpl: mock(async () =>
            Response.json(response),
          ) as unknown as typeof fetch,
        }),
      ).rejects.toThrow('not acknowledged')
    },
  )
  test('TikTok rate-limit code 40100 retries with identical immutable body', async () => {
    const bodies: unknown[] = []
    const fetchImpl = mock(async (_url: unknown, init?: RequestInit) => {
      bodies.push(init?.body)
      return bodies.length === 1
        ? Response.json({ code: 40100 }, { status: 401 })
        : Response.json({ code: 0 })
    }) as unknown as typeof fetch
    expect(
      await sendPaidSocialConversion({
        ...base,
        config: tiktok,
        fetchImpl,
        sleepImpl: async () => {},
      }),
    ).toBe('sent')
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toBe(bodies[1])
  })
  test('rechecks opt-out before retry and never exposes an upstream body or token', async () => {
    const fetchImpl = mock(async () =>
      Response.json({ secret: 'should-never-escape' }, { status: 503 }),
    ) as unknown as typeof fetch
    const canSend = mock(async () => true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    expect(
      await sendPaidSocialConversion({
        ...base,
        config: x,
        fetchImpl,
        canSend,
        sleepImpl: async () => {},
      }),
    ).toBe('suppressed')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
