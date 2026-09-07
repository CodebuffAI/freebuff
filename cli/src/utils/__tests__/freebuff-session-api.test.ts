import { freebucksFixture } from '@codebuff/common/testing/freebuff'
import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  FREEBUFF_REWARD_MODEL_ID,
  resolveFreebuffModelForAccessTier,
} from '@codebuff/common/constants/freebuff-models'

import {
  callFreebuffSession,
  classifyFreebuffSessionRequestFailure,
  FreebuffSessionRequestError,
  mergeCompactActiveSession,
} from '../freebuff-session-api'

let fetchSpy: ReturnType<typeof spyOn> | undefined

afterEach(() => {
  fetchSpy?.mockRestore()
  fetchSpy = undefined
})

test('the reward model reaches the session POST header unchanged', async () => {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ status: 'none' }), {
      headers: { 'content-type': 'application/json' },
    }),
  )
  const resolved = resolveFreebuffModelForAccessTier(
    FREEBUFF_REWARD_MODEL_ID,
    'full',
  )

  await callFreebuffSession('POST', 'test-token', { model: resolved })

  expect(fetchSpy).toHaveBeenCalledTimes(1)
  const [, init] = fetchSpy.mock.calls[0]!
  expect(new Headers(init?.headers).get('x-freebuff-model')).toBe(
    FREEBUFF_REWARD_MODEL_ID,
  )
})

test('compact GET sends the compact-session header', async () => {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ status: 'active', model: 'model', instanceId: 'i1' }),
  )

  await callFreebuffSession('GET', 'test-token', {
    instanceId: 'i1',
    compact: true,
  })

  const [, init] = fetchSpy.mock.calls[0]!
  expect(new Headers(init?.headers).get('x-freebuff-compact-session')).toBe('1')
})

test('compact active state retains the admission quota and Freebucks snapshots', () => {
  const freebucks = freebucksFixture(5)
  const rateLimit = {
    model: 'model',
    limit: 5,
    period: 'pacific_day' as const,
    resetTimeZone: 'America/Los_Angeles' as const,
    resetAt: '2026-08-06T07:00:00.000Z',
    windowHours: 1,
    recentCount: 2,
    entitlementBreakdown: { base: 5, referral: 0, streak: 0 },
  }
  const merged = mergeCompactActiveSession(
    {
      status: 'active',
      accessTier: 'full',
      model: 'model',
      instanceId: 'i1',
      admittedAt: '2026-08-05T12:00:00.000Z',
      expiresAt: '2026-08-05T13:00:00.000Z',
      remainingMs: 1_000,
      rateLimit,
      freebucks,
    },
    {
      status: 'active',
      accessTier: 'full',
      model: 'model',
      instanceId: 'i1',
      admittedAt: '2026-08-05T12:00:00.000Z',
      expiresAt: '2026-08-05T13:00:00.000Z',
      remainingMs: 500,
    },
  )

  expect(merged).toMatchObject({ remainingMs: 500, rateLimit, freebucks })
})

test('compact state requests a full refresh instead of carrying quota across models', () => {
  const merged = mergeCompactActiveSession(
    {
      status: 'active',
      accessTier: 'full',
      model: 'old-model',
      instanceId: 'i1',
      admittedAt: '2026-08-05T12:00:00.000Z',
      expiresAt: '2026-08-05T13:00:00.000Z',
      remainingMs: 1_000,
      rateLimit: {
        model: 'old-model',
        limit: 5,
        period: 'pacific_day',
        resetTimeZone: 'America/Los_Angeles',
        resetAt: '2026-08-06T07:00:00.000Z',
        windowHours: 1,
        recentCount: 2,
        entitlementBreakdown: { base: 5, referral: 0, streak: 0 },
      },
    },
    {
      status: 'active',
      accessTier: 'full',
      model: 'new-model',
      instanceId: 'i1',
      admittedAt: '2026-08-05T12:00:00.000Z',
      expiresAt: '2026-08-05T13:00:00.000Z',
      remainingMs: 500,
    },
  )

  expect(merged).toBeNull()
})

test('does not repeat a takeover POST after an ambiguous timeout', () => {
  const timeout = new DOMException('The operation timed out', 'TimeoutError')

  expect(classifyFreebuffSessionRequestFailure('POST', timeout)).toBe('unknown')
  expect(classifyFreebuffSessionRequestFailure('GET', timeout)).toBe('retry')
})

test('retries POST responses that cannot represent a committed takeover', async () => {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json(
      {
        error: 'service_overloaded',
        message: 'Freebuff session service is busy. Please retry shortly.',
      },
      { status: 503, headers: { 'retry-after': '10' } },
    ),
  )

  await expect(callFreebuffSession('POST', 'test-token')).rejects.toMatchObject({
    statusCode: 503,
    retryAfterMs: 10_000,
    errorCode: 'service_overloaded',
  })

  expect(
    classifyFreebuffSessionRequestFailure(
      'POST',
      new FreebuffSessionRequestError(
        'busy',
        503,
        10_000,
        'service_overloaded',
      ),
    ),
  ).toBe('retry')
  expect(
    classifyFreebuffSessionRequestFailure(
      'POST',
      new FreebuffSessionRequestError('generic proxy 503', 503, 10_000),
    ),
  ).toBe('retry')
  expect(
    classifyFreebuffSessionRequestFailure(
      'POST',
      new FreebuffSessionRequestError('request timeout', 408, 10_000),
    ),
  ).toBe('retry')
  expect(
    classifyFreebuffSessionRequestFailure(
      'POST',
      new FreebuffSessionRequestError('edge rate limit', 429, 10_000),
    ),
  ).toBe('retry')
})

test('stops on terminal 4xx responses', () => {
  expect(
    classifyFreebuffSessionRequestFailure(
      'POST',
      new FreebuffSessionRequestError('unauthorized', 401),
    ),
  ).toBe('stop')
  expect(
    classifyFreebuffSessionRequestFailure(
      'GET',
      new FreebuffSessionRequestError('not found', 404),
    ),
  ).toBe('stop')
})

test('marks response loss and server errors after a POST as unknown outcomes', () => {
  expect(
    classifyFreebuffSessionRequestFailure(
      'POST',
      new TypeError('fetch failed'),
    ),
  ).toBe('unknown')
  expect(
    classifyFreebuffSessionRequestFailure(
      'POST',
      new FreebuffSessionRequestError('internal error', 500),
    ),
  ).toBe('unknown')
  expect(
    classifyFreebuffSessionRequestFailure(
      'GET',
      new FreebuffSessionRequestError('internal error', 500),
    ),
  ).toBe('retry')
})

test('DELETE sends the held instance and preserves the server refund receipt', async () => {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ status: 'ended', freebucksRefund: 4 }),
  )
  const result = await callFreebuffSession('DELETE', 'test-token', {
    instanceId: 'held-cli',
  })
  expect(result).toEqual({ status: 'ended', freebucksRefund: 4 })
  const [, init] = fetchSpy.mock.calls[0]!
  expect(new Headers(init?.headers).get('x-freebuff-instance-id')).toBe(
    'held-cli',
  )
})
