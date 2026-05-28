import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { BYOK_OPENROUTER_HEADER } from '@codebuff/common/constants/byok'
import {
  type FreebuffAccessTier,
  FREEBUFF_GEMINI_PRO_MODEL_ID,
  isFreebuffModelAllowedForAccessTier,
  isSupportedFreebuffModelId,
} from '@codebuff/common/constants/freebuff-models'
import {
  isFreebuffGeminiThinkerAgent,
  isFreebuffRootAgent,
  isFreeMode,
  isFreeModeAllowedAgentModel,
} from '@codebuff/common/constants/free-agents'
import { getErrorObject } from '@codebuff/common/util/error'
import { formatFreebuffHardBlockedMessage } from '@codebuff/common/util/freebuff-privacy'
import { pluralize } from '@codebuff/common/util/string'
import { env } from '@codebuff/internal/env'
import { NextResponse } from 'next/server'

import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type {
  InsertChatCompletionTraceBigqueryFn,
  InsertMessageBigqueryFn,
} from '@codebuff/common/types/contracts/bigquery'
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
import {
  isWeeklyLimitError,
  isBlockExhaustedError,
} from '@codebuff/billing/subscription'

export type GetUserPreferencesFn = (params: {
  userId: string
  logger: Logger
}) => Promise<{ fallbackToALaCarte: boolean }>
import type { NextRequest } from 'next/server'

import type { ChatCompletionRequestBody } from '@/llm-api/types'

import { recordChatCompletionTrace } from '@/llm-api/chat-completion-trace'
import { createRequestAuditRecord } from '@/llm-api/helpers'
import {
  CanopyWaveError,
  handleCanopyWaveNonStream,
  handleCanopyWaveStream,
  isCanopyWaveModel,
} from '@/llm-api/canopywave'
import {
  FireworksError,
  handleFireworksNonStream,
  handleFireworksStream,
  isFireworksModel,
} from '@/llm-api/fireworks'
import {
  DeepSeekError,
  handleDeepSeekNonStream,
  handleDeepSeekStream,
  isDeepSeekModel,
} from '@/llm-api/deepseek'
import {
  isLikelyDeepSeekOutage,
  shouldBypassDeepSeek,
} from '@/llm-api/deepseek-health'
import {
  handleMoonshotNonStream,
  handleMoonshotStream,
  isMoonshotModel,
  MoonshotError,
} from '@/llm-api/moonshot'
import {
  OpenCodeZenError,
  handleOpenCodeZenNonStream,
  handleOpenCodeZenStream,
  isOpenCodeZenModel,
} from '@/llm-api/opencode-zen'
import {
  SiliconFlowError,
  handleSiliconFlowNonStream,
  handleSiliconFlowStream,
  isSiliconFlowModel,
} from '@/llm-api/siliconflow'
import {
  handleOpenAINonStream,
  handleOpenAIStream,
  isOpenAIDirectModel,
  OpenAIError,
} from '@/llm-api/openai'
import {
  handleOpenRouterNonStream,
  handleOpenRouterStream,
  OpenRouterError,
} from '@/llm-api/openrouter'
import {
  checkSessionAdmissible,
  endUserSession,
} from '@/server/free-session/public-api'
import { getCachedFreeModeCountryAccess } from '@/server/free-mode-country-access-cache'
import {
  getFreeModeAccessTier,
  getFreeModePrivacyDecision,
  getFreeModePrivacyProviderDecision,
  getFreeModeRiskScore,
  shouldHardBlockFreeModeAccess,
} from '@/server/free-mode-country'

import type { SessionGateResult } from '@/server/free-session/public-api'
import type {
  FreeModeCountryAccess,
  FreeModeCountryAccessOptions,
} from '@/server/free-mode-country'
import { extractApiKeyFromHeader } from '@/util/auth'
import { withDefaultProperties } from '@codebuff/common/analytics'
import { checkFreeModeRateLimit as defaultCheckFreeModeRateLimit } from './free-mode-rate-limiter'
import { beginChatCompletionRequestMetrics } from './request-metrics'

/**
 * Decide whether a failed DeepSeek request should transparently fail over to
 * Fireworks. Pre-stream errors (network/timeout/5xx) on a model that has a
 * known Fireworks fallback are eligible. The circuit-breaker failure was
 * already recorded inside the DeepSeek handler.
 */
function canFailoverDeepSeekToFireworks(
  error: unknown,
  model: string,
): boolean {
  if (!isFireworksModel(model)) return false
  if (error instanceof DeepSeekError) {
    return isLikelyDeepSeekOutage(undefined, error.statusCode)
  }
  return isLikelyDeepSeekOutage(error)
}

export const formatQuotaResetCountdown = (
  nextQuotaReset: string | null | undefined,
): string => {
  if (!nextQuotaReset) {
    return 'soon'
  }

  const resetDate = new Date(nextQuotaReset)
  if (Number.isNaN(resetDate.getTime())) {
    return 'soon'
  }

  const now = Date.now()
  const diffMs = resetDate.getTime() - now
  if (diffMs <= 0) {
    return 'soon'
  }

  const minuteMs = 60 * 1000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs

  const days = Math.floor(diffMs / dayMs)
  if (days > 0) {
    return `in ${pluralize(days, 'day')}`
  }

  const hours = Math.floor(diffMs / hourMs)
  if (hours > 0) {
    return `in ${pluralize(hours, 'hour')}`
  }

  const minutes = Math.max(1, Math.floor(diffMs / minuteMs))
  return `in ${pluralize(minutes, 'minute')}`
}

export type CheckSessionAdmissibleFn = typeof checkSessionAdmissible
export type EndUserSessionFn = typeof endUserSession
export type CheckFreeModeRateLimitFn = typeof defaultCheckFreeModeRateLimit
export type ResolveFreeModeCountryAccessFn = (
  userId: string,
  req: NextRequest,
  options: FreeModeCountryAccessOptions,
) => Promise<FreeModeCountryAccess>

const FREEBUFF_SUCCESS_SAMPLE_RATE = 0.01

function sampleSuccessLogger(logger: Logger, sampled: boolean): Logger {
  if (sampled) return logger
  return {
    ...logger,
    info: (() => {}) as Logger['info'],
    debug: (() => {}) as Logger['debug'],
  }
}

type GateRejectCode = Extract<SessionGateResult, { ok: false }>['code']

const STATUS_BY_GATE_CODE = {
  waiting_room_required: 428,
  waiting_room_queued: 429,
  session_superseded: 409,
  session_expired: 410,
  session_model_mismatch: 409,
  freebuff_update_required: 426,
} satisfies Record<GateRejectCode, number>

function getHardBlockedFreeModeMessage(
  countryAccess: Pick<FreeModeCountryAccess, 'ipPrivacy'>,
): string {
  return formatFreebuffHardBlockedMessage(countryAccess.ipPrivacy?.signals)
}

export async function postChatCompletions(params: {
  req: NextRequest
  getUserInfoFromApiKey: GetUserInfoFromApiKeyFn
  logger: Logger
  loggerWithContext: LoggerWithContextFn
  trackEvent: TrackEventFn
  getUserUsageData: GetUserUsageDataFn
  getAgentRunFromId: GetAgentRunFromIdFn
  fetch: typeof globalThis.fetch
  insertMessageBigquery: InsertMessageBigqueryFn
  insertChatCompletionTraceBigquery?: InsertChatCompletionTraceBigqueryFn
  ensureSubscriberBlockGrant?: (params: {
    userId: string
    logger: Logger
  }) => Promise<BlockGrantResult | null>
  getUserPreferences?: GetUserPreferencesFn
  /** Optional override for the freebuff waiting-room gate. Defaults to the
   *  real check backed by Postgres; tests inject a no-op. */
  checkSessionAdmissible?: CheckSessionAdmissibleFn
  /** Optional override for the free-mode rate limiter. Tests inject this to
   *  avoid coupling to process-global limiter state. */
  checkFreeModeRateLimit?: CheckFreeModeRateLimitFn
  /** Optional override for country/cache checks. Tests inject this to avoid
   *  coupling to Postgres-backed cache state. */
  resolveFreeModeCountryAccess?: ResolveFreeModeCountryAccessFn
  /** Optional override for releasing stale waiting-room rows on hard blocks. */
  endFreebuffSession?: EndUserSessionFn
}) {
  const {
    req,
    getUserInfoFromApiKey,
    loggerWithContext,
    getUserUsageData,
    getAgentRunFromId,
    fetch,
    insertMessageBigquery,
    insertChatCompletionTraceBigquery,
    ensureSubscriberBlockGrant,
    getUserPreferences,
    checkSessionAdmissible: checkSession = checkSessionAdmissible,
    checkFreeModeRateLimit = defaultCheckFreeModeRateLimit,
    resolveFreeModeCountryAccess,
    endFreebuffSession = endUserSession,
  } = params
  let { logger } = params
  let { trackEvent } = params
  const resolveCountryAccess: ResolveFreeModeCountryAccessFn =
    resolveFreeModeCountryAccess ??
    ((userId, req, options) =>
      getCachedFreeModeCountryAccess({ userId, req, options, logger }))

  try {
    // Parse request body
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch (error) {
      trackEvent({
        event: AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR,
        userId: 'unknown',
        properties: {
          error: 'Invalid JSON in request body',
        },
        logger,
      })
      return NextResponse.json(
        { message: 'Invalid JSON in request body' },
        { status: 400 },
      )
    }

    const typedBody = body as unknown as ChatCompletionRequestBody
    const bodyStream = typedBody.stream ?? false
    const runId = typedBody.codebuff_metadata?.run_id

    // Check if the request is in FREE mode (costs 0 credits for allowed agent+model combos)
    const costMode = typedBody.codebuff_metadata?.cost_mode
    const isFreeModeRequest = isFreeMode(costMode)
    const sampleFreebuffSuccess =
      !isFreeModeRequest || Math.random() < FREEBUFF_SUCCESS_SAMPLE_RATE

    const trackSuccessEvent: TrackEventFn = (eventParams) => {
      if (sampleFreebuffSuccess) {
        trackEvent(eventParams)
      }
    }

    trackEvent = withDefaultProperties(trackEvent, {
      freebuff: isFreeModeRequest,
    })

    // Extract and validate API key
    const apiKey = extractApiKeyFromHeader(req)
    if (!apiKey) {
      trackEvent({
        event: AnalyticsEvent.CHAT_COMPLETIONS_AUTH_ERROR,
        userId: 'unknown',
        properties: {
          reason: 'Missing API key',
        },
        logger,
      })
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 })
    }

    // Get user info
    const userInfo = await getUserInfoFromApiKey({
      apiKey,
      fields: ['id', 'email', 'discord_id', 'stripe_customer_id', 'banned'],
      logger,
    })
    if (!userInfo) {
      trackEvent({
        event: AnalyticsEvent.CHAT_COMPLETIONS_AUTH_ERROR,
        userId: 'unknown',
        properties: {
          reason: 'Invalid API key',
        },
        logger,
      })
      return NextResponse.json(
        { message: 'Invalid Codebuff API key' },
        { status: 401 },
      )
    }
    logger = loggerWithContext({ userInfo })

    const userId = userInfo.id
    const stripeCustomerId = userInfo.stripe_customer_id ?? null
    let freebuffAccessTier: FreebuffAccessTier = 'full'

    // Check if user is banned.
    // We use a clear, helpful message rather than a cryptic error because:
    // 1. Legitimate users banned by mistake deserve to know what's happening
    // 2. Bad actors will figure out they're banned regardless of the message
    // 3. Clear messaging encourages resolution (matches our dispute notification email)
    // 4. 403 Forbidden is the correct HTTP status for "you're not allowed"
    if (userInfo.banned) {
      return NextResponse.json(
        {
          error: 'account_suspended',
          message: `Your account has been suspended. Please contact ${env.NEXT_PUBLIC_SUPPORT_EMAIL} if you did not expect this.`,
        },
        { status: 403 },
      )
    }

    // For free mode requests, classify the request into full or limited
    // access. Most non-allowlist/privacy cases, including VPN/proxy traffic,
    // are limited to the cheap DeepSeek Flash path; Cloudflare Tor remains a
    // hard block.
    if (isFreeModeRequest) {
      const countryAccess = await resolveCountryAccess(userId, req, {
        fetch,
        ipinfoToken: env.IPINFO_TOKEN,
        spurToken: env.SPUR_TOKEN,
        scamalyticsApiKey: env.SCAMALYTICS_API_KEY,
        ipHashSecret: env.NEXTAUTH_SECRET,
        allowLocalhost: env.NEXT_PUBLIC_CB_ENVIRONMENT === 'dev',
        forceLimited:
          env.NEXT_PUBLIC_CB_ENVIRONMENT === 'dev' &&
          env.FREEBUFF_DEV_FORCE_LIMITED,
      })
      freebuffAccessTier = getFreeModeAccessTier(countryAccess)
      const hardBlocked = shouldHardBlockFreeModeAccess(countryAccess)
      const privacyDecision = getFreeModePrivacyDecision(countryAccess)
      const privacyProviderDecision =
        getFreeModePrivacyProviderDecision(countryAccess)
      const privacyRiskScore = getFreeModeRiskScore(countryAccess)

      if (!countryAccess.allowed || sampleFreebuffSuccess) {
        logger.info(
          {
            cfHeader: countryAccess.cfCountry,
            geoipResult: countryAccess.geoipCountry,
            resolvedCountry: countryAccess.countryCode,
            countryBlockReason: countryAccess.blockReason,
            ipPrivacySignals: countryAccess.ipPrivacy?.signals,
            spurIpPrivacySignals: countryAccess.spurIpPrivacy?.signals,
            spurStatus: countryAccess.spurStatus,
            scamalyticsIpPrivacySignals:
              countryAccess.scamalyticsIpPrivacy?.signals,
            scamalyticsStatus: countryAccess.scamalyticsStatus,
            scamalyticsScore: countryAccess.scamalyticsScore,
            scamalyticsRisk: countryAccess.scamalyticsRisk,
            privacyRiskScore,
            privacyDecision,
            privacyProviderDecision,
            privacyHardBlocked: hardBlocked,
            clientIp: countryAccess.hasClientIp ? '[redacted]' : undefined,
          },
          'Free mode country detection',
        )
      }

      if (hardBlocked) {
        const error = 'free_mode_unavailable'
        const message = getHardBlockedFreeModeMessage(countryAccess)
        await endFreebuffSession({
          userId,
          userEmail: userInfo.email ?? null,
        })
        trackEvent({
          event: AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR,
          userId,
          properties: {
            error,
            countryCode: countryAccess.countryCode,
            countryBlockReason: countryAccess.blockReason,
            ipPrivacySignals: countryAccess.ipPrivacy?.signals,
            spurIpPrivacySignals: countryAccess.spurIpPrivacy?.signals,
            spurStatus: countryAccess.spurStatus,
            scamalyticsIpPrivacySignals:
              countryAccess.scamalyticsIpPrivacy?.signals,
            scamalyticsStatus: countryAccess.scamalyticsStatus,
            scamalyticsScore: countryAccess.scamalyticsScore,
            scamalyticsRisk: countryAccess.scamalyticsRisk,
            privacyRiskScore,
            privacyDecision,
            privacyProviderDecision,
            privacyHardBlocked: hardBlocked,
            clientIp: countryAccess.hasClientIp ? '[redacted]' : undefined,
            accessStatus: 'blocked',
          },
          logger,
        })
        return NextResponse.json(
          {
            error,
            message,
            countryCode: countryAccess.countryCode ?? 'UNKNOWN',
            countryBlockReason: countryAccess.blockReason ?? undefined,
            ipPrivacySignals: countryAccess.ipPrivacy?.signals ?? undefined,
          },
          { status: 403 },
        )
      }

      trackEvent = withDefaultProperties(trackEvent, {
        accessTier: freebuffAccessTier,
        accessStatus: freebuffAccessTier,
        privacyDecision,
        privacyProviderDecision,
        privacyHardBlocked: hardBlocked,
        privacyRiskScore,
        spurStatus: countryAccess.spurStatus,
        scamalyticsStatus: countryAccess.scamalyticsStatus,
      })

      if (!countryAccess.allowed) {
        trackEvent({
          event: AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR,
          userId,
          properties: {
            error: 'free_mode_not_available_in_country',
            countryCode: countryAccess.countryCode,
            countryBlockReason: countryAccess.blockReason,
            ipPrivacySignals: countryAccess.ipPrivacy?.signals,
            spurIpPrivacySignals: countryAccess.spurIpPrivacy?.signals,
            spurStatus: countryAccess.spurStatus,
            scamalyticsIpPrivacySignals:
              countryAccess.scamalyticsIpPrivacy?.signals,
            scamalyticsStatus: countryAccess.scamalyticsStatus,
            scamalyticsScore: countryAccess.scamalyticsScore,
            scamalyticsRisk: countryAccess.scamalyticsRisk,
            privacyRiskScore,
            privacyDecision,
            privacyProviderDecision,
            privacyHardBlocked: hardBlocked,
            clientIp: countryAccess.hasClientIp ? '[redacted]' : undefined,
          },
          logger,
        })
      }
    }

    // Track API request. Freebuff success-path analytics are sampled to keep
    // high-volume free traffic from dominating PostHog and log forwarding.
    trackSuccessEvent({
      event: AnalyticsEvent.CHAT_COMPLETIONS_REQUEST,
      userId,
      properties: {
        hasStream: !!bodyStream,
        hasRunId: !!runId,
        userInfo,
      },
      logger,
    })

    // Extract and validate agent run ID
    const runIdFromBody = typedBody.codebuff_metadata?.run_id
    if (!runIdFromBody || typeof runIdFromBody !== 'string') {
      trackEvent({
        event: AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR,
        userId,
        properties: {
          error: 'Missing or invalid run_id',
        },
        logger,
      })
      return NextResponse.json(
        { message: 'No runId found in request body' },
        { status: 400 },
      )
    }

    // Get and validate agent run
    const agentRun = await getAgentRunFromId({
      runId: runIdFromBody,
      userId,
      fields: ['agent_id', 'ancestor_run_ids', 'status'],
    })
    if (!agentRun) {
      trackEvent({
        event: AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR,
        userId,
        properties: {
          error: 'Agent run not found',
          runId: runIdFromBody,
        },
        logger,
      })
      return NextResponse.json(
        { message: `runId Not Found: ${runIdFromBody}` },
        { status: 400 },
      )
    }

    const {
      agent_id: agentId,
      ancestor_run_ids: ancestorRunIds,
      status: agentRunStatus,
    } = agentRun

    if (agentRunStatus !== 'running') {
      trackEvent({
        event: AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR,
        userId,
        properties: {
          error: 'Agent run not running',
          runId: runIdFromBody,
          status: agentRunStatus,
        },
        logger,
      })
      return NextResponse.json(
        { message: `runId Not Running: ${runIdFromBody}` },
        { status: 400 },
      )
    }

    // Free-mode requests must use an allowlisted agent+model combination.
    // Without this gate, an attacker on a brand-new unpaid account can set
    // cost_mode='free' to bypass both the paid-account check and the balance
    // check, then request an expensive model (Opus, etc). Our OpenRouter key
    // pays for the call; the downstream credit-consumption step records an
    // audit row but can't actually deduct from a user who has no grants —
    // net result is free Opus for the attacker, real dollars for us. Check
    // must happen here, before any call to OpenRouter.
    if (
      isFreeModeRequest &&
      !isFreeModeAllowedAgentModel(agentId, typedBody.model)
    ) {
      trackEvent({
        event: AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR,
        userId,
        properties: {
          error: 'free_mode_invalid_agent_model',
          agentId,
          model: typedBody.model,
        },
        logger,
      })
      return NextResponse.json(
        {
          error: 'free_mode_invalid_agent_model',
          message:
            'Free mode is only available for specific agent and model combinations.',
        },
        { status: 403 },
      )
    }

    if (isFreeModeRequest && !isFreebuffRootAgent(agentId)) {
      const rootRunId = ancestorRunIds[0]
      const rootRun = rootRunId
        ? await getAgentRunFromId({
            runId: rootRunId,
            userId,
            fields: ['agent_id', 'status'],
          })
        : null
      if (
        !rootRun ||
        rootRun.status !== 'running' ||
        !isFreebuffRootAgent(rootRun.agent_id)
      ) {
        trackEvent({
          event: AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR,
          userId,
          properties: {
            error: 'free_mode_invalid_agent_hierarchy',
            agentId,
            runId: runIdFromBody,
            rootRunId,
          },
          logger,
        })
        return NextResponse.json(
          {
            error: 'free_mode_invalid_agent_hierarchy',
            message:
              'Free mode subagents must run under an active freebuff session root.',
          },
          { status: 403 },
        )
      }
    }

    if (
      isFreeModeRequest &&
      freebuffAccessTier === 'limited' &&
      (isSupportedFreebuffModelId(typedBody.model) ||
        typedBody.model === FREEBUFF_GEMINI_PRO_MODEL_ID) &&
      !isFreebuffModelAllowedForAccessTier(typedBody.model, freebuffAccessTier)
    ) {
      trackEvent({
        event: AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR,
        userId,
        properties: {
          error: 'session_model_mismatch',
          model: typedBody.model,
          accessTier: freebuffAccessTier,
        },
        logger,
      })
      return NextResponse.json(
        {
          error: 'session_model_mismatch',
          message:
            'Limited free access is only available with DeepSeek V4 Flash.',
        },
        { status: STATUS_BY_GATE_CODE.session_model_mismatch },
      )
    }

    let freeModeSessionGate: SessionGateResult | null = null

    // Freebuff waiting-room gate. Usually enforced only when
    // FREEBUFF_WAITING_ROOM_ENABLED=true. Runs before the rate limiter so
    // rejected requests don't burn a queued user's free-mode counters.
    if (isFreeModeRequest) {
      const claimedInstanceId =
        typedBody.codebuff_metadata?.freebuff_instance_id
      freeModeSessionGate = await checkSession({
        userId,
        accessTier: freebuffAccessTier,
        userEmail: userInfo.email,
        claimedInstanceId,
        requestedModel: typedBody.model,
        requireActiveSession: isFreebuffGeminiThinkerAgent(agentId),
      })
      if (!freeModeSessionGate.ok) {
        trackEvent({
          event: AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR,
          userId,
          properties: { error: freeModeSessionGate.code },
          logger,
        })
        return NextResponse.json(
          {
            error: freeModeSessionGate.code,
            message: freeModeSessionGate.message,
          },
          { status: STATUS_BY_GATE_CODE[freeModeSessionGate.code] },
        )
      }
    }

    // Rate limit free mode requests (after validation so invalid requests don't consume quota)
    if (isFreeModeRequest) {
      const rateLimitResult = checkFreeModeRateLimit(userId)
      if (rateLimitResult.limited) {
        const retryAfterSeconds = Math.ceil(rateLimitResult.retryAfterMs / 1000)
        const resetTime = new Date(
          Date.now() + rateLimitResult.retryAfterMs,
        ).toISOString()
        const resetCountdown = formatQuotaResetCountdown(resetTime)

        trackEvent({
          event: AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR,
          userId,
          properties: {
            error: 'free_mode_rate_limited',
            windowName: rateLimitResult.windowName,
            retryAfterSeconds,
          },
          logger,
        })

        return NextResponse.json(
          {
            error: 'free_mode_rate_limited',
            message: `Free mode rate limit exceeded (${rateLimitResult.windowName} limit). Try again ${resetCountdown}.`,
          },
          {
            status: 429,
            headers: { 'Retry-After': String(retryAfterSeconds) },
          },
        )
      }
    }

    // For subscribers, ensure a block grant exists before processing the request.
    // This is done AFTER validation so malformed requests don't start a new 5-hour block.
    // When the function is provided, always include subscription credits in the balance:
    // error/null results mean subscription grants have 0 balance, so including them is harmless.
    const includeSubscriptionCredits =
      !isFreeModeRequest && !!ensureSubscriberBlockGrant
    if (!isFreeModeRequest && ensureSubscriberBlockGrant) {
      try {
        const blockGrantResult = await ensureSubscriberBlockGrant({
          userId,
          logger,
        })

        // Check if user hit subscription limit and should be rate-limited
        if (
          blockGrantResult &&
          (isWeeklyLimitError(blockGrantResult) ||
            isBlockExhaustedError(blockGrantResult))
        ) {
          // Fetch user's preference for falling back to a-la-carte credits
          const preferences = getUserPreferences
            ? await getUserPreferences({ userId, logger })
            : { fallbackToALaCarte: true } // Default to allowing a-la-carte if no preference function

          if (!preferences.fallbackToALaCarte) {
            const resetTime = blockGrantResult.resetsAt
            const resetCountdown = formatQuotaResetCountdown(
              resetTime.toISOString(),
            )
            const limitType = isWeeklyLimitError(blockGrantResult)
              ? 'weekly'
              : '5-hour session'

            trackEvent({
              event: AnalyticsEvent.CHAT_COMPLETIONS_INSUFFICIENT_CREDITS,
              userId,
              properties: {
                reason: 'subscription_limit_no_fallback',
                limitType,
                fallbackToALaCarte: false,
              },
              logger,
            })

            return NextResponse.json(
              {
                error: 'rate_limit_exceeded',
                message: `Subscription ${limitType} limit reached. Your limit resets ${resetCountdown}. Enable "Continue with credits" in the CLI to use a-la-carte credits.`,
              },
              { status: 429 },
            )
          }
          // If fallbackToALaCarte is true, continue to use a-la-carte credits
          logger.info(
            {
              userId,
              limitType: isWeeklyLimitError(blockGrantResult)
                ? 'weekly'
                : 'session',
            },
            'Subscriber hit limit, falling back to a-la-carte credits',
          )
        }
      } catch (error) {
        logger.error(
          { error: getErrorObject(error), userId },
          'Error ensuring subscription block grant',
        )
        // Fail open: proceed with subscription credits included in balance check
      }
    }

    // Free-mode requests have already passed their model/session/rate gates
    // and should not touch paid billing/usage paths.
    if (!isFreeModeRequest) {
      // Fetch user credit data (includes subscription credits when block grant was ensured)
      const {
        balance: { totalRemaining },
        nextQuotaReset,
      } = await getUserUsageData({ userId, logger, includeSubscriptionCredits })

      // Credit check
      if (totalRemaining <= 0) {
        trackEvent({
          event: AnalyticsEvent.CHAT_COMPLETIONS_INSUFFICIENT_CREDITS,
          userId,
          properties: {
            totalRemaining,
            nextQuotaReset,
          },
          logger,
        })
        return NextResponse.json(
          {
            message: `Out of credits. Please add credits at ${env.NEXT_PUBLIC_CODEBUFF_APP_URL}/usage.`,
          },
          { status: 402 },
        )
      }
    }

    const openrouterApiKey = req.headers.get(BYOK_OPENROUTER_HEADER)
    const providerLogger = sampleSuccessLogger(logger, sampleFreebuffSuccess)

    recordChatCompletionTrace({
      body: typedBody,
      userId,
      agentId,
      ancestorRunIds,
      logger: providerLogger,
      insertChatCompletionTraceBigquery,
    })

    const requestMetrics = beginChatCompletionRequestMetrics({
      logger,
      userId,
      agentId,
      runId: runIdFromBody,
      model: typedBody.model,
      streaming: bodyStream,
      costMode,
    })

    // Handle streaming vs non-streaming
    try {
      if (bodyStream) {
        // Streaming request — route supported models to direct providers.
        const useSiliconFlow = false // isSiliconFlowModel(typedBody.model)
        const useOpenCodeZen = isOpenCodeZenModel(typedBody.model)
        const useMoonshot = !useOpenCodeZen && isMoonshotModel(typedBody.model)
        const useCanopyWave =
          !useMoonshot && !useOpenCodeZen && isCanopyWaveModel(typedBody.model)
        const deepseekBypassed = shouldBypassDeepSeek(typedBody.model)
        if (deepseekBypassed) {
          providerLogger.info(
            { model: typedBody.model },
            'DeepSeek circuit open — routing to Fireworks fallback',
          )
        }
        const useDeepSeek =
          !useMoonshot &&
          !useOpenCodeZen &&
          !useCanopyWave &&
          !deepseekBypassed &&
          isDeepSeekModel(typedBody.model)
        const useFireworks =
          !useMoonshot &&
          !useOpenCodeZen &&
          !useCanopyWave &&
          !useDeepSeek &&
          isFireworksModel(typedBody.model)
        const useOpenAIDirect =
          !useMoonshot &&
          !useOpenCodeZen &&
          !useCanopyWave &&
          !useDeepSeek &&
          !useFireworks &&
          isOpenAIDirectModel(typedBody.model)
        const baseArgs = {
          body: typedBody,
          userId,
          stripeCustomerId,
          agentId,
          fetch,
          logger: providerLogger,
          insertMessageBigquery,
        }
        const callDeepSeekStream = async () => {
          try {
            return await handleDeepSeekStream(baseArgs)
          } catch (error) {
            if (canFailoverDeepSeekToFireworks(error, typedBody.model)) {
              providerLogger.warn(
                {
                  model: typedBody.model,
                  error: getErrorObject(error),
                },
                'DeepSeek failed pre-stream — falling back to Fireworks',
              )
              return await handleFireworksStream(baseArgs)
            }
            throw error
          }
        }
        const stream = useSiliconFlow
          ? await handleSiliconFlowStream(baseArgs)
          : useMoonshot
            ? await handleMoonshotStream(baseArgs)
            : useOpenCodeZen
              ? await handleOpenCodeZenStream(baseArgs)
              : useCanopyWave
                ? await handleCanopyWaveStream(baseArgs)
                : useDeepSeek
                  ? await callDeepSeekStream()
                  : useFireworks
                    ? await handleFireworksStream(baseArgs)
                    : useOpenAIDirect
                      ? await handleOpenAIStream(baseArgs)
                      : await handleOpenRouterStream({
                          ...baseArgs,
                          openrouterApiKey,
                        })

        trackSuccessEvent({
          event: AnalyticsEvent.CHAT_COMPLETIONS_STREAM_STARTED,
          userId,
          properties: {
            agentId,
            runId: runIdFromBody,
          },
          logger,
        })

        return new NextResponse(requestMetrics.wrapStream(stream), {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          },
        })
      } else {
        // Non-streaming request — route to direct providers for supported models
        const model = typedBody.model
        const useSiliconFlow = false // isSiliconFlowModel(model)
        const useOpenCodeZen = isOpenCodeZenModel(model)
        const useMoonshot = !useOpenCodeZen && isMoonshotModel(model)
        const useCanopyWave =
          !useMoonshot && !useOpenCodeZen && isCanopyWaveModel(model)
        const deepseekBypassed = shouldBypassDeepSeek(model)
        if (deepseekBypassed) {
          providerLogger.info(
            { model },
            'DeepSeek circuit open — routing to Fireworks fallback',
          )
        }
        const useDeepSeek =
          !useMoonshot &&
          !useOpenCodeZen &&
          !useCanopyWave &&
          !deepseekBypassed &&
          isDeepSeekModel(model)
        const useFireworks =
          !useMoonshot &&
          !useOpenCodeZen &&
          !useCanopyWave &&
          !useDeepSeek &&
          isFireworksModel(model)
        const shouldUseOpenAIEndpoint =
          !useMoonshot &&
          !useOpenCodeZen &&
          !useCanopyWave &&
          !useDeepSeek &&
          !useFireworks &&
          isOpenAIDirectModel(model)

        const baseArgs = {
          body: typedBody,
          userId,
          stripeCustomerId,
          agentId,
          fetch,
          logger: providerLogger,
          insertMessageBigquery,
        }
        const callDeepSeekNonStream = async () => {
          try {
            return await handleDeepSeekNonStream(baseArgs)
          } catch (error) {
            if (canFailoverDeepSeekToFireworks(error, model)) {
              providerLogger.warn(
                { model, error: getErrorObject(error) },
                'DeepSeek failed — falling back to Fireworks',
              )
              return await handleFireworksNonStream(baseArgs)
            }
            throw error
          }
        }
        const nonStreamRequest = useSiliconFlow
          ? handleSiliconFlowNonStream(baseArgs)
          : useMoonshot
            ? handleMoonshotNonStream(baseArgs)
            : useOpenCodeZen
              ? handleOpenCodeZenNonStream(baseArgs)
              : useCanopyWave
                ? handleCanopyWaveNonStream(baseArgs)
                : useDeepSeek
                  ? callDeepSeekNonStream()
                  : useFireworks
                    ? handleFireworksNonStream(baseArgs)
                    : shouldUseOpenAIEndpoint
                      ? handleOpenAINonStream(baseArgs)
                      : handleOpenRouterNonStream({
                          ...baseArgs,
                          openrouterApiKey,
                        })
        const result = await nonStreamRequest

        trackSuccessEvent({
          event: AnalyticsEvent.CHAT_COMPLETIONS_GENERATION_STARTED,
          userId,
          properties: {
            agentId,
            runId: runIdFromBody,
            streaming: false,
          },
          logger,
        })

        requestMetrics.end('completed')
        return NextResponse.json(result)
      }
    } catch (error) {
      requestMetrics.end('error', { error: getErrorObject(error) })
      let openrouterError: OpenRouterError | undefined
      if (error instanceof OpenRouterError) {
        openrouterError = error
      }
      let fireworksError: FireworksError | undefined
      if (error instanceof FireworksError) {
        fireworksError = error
      }
      let canopywaveError: CanopyWaveError | undefined
      if (error instanceof CanopyWaveError) {
        canopywaveError = error
      }
      let deepseekError: DeepSeekError | undefined
      if (error instanceof DeepSeekError) {
        deepseekError = error
      }
      let moonshotError: MoonshotError | undefined
      if (error instanceof MoonshotError) {
        moonshotError = error
      }
      let siliconflowError: SiliconFlowError | undefined
      if (error instanceof SiliconFlowError) {
        siliconflowError = error
      }
      let openaiError: OpenAIError | undefined
      if (error instanceof OpenAIError) {
        openaiError = error
      }
      let opencodeZenError: OpenCodeZenError | undefined
      if (error instanceof OpenCodeZenError) {
        opencodeZenError = error
      }

      // Log detailed error information for debugging
      const errorDetails = openrouterError?.toJSON()
      const telemetryBody = createRequestAuditRecord(body)
      const providerLabel = siliconflowError
        ? 'SiliconFlow'
        : opencodeZenError
          ? 'OpenCode Zen'
          : moonshotError
            ? 'Moonshot'
            : canopywaveError
              ? 'CanopyWave'
              : deepseekError
                ? 'DeepSeek'
                : fireworksError
                  ? 'Fireworks'
                  : openaiError
                    ? 'OpenAI'
                    : 'OpenRouter'
      logger.error(
        {
          error: getErrorObject(error),
          userId,
          agentId,
          runId: runIdFromBody,
          model: typedBody.model,
          streaming: !!bodyStream,
          hasByokKey: !!openrouterApiKey,
          messageCount: Array.isArray(typedBody.messages)
            ? typedBody.messages.length
            : 0,
          messagesOmitted: true,
          accessTier: freebuffAccessTier,
          providerStatusCode: (
            openrouterError ??
            fireworksError ??
            moonshotError ??
            canopywaveError ??
            deepseekError ??
            siliconflowError ??
            openaiError ??
            opencodeZenError
          )?.statusCode,
          providerStatusText: (
            openrouterError ??
            fireworksError ??
            moonshotError ??
            canopywaveError ??
            deepseekError ??
            siliconflowError ??
            openaiError ??
            opencodeZenError
          )?.statusText,
          openrouterErrorCode: errorDetails?.error?.code,
          openrouterErrorType: errorDetails?.error?.type,
          openrouterErrorMessage: errorDetails?.error?.message,
          openrouterProviderName: errorDetails?.error?.metadata?.provider_name,
          openrouterProviderRaw: errorDetails?.error?.metadata?.raw,
        },
        `${providerLabel} request failed`,
      )
      trackEvent({
        event: AnalyticsEvent.CHAT_COMPLETIONS_ERROR,
        userId,
        properties: {
          error: error instanceof Error ? error.message : 'Unknown error',
          body: telemetryBody,
          agentId,
          streaming: bodyStream,
        },
        logger,
      })

      // Pass through provider-specific errors
      if (error instanceof OpenRouterError) {
        return NextResponse.json(error.toJSON(), { status: error.statusCode })
      }
      if (error instanceof FireworksError) {
        return NextResponse.json(error.toJSON(), { status: error.statusCode })
      }
      if (error instanceof MoonshotError) {
        return NextResponse.json(error.toJSON(), { status: error.statusCode })
      }
      if (error instanceof CanopyWaveError) {
        return NextResponse.json(error.toJSON(), { status: error.statusCode })
      }
      if (error instanceof DeepSeekError) {
        return NextResponse.json(error.toJSON(), { status: error.statusCode })
      }
      if (error instanceof SiliconFlowError) {
        return NextResponse.json(error.toJSON(), { status: error.statusCode })
      }
      if (error instanceof OpenAIError) {
        return NextResponse.json(error.toJSON(), { status: error.statusCode })
      }
      if (error instanceof OpenCodeZenError) {
        return NextResponse.json(error.toJSON(), { status: error.statusCode })
      }

      return NextResponse.json(
        { error: 'Failed to process request' },
        { status: 500 },
      )
    }
  } catch (error) {
    logger.error(
      getErrorObject(error),
      'Error processing chat completions request',
    )
    trackEvent({
      event: AnalyticsEvent.CHAT_COMPLETIONS_ERROR,
      userId: 'unknown',
      properties: {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      logger,
    })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
