import { NextResponse } from 'next/server'
import { env } from '@codebuff/internal/env'

import {
  endUserSession,
  getSessionState,
  requestSession,
} from '@/server/free-session/public-api'
import { getFreeModeAccessTier } from '@/server/free-mode-country'
import { getCachedFreeModeCountryAccess } from '@/server/free-mode-country-access-cache'
import { extractApiKeyFromHeader } from '@/util/auth'

import type { FreeModeCountryAccess } from '@/server/free-mode-country'
import type { FreeSessionCountryAccessMetadata } from '@/server/free-session/types'
import type { SessionDeps } from '@/server/free-session/public-api'
import type { GetUserInfoFromApiKeyFn } from '@codebuff/common/types/contracts/database'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { NextRequest } from 'next/server'

/** Resolves the caller's current free-mode country/privacy classification.
 *  This no longer blocks unsupported countries outright; the HTTP layer uses
 *  it to choose full vs limited Freebuff access. */
type GetCountryAccessFn = (req: NextRequest) => Promise<FreeModeCountryAccess>

async function getCountryAccess(
  userId: string,
  req: NextRequest,
  deps: FreebuffSessionDeps,
): Promise<FreeModeCountryAccess> {
  return (
    deps.getCountryAccess?.(req) ??
    getCachedFreeModeCountryAccess({
      userId,
      req,
      logger: deps.logger,
      options: {
        ipinfoToken: env.IPINFO_TOKEN,
        ipHashSecret: env.NEXTAUTH_SECRET,
        allowLocalhost: env.NEXT_PUBLIC_CB_ENVIRONMENT === 'dev',
        forceLimited:
          env.NEXT_PUBLIC_CB_ENVIRONMENT === 'dev' &&
          env.FREEBUFF_DEV_FORCE_LIMITED,
      },
    })
  )
}

function toSessionCountryAccess(
  countryAccess: FreeModeCountryAccess,
): FreeSessionCountryAccessMetadata {
  return {
    countryCode: countryAccess.countryCode,
    cfCountry: countryAccess.cfCountry,
    geoipCountry: countryAccess.geoipCountry,
    blockReason: countryAccess.blockReason,
    ipPrivacySignals: countryAccess.ipPrivacy?.signals ?? null,
    clientIpHash: countryAccess.clientIpHash,
    checkedAt: new Date(),
  }
}

/** Header the CLI uses to identify which instance is polling. Used by GET to
 *  detect when another CLI on the same account has rotated the id. */
export const FREEBUFF_INSTANCE_HEADER = 'x-freebuff-instance-id'
/** Header the CLI sends on POST to pick which model's queue to join. */
export const FREEBUFF_MODEL_HEADER = 'x-freebuff-model'

export interface FreebuffSessionDeps {
  getUserInfoFromApiKey: GetUserInfoFromApiKeyFn
  logger: Logger
  sessionDeps?: SessionDeps
  getCountryAccess?: GetCountryAccessFn
}

type AuthResult =
  | { error: NextResponse }
  | { userId: string; userBanned: boolean }

async function resolveUser(
  req: NextRequest,
  deps: FreebuffSessionDeps,
): Promise<AuthResult> {
  const apiKey = extractApiKeyFromHeader(req)
  if (!apiKey) {
    return {
      error: NextResponse.json(
        {
          error: 'unauthorized',
          message: 'Missing or invalid Authorization header',
        },
        { status: 401 },
      ),
    }
  }
  const userInfo = await deps.getUserInfoFromApiKey({
    apiKey,
    fields: ['id', 'banned'],
    logger: deps.logger,
  })
  if (!userInfo?.id) {
    return {
      error: NextResponse.json(
        { error: 'unauthorized', message: 'Invalid API key' },
        { status: 401 },
      ),
    }
  }
  return {
    userId: String(userInfo.id),
    userBanned: Boolean(userInfo.banned),
  }
}

function serverError(
  deps: FreebuffSessionDeps,
  route: string,
  userId: string | null,
  error: unknown,
): NextResponse {
  const err = error instanceof Error ? error : new Error(String(error))
  deps.logger.error(
    {
      route,
      userId,
      errorName: err.name,
      errorMessage: err.message,
      errorCode: (err as any).code,
      cause:
        (err as any).cause instanceof Error
          ? {
              name: (err as any).cause.name,
              message: (err as any).cause.message,
              code: (err as any).cause.code,
            }
          : (err as any).cause,
      stack: err.stack,
    },
    '[freebuff/session] handler failed',
  )
  return NextResponse.json(
    { error: 'internal_error', message: err.message },
    { status: 500 },
  )
}

/** POST /api/v1/freebuff/session — join queue / take over as this instance. */
export async function postFreebuffSession(
  req: NextRequest,
  deps: FreebuffSessionDeps,
): Promise<NextResponse> {
  const auth = await resolveUser(req, deps)
  if ('error' in auth) return auth.error

  const countryAccess = await getCountryAccess(auth.userId, req, deps)
  const accessTier = getFreeModeAccessTier(countryAccess)

  const requestedModel = req.headers.get(FREEBUFF_MODEL_HEADER) ?? ''

  try {
    const state = await requestSession({
      userId: auth.userId,
      userBanned: auth.userBanned,
      model: requestedModel,
      accessTier,
      countryAccess: toSessionCountryAccess(countryAccess),
      deps: deps.sessionDeps,
    })
    // model_locked / model_unavailable are 409 so they're distinguishable
    // from normal queued/active responses on the client. banned is a 403
    // (terminal, mirrors country_blocked) so older CLIs that don't know the
    // status fall into their `!resp.ok` error path and back off instead of
    // tight-polling on the unrecognized 200 body. rate_limited uses 429 for
    // the same reason as banned — older CLIs back off, newer CLIs parse the
    // structured body.
    const status =
      state.status === 'model_locked' || state.status === 'model_unavailable'
        ? 409
        : state.status === 'banned'
          ? 403
          : state.status === 'rate_limited'
            ? 429
            : 200
    return NextResponse.json(state, { status })
  } catch (error) {
    return serverError(deps, 'POST', auth.userId, error)
  }
}

/** GET /api/v1/freebuff/session — read current state without mutation. The
 *  caller's instance id (via X-Freebuff-Instance-Id) is used to detect
 *  takeover by another CLI on the same account. */
export async function getFreebuffSession(
  req: NextRequest,
  deps: FreebuffSessionDeps,
): Promise<NextResponse> {
  const auth = await resolveUser(req, deps)
  if ('error' in auth) return auth.error

  try {
    const countryAccess = await getCountryAccess(auth.userId, req, deps)
    const accessTier = getFreeModeAccessTier(countryAccess)

    const claimedInstanceId =
      req.headers.get(FREEBUFF_INSTANCE_HEADER) ?? undefined
    const state = await getSessionState({
      userId: auth.userId,
      accessTier,
      userBanned: auth.userBanned,
      claimedInstanceId,
      deps: deps.sessionDeps,
    })
    if (state.status === 'none') {
      return NextResponse.json(
        {
          status: 'none',
          accessTier: state.accessTier,
          message: 'Call POST to join the waiting room.',
          queueDepthByModel: state.queueDepthByModel,
          rateLimitsByModel: state.rateLimitsByModel,
        },
        { status: 200 },
      )
    }
    // banned is terminal; 403 for the same reason as country_blocked — older
    // CLIs that don't know this status treat it as a generic error.
    const status = state.status === 'banned' ? 403 : 200
    return NextResponse.json(state, { status })
  } catch (error) {
    return serverError(deps, 'GET', auth.userId, error)
  }
}

/** DELETE /api/v1/freebuff/session — end session / leave queue immediately. */
export async function deleteFreebuffSession(
  req: NextRequest,
  deps: FreebuffSessionDeps,
): Promise<NextResponse> {
  const auth = await resolveUser(req, deps)
  if ('error' in auth) return auth.error

  try {
    await endUserSession({
      userId: auth.userId,
      deps: deps.sessionDeps,
    })
    return NextResponse.json({ status: 'ended' }, { status: 200 })
  } catch (error) {
    return serverError(deps, 'DELETE', auth.userId, error)
  }
}
