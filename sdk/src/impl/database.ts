import { MAX_AGENT_STEP_ROWS } from '@codebuff/common/constants/agents'
import { FREEBUFF_ACTING_USER_HEADER } from '@codebuff/common/constants/freebuff-models'
import { validateSingleAgent } from '@codebuff/common/templates/agent-validation'
import { DynamicAgentTemplateSchema } from '@codebuff/common/types/dynamic-agent-template'
import { getErrorObject } from '@codebuff/common/util/error'
import { truncateString } from '@codebuff/common/util/string'
import z from 'zod/v4'

import {
  checkRemoteAgentTemplateTrust,
  isUntrustedAgentPublisherError,
  resolveTrustedAgentPublishers,
} from '../agent-publisher-trust'
import { getWebsiteUrl } from '../constants'
import { getTrustedAgentPublishersFromEnv } from '../env'
import {
  createAuthError,
  createNetworkError,
  createServerError,
  createHttpError,
  isRetryableStatusCode,
} from '../error-utils'
import {
  MAX_RETRIES_PER_MESSAGE,
  RETRY_BACKOFF_BASE_DELAY_MS,
  RETRY_BACKOFF_MAX_DELAY_MS,
} from '../retry-config'

import type {
  AddAgentStepFn,
  FetchAgentFromDatabaseFn,
  FinishAgentRunFn,
  GetUserInfoFromApiKeyInput,
  GetUserInfoFromApiKeyOutput,
  StartAgentRunFn,
  UserColumn,
} from '@codebuff/common/types/contracts/database'
import type { DynamicAgentTemplate } from '@codebuff/common/types/dynamic-agent-template'
import type { ParamsOf } from '@codebuff/common/types/function-params'

type CachedUserInfo = Partial<
  NonNullable<Awaited<GetUserInfoFromApiKeyOutput<UserColumn>>>
>

const userInfoCache: Record<
  string,
  CachedUserInfo | null
> = {}

const agentsResponseSchema = z.object({
  version: z.string(),
  data: DynamicAgentTemplateSchema,
})

/**
 * Fetch with retry logic for transient errors (502, 503, etc.)
 * Implements exponential backoff between retries.
 *
 * `options.signal`, when given, ends the in-flight request AND the retries and backoff sleeps
 * behind it: a socket that never answers otherwise holds a run for the full retry budget with
 * nothing the caller's abort can reach.
 */
async function fetchWithRetry(
  url: URL | string,
  options: RequestInit,
  logger?: { warn: (obj: object, msg: string) => void },
): Promise<Response> {
  let lastError: Error | null = null
  let backoffDelay = RETRY_BACKOFF_BASE_DELAY_MS
  const signal = options.signal ?? undefined
  // the aborted check is load-bearing: `abort` never fires on a signal that already has
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })

  for (let attempt = 0; attempt <= MAX_RETRIES_PER_MESSAGE; attempt++) {
    if (signal?.aborted) {
      throw lastError ?? new DOMException('This operation was aborted', 'AbortError')
    }
    try {
      const response = await fetch(url, options)

      // If response is OK or not retryable, return it
      if (response.ok || !isRetryableStatusCode(response.status)) {
        return response
      }

      // Retryable error - log and continue to retry
      if (attempt < MAX_RETRIES_PER_MESSAGE) {
        logger?.warn(
          { status: response.status, attempt: attempt + 1, url: String(url) },
          `Retryable HTTP error, retrying in ${backoffDelay}ms`,
        )
        await sleep(backoffDelay)
        backoffDelay = Math.min(backoffDelay * 2, RETRY_BACKOFF_MAX_DELAY_MS)
      } else {
        // Last attempt, return the response even if it's an error
        return response
      }
    } catch (error) {
      // Network-level error (DNS, connection refused, etc.)
      lastError = error instanceof Error ? error : new Error(String(error))
      // the caller's abort, not the network: nothing to retry
      if (signal?.aborted) throw lastError

      if (attempt < MAX_RETRIES_PER_MESSAGE) {
        logger?.warn(
          { error: getErrorObject(lastError), attempt: attempt + 1, url: String(url) },
          `Network error, retrying in ${backoffDelay}ms`,
        )
        await sleep(backoffDelay)
        backoffDelay = Math.min(backoffDelay * 2, RETRY_BACKOFF_MAX_DELAY_MS)
      }
    }
  }

  // All retries exhausted - throw the last error
  throw lastError ?? new Error('Request failed after retries')
}

export async function getUserInfoFromApiKey<T extends UserColumn>(
  params: GetUserInfoFromApiKeyInput<T>,
): GetUserInfoFromApiKeyOutput<T> {
  const { apiKey, fields, logger, signal } = params

  const cached = userInfoCache[apiKey]
  if (cached === null) {
    throw createAuthError()
  }
  if (
    cached &&
    fields.every((field) =>
      Object.prototype.hasOwnProperty.call(cached, field),
    )
  ) {
    return Object.fromEntries(fields.map((field) => [field, cached[field]])) as {
      [K in T]: CachedUserInfo[K]
    } as Awaited<GetUserInfoFromApiKeyOutput<T>>
  }

  const fieldsToFetch = cached
    ? fields.filter(
        (field) => !Object.prototype.hasOwnProperty.call(cached, field),
      )
    : fields

  const urlParams = new URLSearchParams({
    fields: fieldsToFetch.join(','),
  })
  const url = new URL(`/api/v1/me?${urlParams}`, getWebsiteUrl())

  let response: Response
  try {
    response = await fetchWithRetry(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        ...(signal ? { signal } : {}),
      },
      logger,
    )
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), fields },
      'getUserInfoFromApiKey network error',
    )
    // Network-level failure: DNS, connection refused, timeout, etc.
    throw createNetworkError('Network request failed')
  }

  if (response.status === 401 || response.status === 403 || response.status === 404) {
    logger.error(
      { fields, status: response.status },
      'getUserInfoFromApiKey authentication failed',
    )
    // Don't cache auth failures - allow retry with potentially updated credentials
    delete userInfoCache[apiKey]
    // If the server returns 404 for invalid credentials, surface as 401 to callers
    const normalizedStatus = response.status === 404 ? 401 : response.status
    throw createHttpError('Authentication failed', normalizedStatus)
  }

  if (response.status >= 500 && response.status <= 599) {
    logger.error(
      { fields, status: response.status },
      'getUserInfoFromApiKey server error',
    )
    throw createServerError('Server error', response.status)
  }

  if (!response.ok) {
    logger.error(
      { fields, status: response.status },
      'getUserInfoFromApiKey request failed',
    )
    throw createHttpError('Request failed', response.status)
  }

  const cachedBeforeMerge = userInfoCache[apiKey]
  try {
    const responseBody = await response.json()
    const fetchedFields = responseBody as CachedUserInfo
    userInfoCache[apiKey] = {
      ...(cachedBeforeMerge ?? {}),
      ...fetchedFields,
    }
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), fields },
      'getUserInfoFromApiKey JSON parse error',
    )
    throw createHttpError('Failed to parse response', response.status)
  }

  const userInfo = userInfoCache[apiKey]
  if (userInfo === null) {
    throw createAuthError()
  }
  if (
    !userInfo ||
    !fields.every((field) =>
      Object.prototype.hasOwnProperty.call(userInfo, field),
    )
  ) {
    logger.error(
      { fields },
      'getUserInfoFromApiKey: response missing required fields',
    )
    throw createHttpError('Request failed', response.status)
  }
  return Object.fromEntries(
    fields.map((field) => [field, userInfo[field]]),
  ) as Awaited<GetUserInfoFromApiKeyOutput<T>>
}

/**
 * Fetch a template from the public agent registry.
 *
 * A registry template with a `handleSteps` source string is executable code
 * that the runtime will `eval` in this process, so after validation it is
 * gated on publisher trust (see ../agent-publisher-trust.ts). An untrusted
 * executable template THROWS `UntrustedAgentPublisherError` rather than
 * returning null: null reads as "agent not found" to every caller, which
 * would hide the one line that tells the operator how to proceed.
 */
export async function fetchAgentFromDatabase(
  params: ParamsOf<FetchAgentFromDatabaseFn> & {
    /** `CodebuffClientOptions.trustedAgentPublishers`; unioned with the env var. */
    trustedAgentPublishers?: readonly string[]
    /** Test seam for the `CODEBUFF_TRUSTED_AGENT_PUBLISHERS` read. */
    readTrustedAgentPublishersEnv?: () => string | undefined
  },
): ReturnType<FetchAgentFromDatabaseFn> {
  const {
    apiKey,
    parsedAgentId,
    logger,
    trustedAgentPublishers,
    readTrustedAgentPublishersEnv = getTrustedAgentPublishersFromEnv,
  } = params
  const { publisherId, agentId, version } = parsedAgentId

  const url = new URL(
    `/api/v1/agents/${publisherId}/${agentId}/${version ? version : 'latest'}`,
    getWebsiteUrl(),
  )

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
      logger,
    )

    if (!response.ok) {
      logger.error({ response }, 'fetchAgentFromDatabase request failed')
      return null
    }

    const responseJson = await response.json()
    const parseResult = agentsResponseSchema.safeParse(responseJson)
    if (!parseResult.success) {
      logger.error(
        { responseJson, parseResult },
        `fetchAgentFromDatabase parse error`,
      )
      return null
    }

    const agentConfig = parseResult.data
    const rawAgentData = agentConfig.data as DynamicAgentTemplate

    // Validate the raw agent data with the original agentId (not full identifier)
    const validationResult = validateSingleAgent({
      template: { ...rawAgentData, id: agentId, version: agentConfig.version },
      filePath: `${publisherId}/${agentId}@${agentConfig.version}`,
    })

    if (!validationResult.success) {
      logger.error(
        {
          publisherId,
          agentId,
          version: agentConfig.version,
          error: validationResult.error,
        },
        'fetchAgentFromDatabase: Agent validation failed',
      )
      return null
    }

    // Set the correct full agent ID for the final template
    const agentTemplate = {
      ...validationResult.agentTemplate!,
      id: `${publisherId}/${agentId}@${agentConfig.version}`,
    }

    // Validation only proved handleSteps LOOKS like a generator; it is still
    // arbitrary code from whoever owns the publisher. Refuse it unless the
    // publisher is trusted. Data-only templates pass through unchanged.
    const trustError = checkRemoteAgentTemplateTrust({
      template: agentTemplate,
      publisherId,
      agentId,
      version: agentConfig.version,
      trustedPublishers: resolveTrustedAgentPublishers({
        trustedAgentPublishers,
        envValue: readTrustedAgentPublishersEnv(),
      }),
    })
    if (trustError) {
      logger.error(
        {
          publisherId,
          agentId,
          version: agentConfig.version,
          fullAgentId: agentTemplate.id,
        },
        `fetchAgentFromDatabase: refused executable agent from untrusted publisher. ${trustError.message}`,
      )
      throw trustError
    }

    logger.debug(
      {
        publisherId,
        agentId,
        version: agentConfig.version,
        fullAgentId: agentTemplate.id,
        parsedAgentId,
      },
      'fetchAgentFromDatabase: Successfully loaded and validated agent from database',
    )

    return agentTemplate
  } catch (error) {
    // The trust refusal is the one failure that must reach the caller as
    // itself (see the doc comment above); everything else stays "not found".
    if (isUntrustedAgentPublisherError(error)) throw error
    logger.error(
      { error: getErrorObject(error), parsedAgentId },
      'fetchAgentFromDatabase error',
    )
    return null
  }
}

export async function startAgentRun(
  params: ParamsOf<StartAgentRunFn>,
): ReturnType<StartAgentRunFn> {
  const { apiKey, userId, agentId, ancestorRunIds, logger, signal } = params

  const url = new URL(`/api/v1/agent-runs`, getWebsiteUrl())

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(userId ? { [FREEBUFF_ACTING_USER_HEADER]: userId } : {}),
        },
        body: JSON.stringify({
          action: 'START',
          agentId,
          ancestorRunIds,
        }),
        ...(signal ? { signal } : {}),
      },
      logger,
    )

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '<unreadable body>')
      logger.error({ response }, 'startAgentRun request failed')
      // The passed-in `logger` may silently drop unallowlisted error events
      // (see freebuff/web/src/server/agent-runner/logger.ts), which turns a
      // real failure here into an opaque "Failed to start agent run" with no
      // way to diagnose it. Always surface the raw HTTP status/body too.
      console.error('[startAgentRun] request failed', {
        url: url.toString(),
        status: response.status,
        statusText: response.statusText,
        body: bodyText.slice(0, 2000),
      })
      return null
    }

    const responseBody = await response.json()
    if (!responseBody?.runId) {
      logger.error(
        { responseBody },
        'no runId found from startAgentRun request',
      )
      console.error('[startAgentRun] no runId in response body', {
        url: url.toString(),
        responseBody,
      })
    }
    return responseBody?.runId ?? null
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), agentId },
      'startAgentRun error',
    )
    console.error('[startAgentRun] threw', {
      url: url.toString(),
      error: getErrorObject(error),
    })
    return null
  }
}

export async function finishAgentRun(
  params: ParamsOf<FinishAgentRunFn>,
): ReturnType<FinishAgentRunFn> {
  const {
    apiKey,
    userId,
    runId,
    status,
    totalSteps,
    directCredits,
    totalCredits,
    errorMessage,
    logger,
  } = params
  const steps = pendingAgentSteps.get(runId) ?? []
  pendingAgentSteps.delete(runId)

  const url = new URL(`/api/v1/agent-runs`, getWebsiteUrl())

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(userId ? { [FREEBUFF_ACTING_USER_HEADER]: userId } : {}),
        },
        body: JSON.stringify({
          action: 'FINISH',
          runId,
          status,
          totalSteps,
          directCredits,
          totalCredits,
          // Truncate: errorMessage can include a full stack trace
          errorMessage:
            errorMessage === undefined
              ? undefined
              : truncateString(errorMessage, 5000),
          steps,
        }),
      },
      logger,
    )

    if (!response.ok) {
      logger.error({ response }, 'finishAgentRun request failed')
      return
    }
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), runId, status },
      'finishAgentRun error',
    )
  }
}

const pendingAgentStepSchema = z.object({
  id: z.string().uuid(),
  stepNumber: z.number().int().nonnegative(),
  credits: z.number().nonnegative().optional(),
  childRunIds: z.array(z.string()).optional(),
  messageId: z.string().nullable(),
  status: z.enum(['running', 'completed', 'skipped']).optional(),
  errorMessage: z.string().optional(),
  startTime: z.string().datetime(),
})
type PendingAgentStep = z.infer<typeof pendingAgentStepSchema>

const pendingAgentSteps = new Map<string, PendingAgentStep[]>()
const MAX_PENDING_AGENT_RUNS = 1_000

export async function addAgentStep(
  params: ParamsOf<AddAgentStepFn>,
): ReturnType<AddAgentStepFn> {
  const id = crypto.randomUUID()
  const startTime =
    params.startTime instanceof Date ? params.startTime.toJSON() : null
  const parsedStep = pendingAgentStepSchema.safeParse({
    id,
    stepNumber: params.stepNumber,
    credits: params.credits,
    childRunIds: params.childRunIds,
    messageId: params.messageId,
    status: params.status,
    errorMessage: params.errorMessage,
    startTime,
  })
  if (!parsedStep.success) {
    params.logger.error(
      {
        agentRunId: params.agentRunId,
        stepNumber: params.stepNumber,
        validationError: parsedStep.error,
      },
      'addAgentStep received invalid step data',
    )
    return null
  }
  let entries = pendingAgentSteps.get(params.agentRunId)
  if (!entries) {
    if (pendingAgentSteps.size >= MAX_PENDING_AGENT_RUNS) {
      const oldestRunId = pendingAgentSteps.keys().next().value
      if (oldestRunId !== undefined) {
        pendingAgentSteps.delete(oldestRunId)
        params.logger.warn(
          { evictedRunId: oldestRunId, maxPendingRuns: MAX_PENDING_AGENT_RUNS },
          'Evicted abandoned agent-step buffer',
        )
      }
    }
    entries = []
    pendingAgentSteps.set(params.agentRunId, entries)
  } else {
    // Refresh insertion order so the map cap evicts abandoned buffers before
    // long-running agents that are still producing steps.
    pendingAgentSteps.delete(params.agentRunId)
    pendingAgentSteps.set(params.agentRunId, entries)
  }
  if (entries.length >= MAX_AGENT_STEP_ROWS) {
    params.logger.warn(
      {
        agentRunId: params.agentRunId,
        stepNumber: params.stepNumber,
        maxSteps: MAX_AGENT_STEP_ROWS,
      },
      'Ignored agent step beyond the per-run buffer limit',
    )
    return null
  }
  entries.push(parsedStep.data)
  return id
}
