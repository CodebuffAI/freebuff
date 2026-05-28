import { afterEach, beforeEach, describe, expect, mock, it } from 'bun:test'
import { NextRequest } from 'next/server'

import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { TEST_USER_ID } from '@codebuff/common/constants/paths'
import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  FREEBUFF_GEMINI_PRO_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import { openCodeZenModels } from '@codebuff/common/constants/model-config'
import { postChatCompletions } from '../_post'
import { resetFreeModeRateLimits } from '../free-mode-rate-limiter'
import { getFreeModeCountryAccess } from '@/server/free-mode-country'

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
      id: TEST_USER_ID,
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
    'test-api-key-reviewer-rate-limit': {
      id: 'user-reviewer-rate-limit',
      banned: false,
    },
    'test-api-key-gemini-rate-limit': {
      id: 'user-gemini-rate-limit',
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

  // Bypasses the freebuff session gate in tests that exercise free-mode flow
  // without seeding a session.
  const mockCheckSessionAdmissibleAllow = async () =>
    ({ ok: true, reason: 'active', remainingMs: 60 * 60 * 1000 }) as const
  const mockResolveFreeModeCountryAccess = async (
    _userId: string,
    req: Parameters<typeof getFreeModeCountryAccess>[0],
    options: Parameters<typeof getFreeModeCountryAccess>[1],
  ) => getFreeModeCountryAccess(req, options)
  const postChatCompletionsForTest = (
    params: Parameters<typeof postChatCompletions>[0],
  ) =>
    postChatCompletions({
      resolveFreeModeCountryAccess: mockResolveFreeModeCountryAccess,
      ...params,
    })

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
      if (runId === 'run-free-deepseek') {
        return {
          agent_id: 'base2-free-deepseek',
          ancestor_run_ids: [],
          status: 'running',
        }
      }
      if (runId === 'run-free-deepseek-flash') {
        return {
          agent_id: 'base2-free-deepseek-flash',
          ancestor_run_ids: [],
          status: 'running',
        }
      }
      if (runId === 'run-reviewer-direct') {
        return {
          agent_id: 'code-reviewer-minimax',
          ancestor_run_ids: [],
          status: 'running',
        }
      }
      if (runId === 'run-reviewer-child') {
        return {
          agent_id: 'code-reviewer-minimax',
          ancestor_run_ids: ['run-free'],
          status: 'running',
        }
      }
      if (runId === 'run-gemini-thinker-child') {
        return {
          agent_id: 'thinker-with-files-gemini',
          ancestor_run_ids: ['run-free'],
          status: 'running',
        }
      }
      if (runId === 'run-browser-use-child') {
        return {
          agent_id: 'browser-use',
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

      const response = await postChatCompletionsForTest({
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

      const response = await postChatCompletionsForTest({
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

      const response = await postChatCompletionsForTest({
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

      const response = await postChatCompletionsForTest({
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

      const response = await postChatCompletionsForTest({
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

      const response = await postChatCompletionsForTest({
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

      const response = await postChatCompletionsForTest({
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

      const response = await postChatCompletionsForTest({
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
      expect(body.message).toContain('Out of credits. Please add credits at')
      expect(body.message).toContain('/usage.')
      expect(body.message).not.toContain(nextQuotaReset)
    })

    it(
      'lets a new account with no paid relationship through for non-free mode',
      async () => {
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

        const response = await postChatCompletionsForTest({
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

    it(
      'classifies country access before the active freebuff session gate',
      async () => {
        const req = new NextRequest(
          'http://localhost:3000/api/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer test-api-key-new-free',
              'cf-ipcountry': 'XX',
              'x-forwarded-for': '8.8.8.8',
            },
            body: JSON.stringify({
              model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
              stream: false,
              codebuff_metadata: {
                run_id: 'run-free-deepseek-flash',
                client_id: 'test-client-id-123',
                cost_mode: 'free',
                freebuff_instance_id: 'active-instance-123',
              },
            }),
          },
        )

        const response = await postChatCompletionsForTest({
          req,
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: mockFetch,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          checkSessionAdmissible: async (params) => {
            expect(params.accessTier).toBe('limited')
            return { ok: true, reason: 'active', remainingMs: 60_000 } as const
          },
        })

        expect(response.status).toBe(200)
        expect(mockGetUserUsageData).not.toHaveBeenCalled()
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

    it(
      'puts VPN/proxy privacy signals in limited mode before the session gate',
      async () => {
        const req = new NextRequest(
          'http://localhost:3000/api/v1/chat/completions',
          {
            method: 'POST',
            headers: allowedFreeModeHeaders('test-api-key-new-free'),
            body: JSON.stringify({
              model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
              stream: false,
              codebuff_metadata: {
                run_id: 'run-free-deepseek-flash',
                client_id: 'test-client-id-123',
                cost_mode: 'free',
                freebuff_instance_id: 'active-instance-123',
              },
            }),
          },
        )

        const endFreebuffSession = mock(async () => {})
        const checkSessionAdmissible = mock(async (params) => {
          expect(params.accessTier).toBe('limited')
          return { ok: true, reason: 'active', remainingMs: 60_000 } as const
        })
        const response = await postChatCompletionsForTest({
          req,
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: mockFetch,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          checkSessionAdmissible,
          endFreebuffSession,
          resolveFreeModeCountryAccess: async () => ({
            allowed: false,
            countryCode: 'US',
            blockReason: 'anonymous_network',
            cfCountry: 'US',
            geoipCountry: null,
            ipPrivacy: { signals: ['vpn', 'hosting'] },
            spurIpPrivacy: { signals: ['vpn'] },
            spurStatus: 'suspicious',
            scamalyticsIpPrivacy: null,
            scamalyticsStatus: 'failed',
            scamalyticsScore: null,
            scamalyticsRisk: null,
            hasClientIp: true,
            clientIpHash: 'test-ip-hash',
          }),
        })

        expect(response.status).toBe(200)
        expect(endFreebuffSession).not.toHaveBeenCalled()
        expect(checkSessionAdmissible).toHaveBeenCalledTimes(1)
        const validationEvent = (
          mockTrackEvent as ReturnType<typeof mock>
        ).mock.calls
          .map(([params]) => params as Parameters<TrackEventFn>[0])
          .find(
            ({ event, properties }) =>
              event === AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR &&
              properties?.error === 'free_mode_not_available_in_country',
          )
        expect(validationEvent?.properties).toMatchObject({
          accessTier: 'limited',
          accessStatus: 'limited',
          countryCode: 'US',
          ipPrivacySignals: ['vpn', 'hosting'],
          spurStatus: 'suspicious',
          privacyDecision: 'scamalytics_failed_limited',
          privacyProviderDecision: 'scamalytics_failed',
          privacyHardBlocked: false,
        })
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

    it(
      'includes full freebuff access tier on successful usage analytics',
      async () => {
        const originalRandom = Math.random
        Math.random = () => 0
        try {
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

          const response = await postChatCompletionsForTest({
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

          const trackedEvents = (
            mockTrackEvent as ReturnType<typeof mock>
          ).mock.calls.map(([params]) => params as Parameters<TrackEventFn>[0])
          const requestEvent = trackedEvents.find(
            ({ event }) => event === AnalyticsEvent.CHAT_COMPLETIONS_REQUEST,
          )
          const generationEvent = trackedEvents.find(
            ({ event }) =>
              event === AnalyticsEvent.CHAT_COMPLETIONS_GENERATION_STARTED,
          )

          expect(requestEvent?.properties).toMatchObject({
            freebuff: true,
            accessTier: 'full',
            privacyDecision: 'allowed_clean',
            privacyProviderDecision: 'ipinfo_clean',
            privacyHardBlocked: false,
            spurStatus: 'not_checked',
          })
          expect(generationEvent?.properties).toMatchObject({
            freebuff: true,
            accessTier: 'full',
            privacyDecision: 'allowed_clean',
            privacyProviderDecision: 'ipinfo_clean',
            privacyHardBlocked: false,
            spurStatus: 'not_checked',
          })
        } finally {
          Math.random = originalRandom
        }
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

    it(
      'lets a BYOK free-tier new account through the paid-plan gate',
      async () => {
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

        const response = await postChatCompletionsForTest({
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

    it(
      'lets a freebuff/free-mode request through even for a brand-new unpaid account',
      async () => {
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

        const response = await postChatCompletionsForTest({
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

    it('limits unknown-location free-mode requests to DeepSeek Flash', async () => {
      const checkSessionAdmissible = mock(async () => {
        throw new Error(
          'limited model enforcement should run before session gate',
        )
      })
      // Use a TEST-NET-1 IP (RFC 5737) that geoip-lite cannot resolve, with
      // no cf-ipcountry header. This avoids the dev-only localhost bypass
      // (which kicks in when there is no cf-ipcountry AND no/loopback IP).
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-api-key-new-free',
            'cf-connecting-ip': '192.0.2.1',
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

      const response = await postChatCompletionsForTest({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible,
      })

      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.error).toBe('session_model_mismatch')
      expect(checkSessionAdmissible).toHaveBeenCalledTimes(0)
      const validationEvent = (
        mockTrackEvent as ReturnType<typeof mock>
      ).mock.calls
        .map(([params]) => params as Parameters<TrackEventFn>[0])
        .find(
          ({ event, properties }) =>
            event === AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR &&
            properties?.error === 'session_model_mismatch',
        )
      expect(validationEvent?.properties).toMatchObject({
        freebuff: true,
        accessTier: 'limited',
      })
    })

    it('classifies anonymized Cloudflare country codes as limited access', async () => {
      const checkSessionAdmissible = mock(async () => {
        throw new Error(
          'limited model enforcement should run before session gate',
        )
      })
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-api-key-new-free',
            'cf-ipcountry': 'XX',
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

      const response = await postChatCompletionsForTest({
        req,
        getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
        logger: mockLogger,
        trackEvent: mockTrackEvent,
        getUserUsageData: mockGetUserUsageData,
        getAgentRunFromId: mockGetAgentRunFromId,
        fetch: mockFetch,
        insertMessageBigquery: mockInsertMessageBigquery,
        loggerWithContext: mockLoggerWithContext,
        checkSessionAdmissible,
      })

      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.error).toBe('session_model_mismatch')
      expect(checkSessionAdmissible).toHaveBeenCalledTimes(0)
    })

    it(
      'rejects removed GLM 5.1 for free mode before provider calls',
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
              model: 'z-ai/glm-5.1',
              stream: false,
              codebuff_metadata: {
                run_id: 'run-free',
                client_id: 'test-client-id-123',
                cost_mode: 'free',
              },
            }),
          },
        )

        const response = await postChatCompletionsForTest({
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
        expect(response.status).toBe(403)
        expect(fetchedBodies).toHaveLength(0)
        expect(body.error).toBe('free_mode_invalid_agent_model')
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

    it.each([
      {
        codebuffModel: FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
        upstreamModel: 'deepseek-v4-pro',
        runId: 'run-free-deepseek',
      },
      {
        codebuffModel: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
        upstreamModel: 'deepseek-v4-flash',
        runId: 'run-free-deepseek-flash',
      },
    ])(
      'lets $codebuffModel use the direct DeepSeek provider',
      async ({ codebuffModel, upstreamModel, runId }) => {
        const fetchedBodies: Record<string, unknown>[] = []
        const fetchedUrls: string[] = []
        const fetchViaDeepSeek = mock(
          async (url: string | URL | Request, init?: RequestInit) => {
            if (String(url).startsWith('https://api.ipinfo.io/lookup/')) {
              return Response.json({})
            }

            fetchedUrls.push(String(url))
            fetchedBodies.push(JSON.parse(init?.body as string))
            return new Response(
              JSON.stringify({
                id: 'test-id',
                model: upstreamModel,
                choices: [{ message: { content: 'test response' } }],
                usage: {
                  prompt_tokens: 10,
                  prompt_cache_hit_tokens: 4,
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
              model: codebuffModel,
              stream: false,
              codebuff_metadata: {
                run_id: runId,
                client_id: 'test-client-id-123',
                cost_mode: 'free',
              },
            }),
          },
        )

        const response = await postChatCompletionsForTest({
          req,
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: fetchViaDeepSeek,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
        })

        const body = await response.json()
        expect(response.status).toBe(200)
        expect(fetchedUrls[0]).toBe('https://api.deepseek.com/chat/completions')
        expect(fetchedBodies[0].model).toBe(upstreamModel)
        expect(body.model).toBe(codebuffModel)
        expect(body.provider).toBe('DeepSeek')
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

    it(
      'routes OpenCode Zen models and existing Kimi alias to the direct OpenCode Zen provider',
      async () => {
        const testCases = [
          {
            codebuffModel: 'moonshotai/kimi-k2.6',
            upstreamModel: 'kimi-k2.6',
          },
          {
            codebuffModel: openCodeZenModels.opencode_kimi_k2_6,
            upstreamModel: 'kimi-k2.6',
          },
          {
            codebuffModel: openCodeZenModels.opencode_minimax_m2_7,
            upstreamModel: 'minimax-m2.7',
          },
        ]

        for (const { codebuffModel, upstreamModel } of testCases) {
          const fetchedBodies: Record<string, unknown>[] = []
          const fetchedUrls: string[] = []
          const fetchViaOpenCodeZen = mock(
            async (url: string | URL | Request, init?: RequestInit) => {
              if (String(url).startsWith('https://api.ipinfo.io/lookup/')) {
                return Response.json({})
              }

              fetchedUrls.push(String(url))
              fetchedBodies.push(JSON.parse(init?.body as string))
              return new Response(
                JSON.stringify({
                  id: 'test-id',
                  model: upstreamModel,
                  choices: [{ message: { content: 'test response' } }],
                  usage: {
                    prompt_tokens: 10,
                    prompt_tokens_details: { cached_tokens: 4 },
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
              headers: {
                Authorization: 'Bearer test-api-key-123',
              },
              body: JSON.stringify({
                model: codebuffModel,
                messages: [
                  {
                    role: 'system',
                    content: 'system prompt',
                    cache_control: { type: 'ephemeral' },
                  },
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: 'hello',
                        cache_control: { type: 'ephemeral' },
                      },
                    ],
                  },
                ],
                tools: [
                  {
                    id: 'tool_1',
                    type: 'function',
                    function: {
                      name: 'read_files',
                      parameters: { type: 'object' },
                    },
                  },
                ],
                stream: false,
                codebuff_metadata: {
                  run_id: 'run-123',
                  client_id: 'test-client-id-123',
                },
              }),
            },
          )

          const response = await postChatCompletionsForTest({
            req,
            getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
            logger: mockLogger,
            trackEvent: mockTrackEvent,
            getUserUsageData: mockGetUserUsageData,
            getAgentRunFromId: mockGetAgentRunFromId,
            fetch: fetchViaOpenCodeZen,
            insertMessageBigquery: mockInsertMessageBigquery,
            loggerWithContext: mockLoggerWithContext,
          })

          const body = await response.json()
          expect(response.status).toBe(200)
          expect(fetchedUrls[0]).toBe(
            'https://opencode.ai/zen/v1/chat/completions',
          )
          expect(fetchedBodies[0].model).toBe(upstreamModel)
          expect(body.model).toBe(codebuffModel)
          expect(body.provider).toBe('OpenCode Zen')
        }
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

    it(
      'rejects unsupported OpenCode Zen-prefixed models without calling the provider',
      async () => {
        const fetchViaOpenCodeZen = mock(
          async (url: string | URL | Request) => {
            if (String(url).startsWith('https://api.ipinfo.io/lookup/')) {
              return Response.json({})
            }

            throw new Error('OpenCode Zen provider should not be called')
          },
        ) as unknown as typeof globalThis.fetch

        const req = new NextRequest(
          'http://localhost:3000/api/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer test-api-key-123',
            },
            body: JSON.stringify({
              model: 'opencode/qwen3-coder',
              messages: [{ role: 'user', content: 'hello' }],
              stream: false,
              codebuff_metadata: {
                run_id: 'run-123',
                client_id: 'test-client-id-123',
              },
            }),
          },
        )

        const response = await postChatCompletionsForTest({
          req,
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: fetchViaOpenCodeZen,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
        })

        const body = await response.json()
        expect(response.status).toBe(400)
        expect(body.error.code).toBe('unsupported_model')
        expect(body.error.message).toContain('opencode/qwen3-coder')
        expect(fetchViaOpenCodeZen).toHaveBeenCalledTimes(0)
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

    it('rejects the DeepSeek V4 free agent when it requests another free model', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: allowedFreeModeHeaders('test-api-key-new-free'),
          body: JSON.stringify({
            model: FREEBUFF_GEMINI_PRO_MODEL_ID,
            stream: false,
            codebuff_metadata: {
              run_id: 'run-free-deepseek',
              client_id: 'test-client-id-123',
              cost_mode: 'free',
            },
          }),
        },
      )

      const response = await postChatCompletionsForTest({
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

      const body = await response.json()
      expect(response.status).toBe(403)
      expect(body.error).toBe('free_mode_invalid_agent_model')
    })

    it('rejects Gemini 3.1 Pro as a root freebuff model', async () => {
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

      const response = await postChatCompletionsForTest({
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

      const body = await response.json()
      expect(response.status).toBe(403)
      expect(body.error).toBe('free_mode_invalid_agent_model')
    })

    it(
      'allows browser-use as a free-mode subagent under a freebuff root',
      async () => {
        const req = new NextRequest(
          'http://localhost:3000/api/v1/chat/completions',
          {
            method: 'POST',
            headers: allowedFreeModeHeaders('test-api-key-new-free-gemini'),
            body: JSON.stringify({
              model: 'google/gemini-3.1-flash-lite-preview',
              stream: false,
              codebuff_metadata: {
                run_id: 'run-browser-use-child',
                client_id: 'test-client-id-123',
                cost_mode: 'free',
              },
            }),
          },
        )

        const response = await postChatCompletionsForTest({
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

    it('rejects standalone free-mode reviewer runs even when the model is allowlisted', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/v1/chat/completions',
        {
          method: 'POST',
          headers: allowedFreeModeHeaders('test-api-key-new-free-gemini'),
          body: JSON.stringify({
            model: 'minimax/minimax-m2.7',
            stream: false,
            codebuff_metadata: {
              run_id: 'run-reviewer-direct',
              client_id: 'test-client-id-123',
              cost_mode: 'free',
            },
          }),
        },
      )

      const response = await postChatCompletionsForTest({
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

    it('rejects the Gemini thinker subagent when the session gate rejects it', async () => {
      const response = await postChatCompletionsForTest({
        req: new NextRequest('http://localhost:3000/api/v1/chat/completions', {
          method: 'POST',
          headers: allowedFreeModeHeaders('test-api-key-new-free-gemini'),
          body: JSON.stringify({
            model: FREEBUFF_GEMINI_PRO_MODEL_ID,
            stream: false,
            codebuff_metadata: {
              run_id: 'run-gemini-thinker-child',
              client_id: 'test-client-id-123',
              cost_mode: 'free',
              freebuff_instance_id: 'inst-123',
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
        checkSessionAdmissible: async (params) => {
          expect(params.requireActiveSession).toBe(true)
          expect(params.requestedModel).toBe(FREEBUFF_GEMINI_PRO_MODEL_ID)
          expect(params.claimedInstanceId).toBe('inst-123')
          return {
            ok: false,
            code: 'session_model_mismatch',
            message: 'This session is bound to minimax/minimax-m2.7.',
          }
        },
      })

      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.error).toBe('session_model_mismatch')
    })

    it(
      'requires an active session check for the Gemini thinker subagent',
      async () => {
        const checkFreeModeRateLimitForTest = mock((userId: string) => {
          expect(userId).toBe('user-new-free-gemini')
          return { limited: false as const }
        })

        const response = await postChatCompletionsForTest({
          req: new NextRequest(
            'http://localhost:3000/api/v1/chat/completions',
            {
              method: 'POST',
              headers: allowedFreeModeHeaders('test-api-key-new-free-gemini'),
              body: JSON.stringify({
                model: FREEBUFF_GEMINI_PRO_MODEL_ID,
                stream: false,
                codebuff_metadata: {
                  run_id: 'run-gemini-thinker-child',
                  client_id: 'test-client-id-123',
                  cost_mode: 'free',
                  freebuff_instance_id: 'inst-123',
                },
              }),
            },
          ),
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: mockFetch,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          checkSessionAdmissible: async (params) => {
            expect(params.requireActiveSession).toBe(true)
            expect(params.requestedModel).toBe(FREEBUFF_GEMINI_PRO_MODEL_ID)
            expect(params.claimedInstanceId).toBe('inst-123')
            return { ok: true, reason: 'active', remainingMs: 60_000 }
          },
          checkFreeModeRateLimit: checkFreeModeRateLimitForTest,
        })

        expect(response.status).toBe(200)
        expect(checkFreeModeRateLimitForTest).toHaveBeenCalledTimes(1)
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

    it(
      'counts child Gemini thinker requests toward the free-mode request limit',
      async () => {
        let rateLimitChecks = 0
        const checkFreeModeRateLimitForTest = mock((userId: string) => {
          expect(userId).toBe('user-gemini-rate-limit')
          rateLimitChecks += 1
          return rateLimitChecks === 1
            ? { limited: false as const }
            : {
                limited: true as const,
                windowName: '1 second',
                retryAfterMs: 1_000,
              }
        })

        const createRequest = () =>
          new NextRequest('http://localhost:3000/api/v1/chat/completions', {
            method: 'POST',
            headers: allowedFreeModeHeaders('test-api-key-gemini-rate-limit'),
            body: JSON.stringify({
              model: FREEBUFF_GEMINI_PRO_MODEL_ID,
              stream: false,
              codebuff_metadata: {
                run_id: 'run-gemini-thinker-child',
                client_id: 'test-client-id-123',
                cost_mode: 'free',
                freebuff_instance_id: 'inst-123',
              },
            }),
          })

        const createPostParams = () => ({
          req: createRequest(),
          getUserInfoFromApiKey: mockGetUserInfoFromApiKey,
          logger: mockLogger,
          trackEvent: mockTrackEvent,
          getUserUsageData: mockGetUserUsageData,
          getAgentRunFromId: mockGetAgentRunFromId,
          fetch: mockFetch,
          insertMessageBigquery: mockInsertMessageBigquery,
          loggerWithContext: mockLoggerWithContext,
          checkSessionAdmissible: mockCheckSessionAdmissibleAllow,
          checkFreeModeRateLimit: checkFreeModeRateLimitForTest,
        })

        const firstResponse =
          await postChatCompletionsForTest(createPostParams())
        const limitedResponse =
          await postChatCompletionsForTest(createPostParams())

        expect(firstResponse.status).toBe(200)
        expect(limitedResponse.status).toBe(429)
        const body = await limitedResponse.json()
        expect(body.error).toBe('free_mode_rate_limited')
        expect(checkFreeModeRateLimitForTest).toHaveBeenCalledTimes(2)
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

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

        const response = await postChatCompletionsForTest({
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

      const response = await postChatCompletionsForTest({
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

      const response = await postChatCompletionsForTest({
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

      const response = await postChatCompletionsForTest({
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
    it(
      'returns stream with correct headers',
      async () => {
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

        const response = await postChatCompletionsForTest({
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
        expect(await response.text()).toContain(' stream')
      },
      FETCH_PATH_TEST_TIMEOUT_MS,
    )

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

        const response = await postChatCompletionsForTest({
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

        const response = await postChatCompletionsForTest({
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

        const response = await postChatCompletionsForTest({
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

        const response = await postChatCompletionsForTest({
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

        const response = await postChatCompletionsForTest({
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

        const response = await postChatCompletionsForTest({
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

      const response = await postChatCompletionsForTest({
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

        const response = await postChatCompletionsForTest({
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

        const response = await postChatCompletionsForTest({
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

      const response = await postChatCompletionsForTest({
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

      const response = await postChatCompletionsForTest({
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

      const response = await postChatCompletionsForTest({
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
