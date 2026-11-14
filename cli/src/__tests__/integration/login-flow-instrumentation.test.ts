import { describe, test, expect, mock } from 'bun:test'

import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { createMockLogger } from '@codebuff/common/testing/mock-types'

import { generateLoginUrl, pollLoginStatus } from '../../login/login-flow'
import { createMockApiClient } from '../helpers/mock-api-client'

import type { ApiResponse } from '../../utils/codebuff-api'

const createClock = () => {
  let current = 0
  return {
    sleep: async (ms: number) => {
      current += ms
    },
    now: () => current,
  }
}

// Typed so `.mock.calls[i]` is `[AnalyticsEvent, props?]` rather than the empty
// tuple inferred from `mock(() => {})` (which makes indexing a type error).
const createTrackEventMock = () =>
  mock((_event: AnalyticsEvent, _properties?: Record<string, any>) => {})

describe('login-flow analytics instrumentation', () => {
  test('plain and TUI callers carry one explicit CLI UUID without changing authentication', async () => {
    const cliFlowId = 'a0000000-0000-4000-8000-000000000001'
    for (const via of ['modal', 'plain_command'] as const) {
      const data = {
        loginUrl: 'https://freebuff.test/login?auth_code=opaque-auth-code',
        fingerprintHash: 'private-hash',
        expiresAt: '2030-01-01T00:00:00Z',
      }
      const loginCode = mock(async () => ({
        ok: true as const,
        status: 200,
        data,
      }))
      const result = await generateLoginUrl(
        {
          logger: createMockLogger(),
          apiClient: createMockApiClient({ loginCode }),
        },
        {
          baseUrl: 'https://freebuff.test',
          fingerprintId: 'private-fingerprint',
          via,
          cliFlowId,
        },
      )
      const browserUrl = new URL(result.loginUrl)
      expect(browserUrl.searchParams.get('cli_flow')).toBe(cliFlowId)
      expect(browserUrl.searchParams.getAll('cli_flow')).toEqual([cliFlowId])
      expect(browserUrl.searchParams.get('auth_code')).toBe('opaque-auth-code')
      expect(result.fingerprintHash).toBe(data.fingerprintHash)
      expect(result.expiresAt).toBe(data.expiresAt)
      expect(loginCode).toHaveBeenCalledWith({
        fingerprintId: 'private-fingerprint',
      })
      expect(data.loginUrl).not.toContain('cli_flow')
    }
  })

  test('auth codes and invalid correlation values never imply CLI origin', async () => {
    const data = {
      loginUrl:
        'https://freebuff.test/login?auth_code=opaque-auth-code&native_apple=1',
      fingerprintHash: 'private-hash',
      expiresAt: '2030-01-01T00:00:00Z',
    }
    const loginCode = mock(async () => ({
      ok: true as const,
      status: 200,
      data,
    }))
    const apiClient = createMockApiClient({ loginCode })
    for (const cliFlowId of [
      undefined,
      'private-fingerprint',
      'opaque-auth-code',
    ]) {
      const result = await generateLoginUrl(
        { logger: createMockLogger(), apiClient },
        {
          baseUrl: 'https://freebuff.test',
          fingerprintId: 'private-fingerprint',
          cliFlowId,
        },
      )
      expect(result).toEqual(data)
    }
  })

  test('optional correlation never rejects an unusable or non-web URL', async () => {
    for (const loginUrl of ['not a URL', 'freebuff://login?auth_code=opaque']) {
      const data = {
        loginUrl,
        fingerprintHash: 'hash',
        expiresAt: '2030-01-01T00:00:00Z',
      }
      const loginCode = mock(async () => ({
        ok: true as const,
        status: 200,
        data,
      }))
      expect(
        await generateLoginUrl(
          {
            logger: createMockLogger(),
            apiClient: createMockApiClient({ loginCode }),
          },
          {
            baseUrl: 'https://freebuff.test',
            fingerprintId: 'fingerprint',
            cliFlowId: 'a0000000-0000-4000-8000-000000000001',
          },
        ),
      ).toEqual(data)
    }
  })

  test('generateLoginUrl emits LOGIN_STARTED on entry and nothing else on success', async () => {
    const trackEvent = createTrackEventMock()
    const loginCode = mock(async () => ({
      ok: true as const,
      status: 200,
      data: {
        loginUrl: 'https://cli.test/login?code=abc',
        fingerprintHash: 'hash-1',
        expiresAt: '2030-01-01T00:00:00Z',
      },
    }))
    const apiClient = createMockApiClient({ loginCode })

    await generateLoginUrl(
      { logger: createMockLogger(), apiClient, trackEvent },
      { baseUrl: 'https://cli.test', fingerprintId: 'finger-1', via: 'modal' },
    )

    expect(trackEvent).toHaveBeenCalledTimes(1)
    expect(trackEvent.mock.calls[0][0]).toBe(AnalyticsEvent.LOGIN_STARTED)
    expect(trackEvent.mock.calls[0][1]).toEqual({ via: 'modal' })
  })

  test('generateLoginUrl emits LOGIN_FAILED with reason on a failed URL request', async () => {
    const trackEvent = createTrackEventMock()
    const loginCode = mock(
      async () =>
        ({ ok: false, status: 500, error: 'boom' }) as ApiResponse<never>,
    )
    const apiClient = createMockApiClient({ loginCode })

    await expect(
      generateLoginUrl(
        { logger: createMockLogger(), apiClient, trackEvent },
        {
          baseUrl: 'https://cli.test',
          fingerprintId: 'finger-1',
          via: 'plain_command',
        },
      ),
    ).rejects.toThrow()

    // Two events: the initial LOGIN_STARTED and then LOGIN_FAILED. Match on the
    // payload rather than the enum identity so the assertion is unambiguous.
    expect(trackEvent).toHaveBeenCalledTimes(2)
    expect(trackEvent.mock.calls[0][1]).toEqual({ via: 'plain_command' })
    const failedCall = trackEvent.mock.calls.find(
      (c) => c[1]?.reason === 'url_request',
    )
    expect(failedCall).toBeDefined()
    expect(failedCall![1]).toEqual({
      via: 'plain_command',
      reason: 'url_request',
      status: 500,
    })
  })

  test('pollLoginStatus emits LOGIN_TIMEOUT with attempts + via', async () => {
    const trackEvent = createTrackEventMock()
    const loginStatus = mock(
      async () =>
        ({ ok: false, status: 401 }) as ApiResponse<{ user?: unknown }>,
    )
    const apiClient = createMockApiClient({ loginStatus })
    const clock = createClock()

    const result = await pollLoginStatus(
      {
        sleep: clock.sleep,
        logger: createMockLogger(),
        now: clock.now,
        apiClient,
        trackEvent,
      },
      {
        baseUrl: 'https://cli.test',
        fingerprintId: 'finger-1',
        fingerprintHash: 'hash-1',
        expiresAt: '2030-01-01T00:00:00Z',
        intervalMs: 10,
        timeoutMs: 30,
        via: 'modal',
      },
    )

    expect(result.status).toBe('timeout')
    expect(trackEvent).toHaveBeenCalledTimes(1)
    expect(trackEvent.mock.calls[0][0]).toBe(AnalyticsEvent.LOGIN_TIMEOUT)
    expect(trackEvent.mock.calls[0][1]).toMatchObject({ via: 'modal' })
    expect(trackEvent.mock.calls[0][1]!.attempts).toBeGreaterThan(0)
  })

  test('pollLoginStatus emits LOGIN_ABORTED when shouldContinue is false', async () => {
    const trackEvent = createTrackEventMock()
    const apiClient = createMockApiClient()
    const clock = createClock()

    const result = await pollLoginStatus(
      {
        sleep: clock.sleep,
        logger: createMockLogger(),
        now: clock.now,
        apiClient,
        trackEvent,
      },
      {
        baseUrl: 'https://cli.test',
        fingerprintId: 'finger-1',
        fingerprintHash: 'hash-1',
        expiresAt: '2030-01-01T00:00:00Z',
        shouldContinue: () => false,
        via: 'modal',
      },
    )

    expect(result.status).toBe('aborted')
    expect(trackEvent).toHaveBeenCalledTimes(1)
    expect(trackEvent.mock.calls[0][0]).toBe(AnalyticsEvent.LOGIN_ABORTED)
    expect(trackEvent.mock.calls[0][1]).toMatchObject({ via: 'modal' })
  })
})
