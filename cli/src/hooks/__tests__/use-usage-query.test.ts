import { createMockLogger } from '@codebuff/common/testing/mocks/logger'
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

import {
  resetActivityQueryCache,
  getActivityQueryData,
  setActivityQueryData,
  invalidateActivityQuery,
  removeActivityQuery,
} from '../use-activity-query'
import {
  fetchUsageData,
  usageQueryKeys,
} from '../use-usage-query'

import type { ClientEnv } from '@codebuff/common/types/contracts/env'


beforeEach(() => {
  resetActivityQueryCache()
})

describe('fetchUsageData', () => {
  const originalFetch = globalThis.fetch
  const originalEnv = process.env.NEXT_PUBLIC_CODEBUFF_APP_URL

  beforeEach(() => {
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = 'https://test.codebuff.local'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = originalEnv
    mock.restore()
  })

  test('should fetch usage data successfully', async () => {
    const mockResponse = {
      type: 'usage-response' as const,
      usage: 100,
      remainingBalance: 500,
      balanceBreakdown: { free: 300, paid: 200 },
      next_quota_reset: '2024-02-01T00:00:00.000Z',
    }

    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch

    const result = await fetchUsageData({ authToken: 'test-token' })

    expect(result).toEqual(mockResponse)
  })

  test('should handle full balance breakdown with all fields', async () => {
    const mockResponse = {
      type: 'usage-response' as const,
      usage: 250,
      remainingBalance: 1000,
      balanceBreakdown: {
        free: 100,
        paid: 500,
        ad: 200,
        referral: 150,
        admin: 50,
      },
      next_quota_reset: '2024-03-01T00:00:00.000Z',
      autoTopupEnabled: true,
    }

    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch

    const result = await fetchUsageData({ authToken: 'test-token' })

    expect(result).toEqual(mockResponse)
    expect(result.balanceBreakdown?.ad).toBe(200)
    expect(result.balanceBreakdown?.referral).toBe(150)
    expect(result.balanceBreakdown?.admin).toBe(50)
    expect(result.autoTopupEnabled).toBe(true)
  })

  test('should handle null remaining balance', async () => {
    const mockResponse = {
      type: 'usage-response' as const,
      usage: 0,
      remainingBalance: null,
      next_quota_reset: null,
    }

    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch

    const result = await fetchUsageData({ authToken: 'test-token' })

    expect(result.remainingBalance).toBeNull()
    expect(result.next_quota_reset).toBeNull()
    expect(result.balanceBreakdown).toBeUndefined()
  })

  test('should handle zero usage and balance', async () => {
    const mockResponse = {
      type: 'usage-response' as const,
      usage: 0,
      remainingBalance: 0,
      balanceBreakdown: { free: 0, paid: 0 },
      next_quota_reset: '2024-02-01T00:00:00.000Z',
    }

    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch

    const result = await fetchUsageData({ authToken: 'test-token' })

    expect(result.usage).toBe(0)
    expect(result.remainingBalance).toBe(0)
  })

  test('should throw error on failed request', async () => {
    globalThis.fetch = mock(
      async () => new Response('Error', { status: 500 }),
    ) as unknown as typeof fetch
    const mockLogger = createMockLogger()

    await expect(
      fetchUsageData({ authToken: 'test-token', logger: mockLogger }),
    ).rejects.toThrow('Failed to fetch usage: 500')
  })

  test('should throw error on 401 unauthorized', async () => {
    globalThis.fetch = mock(
      async () => new Response('Unauthorized', { status: 401 }),
    ) as unknown as typeof fetch
    const mockLogger = createMockLogger()

    await expect(
      fetchUsageData({ authToken: 'invalid-token', logger: mockLogger }),
    ).rejects.toThrow('Failed to fetch usage: 401')
  })

  test('should throw error on 402 payment required', async () => {
    globalThis.fetch = mock(
      async () => new Response('Payment Required', { status: 402 }),
    ) as unknown as typeof fetch
    const mockLogger = createMockLogger()

    await expect(
      fetchUsageData({ authToken: 'test-token', logger: mockLogger }),
    ).rejects.toThrow('Failed to fetch usage: 402')
  })

  test('should throw error when app URL is not set', async () => {
    await expect(
      fetchUsageData({
        authToken: 'test-token',
        clientEnv: {
          NEXT_PUBLIC_CODEBUFF_APP_URL: undefined,
        } as unknown as ClientEnv,
      }),
    ).rejects.toThrow('NEXT_PUBLIC_CODEBUFF_APP_URL is not set')
  })

  test('should send correct request body', async () => {
    let capturedBody: string | undefined

    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      capturedBody = init?.body as string
      return new Response(
        JSON.stringify({
          type: 'usage-response',
          usage: 0,
          remainingBalance: 100,
          next_quota_reset: null,
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    await fetchUsageData({ authToken: 'my-auth-token' })

    expect(capturedBody).toBeDefined()
    const parsed = JSON.parse(capturedBody!)
    expect(parsed.fingerprintId).toBe('cli-usage')
    expect(parsed.authToken).toBe('my-auth-token')
  })

  test('should call correct API endpoint', async () => {
    let capturedUrl: string | undefined

    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url
      return new Response(
        JSON.stringify({
          type: 'usage-response',
          usage: 0,
          remainingBalance: 100,
          next_quota_reset: null,
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    await fetchUsageData({
      authToken: 'test-token',
      clientEnv: {
        NEXT_PUBLIC_CODEBUFF_APP_URL: 'https://test.codebuff.local',
      } as ClientEnv,
    })

    expect(capturedUrl).toBe('https://test.codebuff.local/api/v1/usage')
  })

  test('should log error on failed request', async () => {
    globalThis.fetch = mock(
      async () => new Response('Server Error', { status: 503 }),
    ) as unknown as typeof fetch

    const mockLogger = createMockLogger()

    await expect(
      fetchUsageData({ authToken: 'test-token', logger: mockLogger }),
    ).rejects.toThrow()

    expect(mockLogger.error).toHaveBeenCalledWith(
      { status: 503 },
      'Failed to fetch usage data from API',
    )
  })
})

describe('usageQueryKeys', () => {
  test('all returns base query key', () => {
    expect(usageQueryKeys.all).toEqual(['usage'])
  })

  test('current returns extended query key', () => {
    expect(usageQueryKeys.current()).toEqual(['usage', 'current'])
  })

  test('current returns new array instance each call', () => {
    const first = usageQueryKeys.current()
    const second = usageQueryKeys.current()
    expect(first).not.toBe(second)
    expect(first).toEqual(second)
  })

  test('query keys can be used for cache operations', () => {
    const mockData = {
      type: 'usage-response' as const,
      usage: 50,
      remainingBalance: 200,
      next_quota_reset: null,
    }

    setActivityQueryData(usageQueryKeys.current(), mockData)
    expect(
      getActivityQueryData<typeof mockData>(usageQueryKeys.current()),
    ).toEqual(mockData)
  })
})

describe('usage query invalidation', () => {

  afterEach(() => {
    mock.restore()
    resetActivityQueryCache()
  })

  test('invalidating usage query preserves cached data', () => {
    const mockData = {
      type: 'usage-response' as const,
      usage: 100,
      remainingBalance: 500,
      next_quota_reset: '2024-02-01T00:00:00.000Z',
    }

    // Pre-populate cache
    setActivityQueryData(usageQueryKeys.current(), mockData)
    expect(
      getActivityQueryData<typeof mockData>(usageQueryKeys.current()),
    ).toEqual(mockData)

    invalidateActivityQuery(usageQueryKeys.current())

    // Data should still exist (invalidation doesn't remove data)
    expect(
      getActivityQueryData<typeof mockData>(usageQueryKeys.current()),
    ).toEqual(mockData)
  })

  test('invalidation marks data as stale for refetching', () => {
    const mockData = {
      type: 'usage-response' as const,
      usage: 200,
      remainingBalance: 300,
      next_quota_reset: '2024-03-01T00:00:00.000Z',
    }

    setActivityQueryData(usageQueryKeys.current(), mockData)
    invalidateActivityQuery(usageQueryKeys.current())

    // Data is still accessible (stale but usable)
    const cached = getActivityQueryData<typeof mockData>(
      usageQueryKeys.current(),
    )
    expect(cached?.usage).toBe(200)
    expect(cached?.remainingBalance).toBe(300)
  })
})

describe('usage query cache behavior', () => {
  afterEach(() => {
    mock.restore()
    resetActivityQueryCache()
  })

  test('should store and retrieve usage data from cache', () => {
    const mockData = {
      type: 'usage-response' as const,
      usage: 100,
      remainingBalance: 500,
      next_quota_reset: '2024-02-01T00:00:00.000Z',
    }

    setActivityQueryData(usageQueryKeys.current(), mockData)
    expect(
      getActivityQueryData<typeof mockData>(usageQueryKeys.current()),
    ).toEqual(mockData)
  })

  test('should update cache when new data is set', () => {
    const initialData = {
      type: 'usage-response' as const,
      usage: 100,
      remainingBalance: 500,
      next_quota_reset: '2024-02-01T00:00:00.000Z',
    }

    const updatedData = {
      type: 'usage-response' as const,
      usage: 150,
      remainingBalance: 450,
      next_quota_reset: '2024-02-01T00:00:00.000Z',
    }

    setActivityQueryData(usageQueryKeys.current(), initialData)
    expect(
      getActivityQueryData<typeof initialData>(usageQueryKeys.current())?.usage,
    ).toBe(100)

    setActivityQueryData(usageQueryKeys.current(), updatedData)
    expect(
      getActivityQueryData<typeof initialData>(usageQueryKeys.current())?.usage,
    ).toBe(150)
  })

  test('should preserve data after invalidation', () => {
    const mockData = {
      type: 'usage-response' as const,
      usage: 100,
      remainingBalance: 500,
      next_quota_reset: '2024-02-01T00:00:00.000Z',
    }

    setActivityQueryData(usageQueryKeys.current(), mockData)
    invalidateActivityQuery(usageQueryKeys.current())

    // Data should still be accessible
    const cached = getActivityQueryData<typeof mockData>(
      usageQueryKeys.current(),
    )
    expect(cached).toEqual(mockData)
  })

  test('should handle cache removal', () => {
    const mockData = {
      type: 'usage-response' as const,
      usage: 100,
      remainingBalance: 500,
      next_quota_reset: '2024-02-01T00:00:00.000Z',
    }

    setActivityQueryData(usageQueryKeys.current(), mockData)
    expect(
      getActivityQueryData<typeof mockData>(usageQueryKeys.current()),
    ).toBeDefined()

    removeActivityQuery(usageQueryKeys.current())
    expect(
      getActivityQueryData<typeof mockData>(usageQueryKeys.current()),
    ).toBeUndefined()
  })

  test('should handle balance breakdown with all credit types', () => {
    const mockData = {
      type: 'usage-response' as const,
      usage: 500,
      remainingBalance: 1500,
      balanceBreakdown: {
        free: 300,
        paid: 700,
        ad: 200,
        referral: 200,
        admin: 100,
      },
      next_quota_reset: '2024-02-15T00:00:00.000Z',
    }

    setActivityQueryData(usageQueryKeys.current(), mockData)
    const cached = getActivityQueryData<typeof mockData>(
      usageQueryKeys.current(),
    )

    expect(cached?.balanceBreakdown?.free).toBe(300)
    expect(cached?.balanceBreakdown?.paid).toBe(700)
    expect(cached?.balanceBreakdown?.ad).toBe(200)
    expect(cached?.balanceBreakdown?.referral).toBe(200)
    expect(cached?.balanceBreakdown?.admin).toBe(100)
  })

  test('should handle zero and null values correctly', () => {
    const mockData = {
      type: 'usage-response' as const,
      usage: 0,
      remainingBalance: 0,
      balanceBreakdown: { free: 0, paid: 0 },
      next_quota_reset: null,
    }

    setActivityQueryData(usageQueryKeys.current(), mockData)
    const cached = getActivityQueryData<typeof mockData>(
      usageQueryKeys.current(),
    )

    expect(cached?.usage).toBe(0)
    expect(cached?.remainingBalance).toBe(0)
    expect(cached?.next_quota_reset).toBeNull()
  })

  test('reset clears usage cache', () => {
    const mockData = {
      type: 'usage-response' as const,
      usage: 100,
      remainingBalance: 500,
      next_quota_reset: null,
    }

    setActivityQueryData(usageQueryKeys.current(), mockData)
    expect(
      getActivityQueryData<typeof mockData>(usageQueryKeys.current()),
    ).toBeDefined()

    resetActivityQueryCache()
    expect(
      getActivityQueryData<typeof mockData>(usageQueryKeys.current()),
    ).toBeUndefined()
  })

  test('multiple invalidations preserve data', () => {
    const mockData = {
      type: 'usage-response' as const,
      usage: 100,
      remainingBalance: 500,
      next_quota_reset: '2024-02-01T00:00:00.000Z',
    }

    setActivityQueryData(usageQueryKeys.current(), mockData)

    // Invalidate multiple times
    invalidateActivityQuery(usageQueryKeys.current())
    invalidateActivityQuery(usageQueryKeys.current())
    invalidateActivityQuery(usageQueryKeys.current())

    // Data should still be there
    expect(
      getActivityQueryData<typeof mockData>(usageQueryKeys.current()),
    ).toEqual(mockData)
  })
})
