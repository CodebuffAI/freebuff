import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { BYOK_OPENROUTER_HEADER } from '@codebuff/common/constants/byok'
import {
  isFreebuffRootAgent,
  isFreeMode,
  isFreeModeAllowedAgentModel,
} from '@codebuff/common/constants/free-agents'
import { getErrorObject } from '@codebuff/common/util/error'
import { pluralize } from '@codebuff/common/util/string'
import { env } from '@codebuff/internal/env'
import { NextResponse } from 'next/server'

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
import { checkSessionAdmissible } from '@/server/free-session/public-api'
import { getFreeModeCountryAccess } from '@/server/free-mode-country'

import type { SessionGateResult } from '@/server/free-session/public-api'
import { extractApiKeyFromHeader } from '@/util/auth'
import { withDefaultProperties } from '@codebuff/common/analytics'
import { checkFreeModeRateLimit } from './free-mode-rate-limiter'

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

type ProviderHandlerArgs = Parameters<typeof handleCanopyWaveStream>[0]
type ProviderHandler<T> = (args: ProviderHandlerArgs) => Promise<T>

function shouldFallbackCanopyWaveToFireworks(
  error: unknown,
  model: string,
): error is CanopyWaveError {
  if (!(error instanceof CanopyWaveError) || !isFireworksModel(model)) {
    return false
  }
  const message = error.errorBody.error.message.toLowerCase()
  return (
    error.statusCode === 429 ||
    error.statusCode >= 500 ||
    message.includes('no available workers')
  )
}

async function handleCanopyWaveWithFireworksFallback<T>(
  args: ProviderHandlerArgs,
  handleCanopyWave: ProviderHandler<T>,
  handleFireworks: ProviderHandler<T>,
): Promise<T> {
  try {
    return await handleCanopyWave(args)
  } catch (error) {
    if (!shouldFallbackCanopyWaveToFireworks(error, args.body.model)) {
      throw error
    }

    args.logger.warn(
      {
        error: getErrorObject(error),
        model: args.body.model,
        providerStatusCode: error.statusCode,
        providerStatusText: error.statusText,
      },
      'CanopyWave request failed, falling back to Fireworks',
    )

    return handleFireworks(args)
  }
}

export type CheckSessionAdmissibleFn = typeof checkSessionAdmissible

type GateRejectCode = Extract<SessionGateResult, { ok: false }>['code']

const STATUS_BY_GATE_CODE = {
  waiting_room_required: 428,
  waiting_room_queued: 429,
  session_superseded: 409,
  session_expired: 410,
  session_model_mismatch: 409,
  freebuff_update_required: 426,
} satisfies Record<GateRejectCode, number>

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
  ensureSubscriberBlockGrant?: (params: {
    userId: string
    logger: Logger
  }) => Promise<BlockGrantResult | null>
  getUserPreferences?: GetUserPreferencesFn
  /** Optional override for the freebuff waiting-room gate. Defaults to the
   *  real check backed by Postgres; tests inject a no-op. */
  checkSessionAdmissible?: CheckSessionAdmissibleFn
}) {
  const {
    req,
    getUserInfoFromApiKey,
    loggerWithContext,
    getUserUsageData,
    getAgentRunFromId,
    fetch,
    insertMessageBigquery,
    ensureSubscriberBlockGrant,
    getUserPreferences,
    checkSessionAdmissible: checkSession = checkSessionAdmissible,
  } = params
  let { logger } = params
  let { trackEvent } = params

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

    // Track API request
    trackEvent({
      event: AnalyticsEvent.CHAT_COMPLETIONS_REQUEST,
      userId,
      properties: {
        hasStream: !!bodyStream,
        hasRunId: !!runId,
        userInfo,
      },
      logger,
    })

    // For free mode requests, require a resolved allowlisted country.
    if (isFreeModeRequest) {
      const countryAccess = await getFreeModeCountryAccess(req, {
        fetch,
        ipinfoToken: env.IPINFO_TOKEN,
        ipHashSecret: env.NEXTAUTH_SECRET,
        allowLocalhost: env.NEXT_PUBLIC_CB_ENVIRONMENT === 'dev',
      })

      logger.info(
        {
          cfHeader: countryAccess.cfCountry,
          geoipResult: countryAccess.geoipCountry,
          resolvedCountry: countryAccess.countryCode,
          countryBlockReason: countryAccess.blockReason,
          ipPrivacySignals: countryAccess.ipPrivacy?.signals,
          clientIp: countryAccess.hasClientIp ? '[redacted]' : undefined,
        },
        'Free mode country detection',
      )

      if (!countryAccess.allowed) {
        trackEvent({
          event: AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR,
          userId,
          properties: {
            error: 'free_mode_not_available_in_country',
            countryCode: countryAccess.countryCode,
            countryBlockReason: countryAccess.blockReason,
            ipPrivacySignals: countryAccess.ipPrivacy?.signals,
            clientIp: countryAccess.hasClientIp ? '[redacted]' : undefined,
          },
          logger,
        })

        return NextResponse.json(
          {
            error: 'free_mode_unavailable',
            message: 'Free mode is not available in your country.',
            countryCode: countryAccess.countryCode ?? 'UNKNOWN',
            countryBlockReason: countryAccess.blockReason,
            ipPrivacySignals: countryAccess.ipPrivacy?.signals,
          },
          { status: 403 },
        )
      }
    }

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

    // Freebuff waiting-room gate. Only enforced for free-mode requests, and
    // only when FREEBUFF_WAITING_ROOM_ENABLED=true — otherwise this is a
    // no-op that returns { ok: true, reason: 'disabled' } without a DB hit.
    // Runs before the rate limiter so rejected requests don't burn a queued
    // user's free-mode counters.
    if (isFreeModeRequest) {
      const claimedInstanceId =
        typedBody.codebuff_metadata?.freebuff_instance_id
      const gate = await checkSession({
        userId,
        userEmail: userInfo.email,
        claimedInstanceId,
        requestedModel: typedBody.model,
      })
      if (!gate.ok) {
        trackEvent({
          event: AnalyticsEvent.CHAT_COMPLETIONS_VALIDATION_ERROR,
          userId,
          properties: { error: gate.code },
          logger,
        })
        return NextResponse.json(
          { error: gate.code, message: gate.message },
          { status: STATUS_BY_GATE_CODE[gate.code] },
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
    const includeSubscriptionCredits = !!ensureSubscriberBlockGrant
    if (ensureSubscriberBlockGrant) {
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

          if (!preferences.fallbackToALaCarte && !isFreeModeRequest) {
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

    // Fetch user credit data (includes subscription credits when block grant was ensured)
    const {
      balance: { totalRemaining },
      nextQuotaReset,
    } = await getUserUsageData({ userId, logger, includeSubscriptionCredits })

    // Credit check
    if (totalRemaining <= 0 && !isFreeModeRequest) {
      trackEvent({
        event: AnalyticsEvent.CHAT_COMPLETIONS_INSUFFICIENT_CREDITS,
        userId,
        properties: {
          totalRemaining,
          nextQuotaReset,
        },
        logger,
      })
      const resetCountdown = formatQuotaResetCountdown(nextQuotaReset)
      return NextResponse.json(
        {
          message: `Out of credits. Please add credits at ${env.NEXT_PUBLIC_CODEBUFF_APP_URL}/usage. Your free credits reset ${resetCountdown}.`,
        },
        { status: 402 },
      )
    }

    const openrouterApiKey = req.headers.get(BYOK_OPENROUTER_HEADER)

    // Handle streaming vs non-streaming
    try {
      if (bodyStream) {
        // Streaming request — route to SiliconFlow/CanopyWave/Fireworks for supported models
        const useSiliconFlow = false // isSiliconFlowModel(typedBody.model)
        const useCanopyWave =
          !!env.CANOPYWAVE_API_KEY && isCanopyWaveModel(typedBody.model)
        const useFireworks = !useCanopyWave && isFireworksModel(typedBody.model)
        const useOpenAIDirect =
          !useCanopyWave &&
          !useFireworks &&
          isOpenAIDirectModel(typedBody.model)
        const stream = useSiliconFlow
          ? await handleSiliconFlowStream({
              body: typedBody,
              userId,
              stripeCustomerId,
              agentId,
              fetch,
              logger,
              insertMessageBigquery,
            })
          : useCanopyWave
            ? await handleCanopyWaveWithFireworksFallback(
                {
                  body: typedBody,
                  userId,
                  stripeCustomerId,
                  agentId,
                  fetch,
                  logger,
                  insertMessageBigquery,
                },
                handleCanopyWaveStream,
                handleFireworksStream,
              )
            : useFireworks
              ? await handleFireworksStream({
                  body: typedBody,
                  userId,
                  stripeCustomerId,
                  agentId,
                  fetch,
                  logger,
                  insertMessageBigquery,
                })
              : useOpenAIDirect
                ? await handleOpenAIStream({
                    body: typedBody,
                    userId,
                    stripeCustomerId,
                    agentId,
                    fetch,
                    logger,
                    insertMessageBigquery,
                  })
                : await handleOpenRouterStream({
                    body: typedBody,
                    userId,
                    stripeCustomerId,
                    agentId,
                    openrouterApiKey,
                    fetch,
                    logger,
                    insertMessageBigquery,
                  })

        trackEvent({
          event: AnalyticsEvent.CHAT_COMPLETIONS_STREAM_STARTED,
          userId,
          properties: {
            agentId,
            runId: runIdFromBody,
          },
          logger,
        })

        return new NextResponse(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          },
        })
      } else {
        // Non-streaming request — route to SiliconFlow/CanopyWave/Fireworks for supported models
        const model = typedBody.model
        const useSiliconFlow = false // isSiliconFlowModel(model)
        const useCanopyWave =
          !!env.CANOPYWAVE_API_KEY && isCanopyWaveModel(model)
        const useFireworks = !useCanopyWave && isFireworksModel(model)
        const shouldUseOpenAIEndpoint =
          !useCanopyWave && !useFireworks && isOpenAIDirectModel(model)

        const nonStreamRequest = useSiliconFlow
          ? handleSiliconFlowNonStream({
              body: typedBody,
              userId,
              stripeCustomerId,
              agentId,
              fetch,
              logger,
              insertMessageBigquery,
            })
          : useCanopyWave
            ? handleCanopyWaveWithFireworksFallback(
                {
                  body: typedBody,
                  userId,
                  stripeCustomerId,
                  agentId,
                  fetch,
                  logger,
                  insertMessageBigquery,
                },
                handleCanopyWaveNonStream,
                handleFireworksNonStream,
              )
            : useFireworks
              ? handleFireworksNonStream({
                  body: typedBody,
                  userId,
                  stripeCustomerId,
                  agentId,
                  fetch,
                  logger,
                  insertMessageBigquery,
                })
              : shouldUseOpenAIEndpoint
                ? handleOpenAINonStream({
                    body: typedBody,
                    userId,
                    stripeCustomerId,
                    agentId,
                    fetch,
                    logger,
                    insertMessageBigquery,
                  })
                : handleOpenRouterNonStream({
                    body: typedBody,
                    userId,
                    stripeCustomerId,
                    agentId,
                    openrouterApiKey,
                    fetch,
                    logger,
                    insertMessageBigquery,
                  })
        const result = await nonStreamRequest

        trackEvent({
          event: AnalyticsEvent.CHAT_COMPLETIONS_GENERATION_STARTED,
          userId,
          properties: {
            agentId,
            runId: runIdFromBody,
            streaming: false,
          },
          logger,
        })

        return NextResponse.json(result)
      }
    } catch (error) {
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
      let siliconflowError: SiliconFlowError | undefined
      if (error instanceof SiliconFlowError) {
        siliconflowError = error
      }
      let openaiError: OpenAIError | undefined
      if (error instanceof OpenAIError) {
        openaiError = error
      }

      // Log detailed error information for debugging
      const errorDetails = openrouterError?.toJSON()
      const providerLabel = siliconflowError
        ? 'SiliconFlow'
        : canopywaveError
          ? 'CanopyWave'
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
          messages: typedBody.messages,
          providerStatusCode: (
            openrouterError ??
            fireworksError ??
            canopywaveError ??
            siliconflowError ??
            openaiError
          )?.statusCode,
          providerStatusText: (
            openrouterError ??
            fireworksError ??
            canopywaveError ??
            siliconflowError ??
            openaiError
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
          body,
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
      if (error instanceof CanopyWaveError) {
        return NextResponse.json(error.toJSON(), { status: error.statusCode })
      }
      if (error instanceof SiliconFlowError) {
        return NextResponse.json(error.toJSON(), { status: error.statusCode })
      }
      if (error instanceof OpenAIError) {
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
