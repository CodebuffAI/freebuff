import { describe, test, expect, mock } from 'bun:test'

import { CLI_AUTH_CODE_LIFETIME_MS } from '@codebuff/common/constants/auth'
import { createMockLogger } from '@codebuff/common/testing/mock-types'
import { generateLoginUrl, pollLoginStatus } from '../../login/login-flow'
import { createMockApiClient } from '../helpers/mock-api-client'

import type { LoginUrlResponse } from '../../login/login-flow'
import type { ApiResponse } from '../../utils/codebuff-api'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const createClock = () => {
  let current = 0
  return {
    sleep: async (ms: number) => {
      current += ms
    },
    now: () => current,
  }
}

describe('Login Polling (Working)', () => {
  test('P0: Polling Lifecycle - should stop polling and return user when login succeeds', async () => {
    const logger = createMockLogger()
    const apiResponses: Array<ApiResponse<{ user?: unknown }>> = [
      { ok: false, status: 401 },
      {
        ok: true,
        status: 200,
        data: { user: { id: 'u1', name: 'Test User', email: 'user@test.dev' } },
      },
    ]
    let callIndex = 0
    const loginStatusMock = mock(
      async (req: {
        fingerprintId: string
        fingerprintHash: string
        expiresAt: string
      }) => {
        expect(req.fingerprintId).toBe('finger-1')
        expect(req.fingerprintHash).toBe('hash-1')
        expect(req.expiresAt).toBe('2030-01-01T00:00:00Z')
        const response =
          apiResponses[Math.min(callIndex, apiResponses.length - 1)]
        callIndex += 1
        return response
      },
    )

    const apiClient = createMockApiClient({ loginStatus: loginStatusMock })
    const clock = createClock()

    const result = await pollLoginStatus(
      {
        sleep: clock.sleep,
        logger,
        now: clock.now,
        apiClient,
      },
      {
        baseUrl: 'https://cli.test',
        fingerprintId: 'finger-1',
        fingerprintHash: 'hash-1',
        expiresAt: '2030-01-01T00:00:00Z',
        intervalMs: 10,
        timeoutMs: 200,
      },
    )

    expect(result.status).toBe('success')
    if (result.status !== 'success') {
      throw new Error(`Expected polling success but received ${result.status}`)
    }
    expect(result.attempts).toBe(2)
    expect(loginStatusMock.mock.calls.length).toBe(2)
  })

  test('P0: Polling Lifecycle - should keep polling on 401 responses', async () => {
    const logger = createMockLogger()
    const loginStatusMock = mock(async () => {
      return { ok: false, status: 401 } as ApiResponse<{ user?: unknown }>
    })

    const apiClient = createMockApiClient({ loginStatus: loginStatusMock })
    const clock = createClock()
    const result = await pollLoginStatus(
      {
        sleep: clock.sleep,
        logger,
        now: clock.now,
        apiClient,
      },
      {
        baseUrl: 'https://cli.test',
        fingerprintId: 'finger-2',
        fingerprintHash: 'hash-2',
        expiresAt: '2030-01-01T00:00:00Z',
        intervalMs: 10,
        timeoutMs: 50,
      },
    )

    expect(result.status).toBe('timeout')
    expect(loginStatusMock.mock.calls.length).toBeGreaterThan(1)
  })

  test('P0: Polling Lifecycle - should call loginStatus with full metadata', async () => {
    const logger = createMockLogger()
    const loginStatusMock = mock(
      async (req: {
        fingerprintId: string
        fingerprintHash: string
        expiresAt: string
      }) => {
        expect(req.fingerprintId).toBe('finger-meta')
        expect(req.fingerprintHash).toBe('hash-meta')
        expect(req.expiresAt).toBe('2030-01-01T00:00:00Z')
        return {
          ok: true,
          status: 200,
          data: {
            user: { id: 'u-meta', name: 'Meta User', email: 'meta@test.dev' },
          },
        } as ApiResponse<{ user?: unknown }>
      },
    )

    const apiClient = createMockApiClient({ loginStatus: loginStatusMock })
    const clock = createClock()
    const result = await pollLoginStatus(
      {
        sleep: clock.sleep,
        logger,
        now: clock.now,
        apiClient,
      },
      {
        baseUrl: 'https://cli.test',
        fingerprintId: 'finger-meta',
        fingerprintHash: 'hash-meta',
        expiresAt: '2030-01-01T00:00:00Z',
        intervalMs: 5,
        timeoutMs: 50,
      },
    )

    expect(result.status).toBe('success')
    if (result.status !== 'success') {
      throw new Error(`Expected polling success but received ${result.status}`)
    }
    expect(loginStatusMock.mock.calls.length).toBe(1)
  })

  test('P1: Error Handling - should log warnings on non-401 responses but continue polling', async () => {
    const logger = createMockLogger()
    const loginStatusMock = mock(async () => {
      return { ok: false, status: 500, error: 'Server Error' } as ApiResponse<{
        user?: unknown
      }>
    })

    const apiClient = createMockApiClient({ loginStatus: loginStatusMock })
    const clock = createClock()
    const result = await pollLoginStatus(
      {
        sleep: clock.sleep,
        logger,
        now: clock.now,
        apiClient,
      },
      {
        baseUrl: 'https://cli.test',
        fingerprintId: 'finger-error',
        fingerprintHash: 'hash-error',
        expiresAt: '2030-01-01T00:00:00Z',
        intervalMs: 5,
        timeoutMs: 25,
      },
    )

    expect(result.status).toBe('timeout')
    expect(logger.warn.mock.calls.length).toBeGreaterThan(0)
  })

  test('P1: Error Handling - should swallow network errors and keep polling', async () => {
    const logger = createMockLogger()
    let attempt = 0
    const loginStatusMock = mock(async () => {
      attempt += 1
      if (attempt === 1) {
        return { ok: false, status: 401 } as ApiResponse<{ user?: unknown }>
      }
      if (attempt === 2) {
        throw new Error('network failed')
      }
      return {
        ok: true,
        status: 200,
        data: {
          user: { id: 'user', name: 'Network User', email: 'net@test.dev' },
        },
      } as ApiResponse<{ user?: unknown }>
    })

    const apiClient = createMockApiClient({ loginStatus: loginStatusMock })
    const clock = createClock()
    const result = await pollLoginStatus(
      {
        sleep: clock.sleep,
        logger,
        now: clock.now,
        apiClient,
      },
      {
        baseUrl: 'https://cli.test',
        fingerprintId: 'finger-network',
        fingerprintHash: 'hash-network',
        expiresAt: '2030-01-01T00:00:00Z',
        intervalMs: 5,
        timeoutMs: 100,
      },
    )

    expect(result.status).toBe('success')
    if (result.status !== 'success') {
      throw new Error(`Expected polling success but received ${result.status}`)
    }
    expect(loginStatusMock.mock.calls.length).toBeGreaterThan(1)
    const errorCalls = logger.error.mock.calls as Array<
      Parameters<Logger['error']>
    >
    const sawNetworkFailure = errorCalls.some(([payload]) => {
      if (!payload || typeof payload !== 'object') {
        return false
      }
      return JSON.stringify(payload as Parameters<Logger['error']>[0]).includes('network failed')
    })
    expect(sawNetworkFailure).toBe(true)
  })

  test('P0: Polling Lifecycle - by default waits as long as the login code lives', async () => {
    // A new account's sign-up, phone step and Connect can take longer than
    // five minutes; an approval after polling stopped is never collected.
    const logger = createMockLogger()
    const clock = createClock()
    const approvedAt = 7 * 60 * 1000
    const loginStatusMock = mock(async () =>
      clock.now() >= approvedAt
        ? ({
            ok: true,
            status: 200,
            data: { user: { id: 'u-late', email: 'late@test.dev' } },
          } as ApiResponse<{ user?: unknown }>)
        : ({ ok: false, status: 401 } as ApiResponse<{ user?: unknown }>),
    )

    const result = await pollLoginStatus(
      {
        sleep: clock.sleep,
        logger,
        now: clock.now,
        apiClient: createMockApiClient({ loginStatus: loginStatusMock }),
      },
      {
        baseUrl: 'https://cli.test',
        fingerprintId: 'finger-late',
        fingerprintHash: 'hash-late',
        expiresAt: '2030-01-01T00:00:00Z',
      },
    )

    expect(result.status).toBe('success')
  })

  test('P0: Polling Lifecycle - by default stops when the login code expires', async () => {
    const logger = createMockLogger()
    const clock = createClock()
    const loginStatusMock = mock(
      async () => ({ ok: false, status: 401 }) as ApiResponse<{ user?: unknown }>,
    )

    const result = await pollLoginStatus(
      {
        sleep: clock.sleep,
        logger,
        now: clock.now,
        apiClient: createMockApiClient({ loginStatus: loginStatusMock }),
      },
      {
        baseUrl: 'https://cli.test',
        fingerprintId: 'finger-expired',
        fingerprintHash: 'hash-expired',
        expiresAt: '2030-01-01T00:00:00Z',
      },
    )

    expect(result.status).toBe('timeout')
    expect(clock.now()).toBe(CLI_AUTH_CODE_LIFETIME_MS)
  })

  test('P0: generateLoginUrl wrapper - should hit backend and return payload', async () => {
    const logger = createMockLogger()
    const payload: LoginUrlResponse = {
      loginUrl: 'https://cli.test/login?code=code-123',
      fingerprintHash: 'hash-123',
      expiresAt: '2025-12-31T23:59:59Z',
    }
    const loginCodeMock = mock(async (req: { fingerprintId: string }) => {
      expect(req.fingerprintId).toBe('finger-login')
      return {
        ok: true,
        status: 200,
        data: payload,
      } as ApiResponse<LoginUrlResponse>
    })

    const apiClient = createMockApiClient({ loginCode: loginCodeMock })

    const result = await generateLoginUrl(
      { logger, apiClient },
      { baseUrl: 'https://cli.test', fingerprintId: 'finger-login' },
    )

    expect(result).toEqual(payload)
  })

  test('P0: generateLoginUrl wrapper - should throw when backend returns error', async () => {
    const logger = createMockLogger()
    const loginCodeMock = mock(async () => {
      return {
        ok: false,
        status: 500,
        error: 'Server Error',
      } as ApiResponse<LoginUrlResponse>
    })

    const apiClient = createMockApiClient({ loginCode: loginCodeMock })

    await expect(
      generateLoginUrl(
        { logger, apiClient },
        { baseUrl: 'https://cli.test', fingerprintId: 'finger-login' },
      ),
    ).rejects.toThrow('Failed to get login URL')
  })
})
