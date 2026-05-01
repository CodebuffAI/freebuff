import { afterEach, beforeEach, describe, expect, mock, it } from 'bun:test'
import { NextRequest } from 'next/server'

import {
  FREEBUFF_GEMINI_PRO_MODEL_ID,
  FREEBUFF_GLM_MODEL_ID,
  isFreebuffDeploymentHours,
} from '@codebuff/common/constants/freebuff-models'
import { env } from '@codebuff/internal/env'
import { formatQuotaResetCountdown, postChatCompletions } from '../_post'
import {
  checkFreeModeRateLimit,
  resetFreeModeRateLimits,
} from '../free-mode-rate-limiter'

import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type { InsertMessageBigqueryFn } from '@codebuff/common/types/contracts/bigquery'
import type { GetUserUsageDataFn } from '@codebuff/common/types/contracts/billing'
import type {
  GetAgentRunFromIdFn,
  GetUserInfoFromApiKeyFn,
} from '@codebuff/common/types/contracts/database'
import type {
  Logger,
  LoggerWithContextFn,
} from '@codebuff/common/types/contracts/logger'
import type { BlockGrantResult } from '@codebuff/billing/subscription'
import type { GetUserPreferencesFn } from '../_post'

describe('/api/v1/chat/completions POST endpoint', () => {
  const mockUserData: Record<string, { id: string; banned: boolean }> = {
    'test-api-key-123': {
      id: 'user-123',
      banned: false,
    },
    'test-api-key-no-credits': {
      id: 'user-no-credits',
      banned: false,
    },
    'test-api-key-blocked': {
      id: 'banned-user-id',
      banned: true,
    },
    'test-api-key-new-free': {
      id: 'user-new-free',
      banned: false,
    },
    'test-api-key-new-free-gemini': {
      id: 'user-new-free-gemini',
      banned: false,
    },
  }

  const mockGetUserInfoFromApiKey: GetUserInfoFromApiKeyFn = async ({
    apiKey,
  }) => {
    const userData = mockUserData[apiKey]
    if (!userData) {
      return null
    }
    return {
      id: userData.id,
      banned: userData.banned,
    } as Awaited<ReturnType<GetUserInfoFromApiKeyFn>>
  }

  let mockLogger: Logger
  let mockLoggerWithContext: LoggerWithContextFn
  let mockTrackEvent: TrackEventFn
  let mockGetUserUsageData: GetUserUsageDataFn
  let mockGetAgentRunFromId: GetAgentRunFromIdFn
  let mockFetch: typeof globalThis.fetch
  let mockInsertMessageBigquery: InsertMessageBigqueryFn
  let nextQuotaReset: string

  // Bypasses the freebuff waiting-room gate in tests that exercise free-mode
  // flow without seeding a session. Matches the real return for the disabled
  // path so downstream logic proceeds normally.
  const mockCheckSessionAdmissibleAllow = async () =>
    ({ ok: true, reason: 'disabled' }) as const

  const allowedFreeModeHeaders = (apiKey: string) => ({
    Authorization: `Bearer ${apiKey}`,
    'cf-ipcountry': 'US',
    'cf-connecting-ip': '203.0.113.10',
  })
  // Some provider-path tests can cross Bun's 5s default on loaded CI runners
  // when the mocked network path waits behind unrelated DB reconnect timers.
  const FETCH_PATH_TEST_TIMEOUT_MS = 15000

  beforeEach(() => {
    resetFreeModeRateLimits()
    nextQuotaReset = new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000,
    ).toISOString()

    mockLogger = {
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
      debug: mock(() => {}),
    }

    mockLoggerWithContext = mock(() => mockLogger)

    mockTrackEvent = mock(() => {})

    mockGetUserUsageData = mock(async ({ userId }: { userId: string }) => {
      if (userId === 'user-no-credits') {
        return {
          usageThisCycle: 0,
          balance: {
            totalRemaining: 0,
            totalDebt: 0,
            netBalance: 0,
            breakdown: {},
            principals: {},
          },
          nextQuotaReset,
        }
      }
      return {
        usageThisCycle: 0,
        balance: {
          totalRemaining: 100,
          totalDebt: 0,
          netBalance: 100,
          breakdown: {},
          principals: {},
        },
        nextQuotaReset,
      }
    })

    mockGetAgentRunFromId = mock((async ({ runId }: any) => {
      if (runId === 'run-123') {
        return {
          agent_id: 'agent-123',
          ancestor_run_ids: [],
          status: 'running',
        }
      }
      if (runId === 'run-free') {
        return {
          // Real free-mode allowlisted agent (see FREE_MODE_AGENT_MODELS).
          agent_id: 'base2-free',
          ancestor_run_ids: [],
          status: 'running',
        }
      }
      if (runId === 'run-reviewer-direct') {
        return {
          agent_id: 'code-reviewer-lite',
          ancestor_run_ids: [],
          status: 'running',
        }
      }
      if (runId === 'run-reviewer-child') {
        return {
          agent_id: 'code-reviewer-lite',
          ancestor_run_ids: ['run-free'],
          status: 'running',
        }
      }
      if (runId === 'run-completed') {
        return {
          agent_id: 'agent-123',
          ancestor_run_ids: [],
          status: 'completed',
        }
      }
      return null
    }) satisfies GetAgentRunFromIdFn)

    // Mock global fetch to return OpenRouter-like responses
    mockFetch = (async (url: any, options: any) => {
      if (String(url).startsWith('https://api.ipinfo.io/lookup/')) {
        return Response.json({})
      }

      if (!options?.body) {
        throw new Error('Missing request body')
      }

      const body = JSON.parse(options.body)

      if (body.stream) {
        // Return streaming response
        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          start(controller) {
            // Simulate OpenRouter SSE format
            controller.enqueue(
              encoder.encode(
                'data: {"id":"test-id","model":"test-model","choices":[{"delta":{"content":"test"}}]}\n\n',
              ),
            )
            controller.enqueue(
              encoder.encode(
                'data: {"id":"test-id","model":"test-model","choices":[{"delta":{"content":" stream"}}]}\n\n',
              ),
            )
            controller.enqueue(
              encoder.encode(
                'data: {"id":"test-id","model":"test-model","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"cost":0.001}}\n\n',
              ),
            )
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          },
        })

        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      } else {
        // Return non-streaming response
        return new Response(
          JSON.stringify({
            id: 'test-id',
            model: 'test-model',
            choices: [{ message: { content: 'test response' } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 20,
              total_tokens: 30,
              cost: 0.001,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }
    }) as typeof globalThis.fetch

    mockInsertMessageBigquery = mock(async () => true)
  })

  afterEach(() => {
    mock.restore()
  })

  describe('Authentication', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          body: JSON.stringify({ stream: true }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: globalThis.fetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(401)
      const body = await response.json()
      expect(body).toEqual({ message: 'Unauthorized' })
    })

    it('returns 401 when API key is invalid', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer invalid-key' },
          body: JSON.stringify({ stream: true }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(401)
      const body = await response.json()
      expect(body).toEqual({ message: 'Invalid Codebuff API key' })
    })
  })

  describe('Request body validation', () => {
    it('returns 400 when body is not valid JSON', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer test-api-key-123' },
          body: 'not json',
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body).toEqual({ message: 'Invalid JSON in request body' })
    })

    it('returns 400 when run_id is missing', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer test-api-key-123' },
          body: JSON.stringify({ stream: true }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body).toEqual({ message: 'No runId found in request body' })
    })

    it('returns 400 when agent run not found', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer test-api-key-123' },
          body: JSON.stringify({
            stream: true,
            codebuff_metadata: { run_id: 'run-nonexistent' },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body).toEqual({
        message: 'runId Not Found: run-nonexistent',
      })
    })

    it('returns 400 when agent run is not running', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer test-api-key-123' },
          body: JSON.stringify({
            stream: true,
            codebuff_metadata: { run_id: 'run-completed' },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body).toEqual({
        message: 'runId Not Running: run-completed',
      })
    })
  })

  describe('Banned users', () => {
    it('returns 403 with clear message for banned users', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer test-api-key-blocked' },
          body: JSON.stringify({
            stream: true,
            codebuff_metadata: { run_id: 'run-123' },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('account_suspended')
      expect(body.message).toContain('Your account has been suspended')
      expect(body.message).toContain('if you did not expect this')
    })
  })

  describe('Credit validation', () => {
    it('returns 402 when user has insufficient credits', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer test-api-key-no-credits' },
          body: JSON.stringify({
            stream: true,
            codebuff_metadata: { run_id: 'run-123' },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(402)
      const body = await response.json()
      const expectedResetCountdown = formatQuotaResetCountdown(nextQuotaReset)
      expect(body.message).toContain(expectedResetCountdown)
      expect(body.message).not.toContain(nextQuotaReset)
    })

    it('lets a new account with no paid relationship through for non-free mode', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer test-api-key-new-free' },
          body: JSON.stringify({
            model: 'test/test-model',
            stream: false,
            codebuff_metadata: {
              run_id: 'run-123',
              client_id: 'test-client-id-123',
            },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(200)
    })

    it('lets a BYOK free-tier new account through the paid-plan gate', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-api-key-new-free',
            'x-openrouter-api-key': 'sk-or-byok-test',
          },
          body: JSON.stringify({
            model: 'test/test-model',
            stream: false,
            codebuff_metadata: {
              run_id: 'run-123',
              client_id: 'test-client-id-123',
            },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(200)
    })

    it('lets a freebuff/free-mode request through even for a brand-new unpaid account', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: allowedFreeModeHeaders('test-api-key-new-free'),
          body: JSON.stringify({
            model: 'minimax/minimax-m2.7',
            stream: false,
            codebuff_metadata: {
              run_id: 'run-free',
              client_id: 'test-client-id-123',
              cost_mode: 'free',
            },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(200)
    })

    it('rejects free-mode requests when location is unknown', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer test-api-key-new-free' },
          body: JSON.stringify({
            model: 'minimax/minimax-m2.7',
            stream: false,
            codebuff_metadata: {
              run_id: 'run-free',
              client_id: 'test-client-id-123',
              cost_mode: 'free',
            },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('free_mode_unavailable')
      expect(body.countryCode).toBe('UNKNOWN')
      expect(body.countryBlockReason).toBe('missing_client_ip')
    })

    it('rejects free-mode requests from anonymized Cloudflare country codes', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-api-key-new-free',
            'cf-ipcountry': 'T1',
            'x-forwarded-for': '8.8.8.8',
          },
          body: JSON.stringify({
            model: 'minimax/minimax-m2.7',
            stream: false,
            codebuff_metadata: {
              run_id: 'run-free',
              client_id: 'test-client-id-123',
              cost_mode: 'free',
            },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('free_mode_unavailable')
      expect(body.countryCode).toBe('UNKNOWN')
      expect(body.countryBlockReason).toBe('anonymized_or_unknown_country')
    })

    it(
      'lets freebuff use Kimi K2.6 through Fireworks availability rules',
      async () => {
        const fetchedBodies: Record<string, unknown>[] = []
        const fetchViaFireworks = mock(
          async (_url: string | URL | Request, init?: RequestInit) => {
            fetchedBodies.push(JSON.parse(init?.body as string))
            return new Response(
              JSON.stringify({
                id: 'test-id',
                model: 'accounts/fireworks/models/kimi-k2p6',
                choices: [{ message: { content: 'test response' } }],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 20,
                  total_tokens: 30,
                },
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              },
            )
          },
        ) as unknown as typeof globalThis.fetch

        const req = new NextRequest(
          'http://localhost:3000/api/v1/chat/completions',
          {
            method: 'POST',
            headers: allowedFreeModeHeaders('test-api-key-new-free'),
            body: JSON.stringify({
              model: 'moonshotai/kimi-k2.6',
              stream: false,
              codebuff_metadata: {
                run_id: 'run-free',
                client_id: 'test-client-id-123',
                cost_mode: 'free',
              },
            }),
          },
        )

        const response = await postChatCompletions({
          req,
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: fetchViaFireworks,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
        })

        const body = await response.json()
        if (isFreebuffDeploymentHours()) {
          expect(response.status).toBe(200)
          expect(fetchedBodies).toHaveLength(1)
          expect(fetchedBodies[0].model).toBe(
            'accounts/fireworks/models/kimi-k2p6',
          )
          expect(body.model).toBe('moonshotai/kimi-k2.6')
          expect(body.provider).toBe('Fireworks')
        } else {
          expect(response.status).toBe(503)
          expect(fetchedBodies).toHaveLength(0)
          expect(body.error.code).toBe('DEPLOYMENT_OUTSIDE_HOURS')
        }
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

    it(
      'lets old freebuff clients keep using GLM 5.1 through Fireworks availability rules',
      async () => {
        const fetchedBodies: Record<string, unknown>[] = []
        const fetchViaFireworks = mock(
          async (_url: string | URL | Request, init?: RequestInit) => {
            fetchedBodies.push(JSON.parse(init?.body as string))
            return new Response(
              JSON.stringify({
                id: 'test-id',
                model: 'accounts/fireworks/models/glm-5p1',
                choices: [{ message: { content: 'test response' } }],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 20,
                  total_tokens: 30,
                },
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              },
            )
          },
        ) as unknown as typeof globalThis.fetch

        const req = new NextRequest(
          'http://localhost:3000/api/v1/chat/completions',
          {
            method: 'POST',
            headers: allowedFreeModeHeaders('test-api-key-new-free'),
            body: JSON.stringify({
              model: FREEBUFF_GLM_MODEL_ID,
              stream: false,
              codebuff_metadata: {
                run_id: 'run-free',
                client_id: 'test-client-id-123',
                cost_mode: 'free',
              },
            }),
          },
        )

        const response = await postChatCompletions({
          req,
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: fetchViaFireworks,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
        })

        const body = await response.json()
        if (isFreebuffDeploymentHours()) {
          expect(response.status).toBe(200)
          expect(fetchedBodies).toHaveLength(1)
          expect(fetchedBodies[0].model).toBe(
            'accounts/fireworks/models/glm-5p1',
          )
          expect(body.model).toBe(FREEBUFF_GLM_MODEL_ID)
          expect(body.provider).toBe('Fireworks')
        } else {
          expect(response.status).toBe(503)
          expect(fetchedBodies).toHaveLength(0)
          expect(body.error.code).toBe('DEPLOYMENT_OUTSIDE_HOURS')
        }
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

    it('lets freebuff use Gemini 3.1 Pro through the free-mode allowlist', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: allowedFreeModeHeaders('test-api-key-new-free-gemini'),
          body: JSON.stringify({
            model: FREEBUFF_GEMINI_PRO_MODEL_ID,
            stream: false,
            codebuff_metadata: {
              run_id: 'run-free',
              client_id: 'test-client-id-123',
              cost_mode: 'free',
            },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(200)
    })

    it('rejects standalone free-mode reviewer runs even when the model is allowlisted', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: allowedFreeModeHeaders('test-api-key-new-free-gemini'),
          body: JSON.stringify({
            model: FREEBUFF_GEMINI_PRO_MODEL_ID,
            stream: false,
            codebuff_metadata: {
              run_id: 'run-reviewer-direct',
              client_id: 'test-client-id-123',
              cost_mode: 'free',
            },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('free_mode_invalid_agent_hierarchy')
    })

    it('counts child reviewer Gemini requests toward the free-mode request limit', async () => {
      const response = await postChatCompletions({
        req: new NextRequest('http://localhost:3000/api/v1/chat/completions', {
          method: 'POST',
          headers: allowedFreeModeHeaders('test-api-key-new-free-gemini'),
          body: JSON.stringify({
            model: FREEBUFF_GEMINI_PRO_MODEL_ID,
            stream: false,
            codebuff_metadata: {
              run_id: 'run-reviewer-child',
              client_id: 'test-client-id-123',
              cost_mode: 'free',
            },
          }),
        }),
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(200)
      expect(checkFreeModeRateLimit('user-new-free-gemini').limited).toBe(false)
      expect(checkFreeModeRateLimit('user-new-free-gemini').limited).toBe(true)
    })

    it(
      'skips credit check when in FREE mode even with 0 credits',
      async () => {
        const req = new NextRequest(
          'http://localhost:3000/api/v1/chat/completions',
          {
            method: 'POST',
            headers: allowedFreeModeHeaders('test-api-key-no-credits'),
            body: JSON.stringify({
              model: 'minimax/minimax-m2.7',
              stream: false,
              codebuff_metadata: {
                run_id: 'run-free',
                client_id: 'test-client-id-123',
                cost_mode: 'free',
              },
            }),
          },
        )

        const response = await postChatCompletions({
          req,
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: mockFetch,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
        })

        expect(response.status).toBe(200)
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

    it('rejects free-mode requests using a non-allowlisted model (e.g. Opus)', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: allowedFreeModeHeaders('test-api-key-new-free'),
          body: JSON.stringify({
            // Expensive model the attacker wants for free.
            model: 'anthropic/claude-4.7-opus',
            stream: true,
            codebuff_metadata: {
              run_id: 'run-free',
              client_id: 'test-client-id-123',
              cost_mode: 'free',
            },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
      })

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('free_mode_invalid_agent_model')
    })

    it('rejects free-mode requests with an allowlisted agent but a model outside its allowed set', async () => {
      // agent=base2-free is allowlisted, but Opus is not in its allowed
      // model set. This is the spoofing variant of the attack where the
      // caller picks a real free-mode agentId to try to sneak past the gate.
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: allowedFreeModeHeaders('test-api-key-new-free'),
          body: JSON.stringify({
            model: 'anthropic/claude-4.7-opus',
            stream: true,
            codebuff_metadata: {
              run_id: 'run-free',
              client_id: 'test-client-id-123',
              cost_mode: 'free',
            },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
      })

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('free_mode_invalid_agent_model')
    })

    it('rejects free-mode requests where agentId is not in the allowlist at all', async () => {
      // run-123 points to agent-123, which is not a free-mode agent.
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: allowedFreeModeHeaders('test-api-key-new-free'),
          body: JSON.stringify({
            model: 'minimax/minimax-m2.7',
            stream: true,
            codebuff_metadata: {
              run_id: 'run-123',
              client_id: 'test-client-id-123',
              cost_mode: 'free',
            },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('free_mode_invalid_agent_model')
    })
  })

  describe('Successful responses', () => {
    const withCanopyWaveApiKey = async (testFn: () => Promise<void>) => {
      const previousCanopyWaveApiKey = env.CANOPYWAVE_API_KEY
      env.CANOPYWAVE_API_KEY = 'test'
      try {
        await testFn()
      } finally {
        env.CANOPYWAVE_API_KEY = previousCanopyWaveApiKey
      }
    }

    const createCanopyWaveFallbackRequest = (stream: boolean) =>
      new NextRequest('http://localhost:3000/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-api-key-123' },
        body: JSON.stringify({
          model: 'minimax/minimax-m2.5',
          stream,
          codebuff_metadata: {
            run_id: 'run-123',
            client_id: 'test-client-id-123',
            client_request_id: 'test-client-session-id-123',
          },
        }),
      })

    const createCanopyWaveNoWorkersThenFireworksFetch = (stream: boolean) => {
      const fetchedBodies: Record<string, unknown>[] = []
      const fetch = mock(
        async (_url: string | URL | Request, init?: RequestInit) => {
          fetchedBodies.push(JSON.parse(init?.body as string))

          if (fetchedBodies.length === 1) {
            return Response.json(
              {
                error: {
                  message: 'No available workers',
                  code: 'no_available_workers',
                },
              },
              { status: 503 },
            )
          }

          if (!stream) {
            return Response.json({
              id: 'test-id',
              model: 'accounts/fireworks/models/minimax-m2p5',
              choices: [{ message: { content: 'fireworks response' } }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30,
              },
            })
          }

          const encoder = new TextEncoder()
          const fireworksStream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"test-id","model":"accounts/fireworks/models/minimax-m2p5","choices":[{"delta":{"content":"test"}}]}\n\n',
                ),
              )
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            },
          })

          return new Response(fireworksStream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        },
      ) as unknown as typeof globalThis.fetch

      return { fetch, fetchedBodies }
    }

    const postCanopyWaveFallbackRequest = async ({
      fetch,
      stream,
    }: {
      fetch: typeof globalThis.fetch
      stream: boolean
    }) =>
      postChatCompletions({
        req: createCanopyWaveFallbackRequest(stream),
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

    const expectCanopyWaveThenFireworks = (
      fetchedBodies: Record<string, unknown>[],
    ) => {
      expect(fetchedBodies).toHaveLength(2)
      expect(fetchedBodies[0].model).toBe('minimax/minimax-m2.5')
      expect(fetchedBodies[1].model).toBe(
        'accounts/fireworks/models/minimax-m2p5',
      )
      expect(mockLogger.warn).toHaveBeenCalled()
    }

    it('returns stream with correct headers', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer test-api-key-123' },
          body: JSON.stringify({
            stream: true,
            codebuff_metadata: {
              run_id: 'run-123',
              client_id: 'test-client-id-123',
              client_request_id: 'test-client-session-id-123',
            },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      if (response.status !== 200) {
        const errorBody = await response.json()
        console.log('Error response:', errorBody)
      }
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('text/event-stream')
      expect(response.headers.get('Cache-Control')).toBe('no-cache')
      expect(response.headers.get('Connection')).toBe('keep-alive')
    })

    it(
      'returns JSON response for non-streaming requests',
      async () => {
        const req = new NextRequest(
          'http://localhost:3000/api/v1/chat/completions',
          {
            method: 'POST',
            headers: { Authorization: 'Bearer test-api-key-123' },
            body: JSON.stringify({
              model: 'test/test-model',
              stream: false,
              codebuff_metadata: {
                run_id: 'run-123',
                client_id: 'test-client-id-123',
                client_request_id: 'test-client-session-id-123',
              },
            }),
          },
        )

        const response = await postChatCompletions({
          req,
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: mockFetch,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
        })

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toContain(
          'application/json',
        )
        const body = await response.json()
        expect(body.id).toBe('test-id')
        expect(body.choices[0].message.content).toBe('test response')
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

    it(
      'falls back to Fireworks when CanopyWave has no available workers for non-streaming requests',
      async () => {
        await withCanopyWaveApiKey(async () => {
          const { fetch, fetchedBodies } =
            createCanopyWaveNoWorkersThenFireworksFetch(false)
          const response = await postCanopyWaveFallbackRequest({
            fetch,
            stream: false,
          })

          expect(response.status).toBe(200)
          expectCanopyWaveThenFireworks(fetchedBodies)

          const body = await response.json()
          expect(body.model).toBe('minimax/minimax-m2.5')
          expect(body.provider).toBe('Fireworks')
          expect(body.choices[0].message.content).toBe('fireworks response')
        })
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

    it(
      'falls back to Fireworks when CanopyWave has no available workers for streaming requests',
      async () => {
        await withCanopyWaveApiKey(async () => {
          const { fetch, fetchedBodies } =
            createCanopyWaveNoWorkersThenFireworksFetch(true)
          const response = await postCanopyWaveFallbackRequest({
            fetch,
            stream: true,
          })

          expect(response.status).toBe(200)
          expect(response.headers.get('Content-Type')).toBe('text/event-stream')
          expectCanopyWaveThenFireworks(fetchedBodies)
        })
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )
  })

  describe('Subscription limit enforcement', () => {
    // Bumped from Bun's 5s default: the non-streaming fetch-path tests here
    // have flaked right at the boundary (observed 5001ms) on loaded machines.
    const SUBSCRIPTION_TEST_TIMEOUT_MS = 15000

    const createValidRequest = () =>
      new NextRequest('http://localhost:3000/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-api-key-123' },
        body: JSON.stringify({
          model: 'test/test-model',
          stream: false,
          codebuff_metadata: {
            run_id: 'run-123',
            client_id: 'test-client-id-123',
            client_request_id: 'test-client-session-id-123',
          },
        }),
      })

    it(
      'returns 429 when weekly limit reached and fallback disabled',
      async () => {
        const weeklyLimitError: BlockGrantResult = {
          error: 'weekly_limit_reached',
          used: 3500,
          limit: 3500,
          resetsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        }
        const mockEnsureSubscriberBlockGrant = mock(
          async () => weeklyLimitError,
        )
        const mockGetUserPreferences: GetUserPreferencesFn = mock(async () => ({
          fallbackToALaCarte: false,
        }))

        const response = await postChatCompletions({
          req: createValidRequest(),
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: mockFetch,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          ensureSubscriberBlockGrant: mockEnsureSubscriberBlockGrant,
          getUserPreferences: mockGetUserPreferences,
          checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
        })

        expect(response.status).toBe(429)
        const body = await response.json()
        expect(body.error).toBe('rate_limit_exceeded')
        expect(body.message).toContain('weekly limit reached')
        expect(body.message).toContain('Enable "Continue with credits"')
      },
      SUBSCRIPTION_TEST_TIMEOUT_MS,
    )

    it(
      'skips subscription limit check when in FREE mode even with fallback disabled',
      async () => {
        const weeklyLimitError: BlockGrantResult = {
          error: 'weekly_limit_reached',
          used: 3500,
          limit: 3500,
          resetsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        }
        const mockEnsureSubscriberBlockGrant = mock(
          async () => weeklyLimitError,
        )
        const mockGetUserPreferences: GetUserPreferencesFn = mock(async () => ({
          fallbackToALaCarte: false,
        }))

        const freeModeRequest = new NextRequest(
          'http://localhost:3000/api/v1/chat/completions',
          {
            method: 'POST',
            headers: allowedFreeModeHeaders('test-api-key-123'),
            body: JSON.stringify({
              model: 'minimax/minimax-m2.7',
              stream: false,
              codebuff_metadata: {
                run_id: 'run-free',
                client_id: 'test-client-id-123',
                cost_mode: 'free',
              },
            }),
          },
        )

        const response = await postChatCompletions({
          req: freeModeRequest,
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: mockFetch,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          ensureSubscriberBlockGrant: mockEnsureSubscriberBlockGrant,
          getUserPreferences: mockGetUserPreferences,
          checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
        })

        expect(response.status).toBe(200)
      },
      SUBSCRIPTION_TEST_TIMEOUT_MS,
    )

    it(
      'returns 429 when block exhausted and fallback disabled',
      async () => {
        const blockExhaustedError: BlockGrantResult = {
          error: 'block_exhausted',
          blockUsed: 350,
          blockLimit: 350,
          resetsAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
        }
        const mockEnsureSubscriberBlockGrant = mock(
          async () => blockExhaustedError,
        )
        const mockGetUserPreferences: GetUserPreferencesFn = mock(async () => ({
          fallbackToALaCarte: false,
        }))

        const response = await postChatCompletions({
          req: createValidRequest(),
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: mockFetch,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          ensureSubscriberBlockGrant: mockEnsureSubscriberBlockGrant,
          getUserPreferences: mockGetUserPreferences,
          checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
        })

        expect(response.status).toBe(429)
        const body = await response.json()
        expect(body.error).toBe('rate_limit_exceeded')
        expect(body.message).toContain('5-hour session limit reached')
        expect(body.message).toContain('Enable "Continue with credits"')
      },
      SUBSCRIPTION_TEST_TIMEOUT_MS,
    )

    it(
      'continues when weekly limit reached but fallback is enabled',
      async () => {
        const weeklyLimitError: BlockGrantResult = {
          error: 'weekly_limit_reached',
          used: 3500,
          limit: 3500,
          resetsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        }
        const mockEnsureSubscriberBlockGrant = mock(
          async () => weeklyLimitError,
        )
        const mockGetUserPreferences: GetUserPreferencesFn = mock(async () => ({
          fallbackToALaCarte: true,
        }))

        const response = await postChatCompletions({
          req: createValidRequest(),
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: mockFetch,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          ensureSubscriberBlockGrant: mockEnsureSubscriberBlockGrant,
          getUserPreferences: mockGetUserPreferences,
          checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
        })

        expect(response.status).toBe(200)
        expect(mockLogger.info).toHaveBeenCalled()
      },
      SUBSCRIPTION_TEST_TIMEOUT_MS,
    )

    it(
      'continues when block grant is created successfully',
      async () => {
        const blockGrant: BlockGrantResult = {
          grantId: 'block-123',
          credits: 350,
          expiresAt: new Date(Date.now() + 5 * 60 * 60 * 1000),
          isNew: true,
        }
        const mockEnsureSubscriberBlockGrant = mock(async () => blockGrant)
        const mockGetUserPreferences: GetUserPreferencesFn = mock(async () => ({
          fallbackToALaCarte: false,
        }))

        const response = await postChatCompletions({
          req: createValidRequest(),
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: mockFetch,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          ensureSubscriberBlockGrant: mockEnsureSubscriberBlockGrant,
          getUserPreferences: mockGetUserPreferences,
          checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
        })

        expect(response.status).toBe(200)
        // getUserPreferences should not be called when block grant succeeds
        expect(mockGetUserPreferences).not.toHaveBeenCalled()
      },
      SUBSCRIPTION_TEST_TIMEOUT_MS,
    )

    it.skip('continues when ensureSubscriberBlockGrant throws an error (fail open)', async () => {
      const mockEnsureSubscriberBlockGrant = mock(async () => {
        throw new Error('Database connection failed')
      })
      const mockGetUserPreferences: GetUserPreferencesFn = mock(async () => ({
        fallbackToALaCarte: false,
      }))

      const response = await postChatCompletions({
        req: createValidRequest(),
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        ensureSubscriberBlockGrant: mockEnsureSubscriberBlockGrant,
        getUserPreferences: mockGetUserPreferences,
        checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
      })

      // Should continue processing (fail open)
      expect(response.status).toBe(200)
      expect(mockLogger.error).toHaveBeenCalled()
    })

    it.skip(
      'continues when user is not a subscriber (null result)',
      async () => {
        const mockEnsureSubscriberBlockGrant = mock(async () => null)
        const mockGetUserPreferences: GetUserPreferencesFn = mock(async () => ({
          fallbackToALaCarte: false,
        }))

        const response = await postChatCompletions({
          req: createValidRequest(),
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: mockFetch,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          ensureSubscriberBlockGrant: mockEnsureSubscriberBlockGrant,
          getUserPreferences: mockGetUserPreferences,
          checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
        })

        expect(response.status).toBe(200)
        // getUserPreferences should not be called for non-subscribers
        expect(mockGetUserPreferences).not.toHaveBeenCalled()
      },
      SUBSCRIPTION_TEST_TIMEOUT_MS,
    )

    it.skip(
      'defaults to allowing fallback when getUserPreferences is not provided',
      async () => {
        const weeklyLimitError: BlockGrantResult = {
          error: 'weekly_limit_reached',
          used: 3500,
          limit: 3500,
          resetsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        }
        const mockEnsureSubscriberBlockGrant = mock(
          async () => weeklyLimitError,
        )

        const response = await postChatCompletions({
          req: createValidRequest(),
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: mockFetch,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          ensureSubscriberBlockGrant: mockEnsureSubscriberBlockGrant,
          // Note: getUserPreferences is NOT provided
        })

        // Should continue processing (default to allowing a-la-carte)
        expect(response.status).toBe(200)
      },
      SUBSCRIPTION_TEST_TIMEOUT_MS,
    )

    it.skip('allows subscriber with 0 a-la-carte credits but active block grant', async () => {
      const blockGrant: BlockGrantResult = {
        grantId: 'block-123',
        credits: 350,
        expiresAt: new Date(Date.now() + 5 * 60 * 60 * 1000),
        isNew: true,
      }
      const mockEnsureSubscriberBlockGrant = mock(async () => blockGrant)

      // Override mock: when subscription credits are included, simulate the block grant's credits
      mockGetUserUsageData = mock(
        async ({
          includeSubscriptionCredits,
        }: {
          includeSubscriptionCredits?: boolean
        }) => ({
          usageThisCycle: 0,
          balance: {
            totalRemaining: includeSubscriptionCredits ? 350 : 0,
            totalDebt: 0,
            netBalance: includeSubscriptionCredits ? 350 : 0,
            breakdown: {},
            principals: { subscription: 350 },
          },
          nextQuotaReset,
        }),
      )

      // Use the no-credits user (totalRemaining = 0 without subscription)
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer test-api-key-no-credits' },
          body: JSON.stringify({
            model: 'test/test-model',
            stream: false,
            codebuff_metadata: {
              run_id: 'run-123',
              client_id: 'test-client-id-123',
            },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        ensureSubscriberBlockGrant: mockEnsureSubscriberBlockGrant,
      })

      // Should succeed - subscriber has block grant credits despite 0 a-la-carte credits
      expect(response.status).toBe(200)
    })

    it('returns 402 for non-subscriber with 0 credits when ensureSubscriberBlockGrant returns null', async () => {
      const mockEnsureSubscriberBlockGrant = mock(async () => null)

      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer test-api-key-no-credits' },
          body: JSON.stringify({
            model: 'test/test-model',
            stream: false,
            codebuff_metadata: {
              run_id: 'run-123',
              client_id: 'test-client-id-123',
            },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        ensureSubscriberBlockGrant: mockEnsureSubscriberBlockGrant,
      })

      // Non-subscriber with 0 credits should get 402
      expect(response.status).toBe(402)
    })

    it('does not call ensureSubscriberBlockGrant before validation passes', async () => {
      const mockEnsureSubscriberBlockGrant = mock(async () => null)

      // Request with invalid run_id
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer test-api-key-123' },
          body: JSON.stringify({
            model: 'test/test-model',
            stream: false,
            codebuff_metadata: {
              run_id: 'run-nonexistent',
            },
          }),
        },
      )

      const response = await postChatCompletions({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        ensureSubscriberBlockGrant: mockEnsureSubscriberBlockGrant,
      })

      // Should return 400 for invalid run_id
      expect(response.status).toBe(400)
      // ensureSubscriberBlockGrant should NOT have been called
      expect(mockEnsureSubscriberBlockGrant).not.toHaveBeenCalled()
    })
  })
})
