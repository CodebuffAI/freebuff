import { env } from '@codebuff/common/env'
import { extractApiErrorDetails } from '@codebuff/common/util/error'
import { formatFreebuffHardBlockedPrivacySignals } from '@codebuff/common/util/freebuff-privacy'

import type { ChatMessage } from '../types/chat'
import type {
  FreebuffCountryBlockReason,
  FreebuffIpPrivacySignal,
} from '@codebuff/common/types/freebuff-session'

import { IS_FREEBUFF } from './constants'

const defaultAppUrl = env.NEXT_PUBLIC_CODEBUFF_APP_URL || 'https://codebuff.com'

// Normalize unknown errors to a user-facing string.
const extractErrorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === 'string') {
    return error
  }
  if (error instanceof Error && error.message) {
    return error.message + (error.stack ? `\n\n${error.stack}` : '')
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const candidate = (error as { message: unknown }).message
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate
    }
  }
  return fallback
}

/**
 * Check if an error indicates the user is out of credits.
 * Standardized on statusCode === 402 for payment required detection.
 */
export const isOutOfCreditsError = (error: unknown): boolean => {
  if (
    error &&
    typeof error === 'object' &&
    'statusCode' in error &&
    (error as { statusCode: unknown }).statusCode === 402
  ) {
    return true
  }
  return false
}

/**
 * Check if an error indicates free mode is not available in the user's country.
 * Standardized on statusCode === 403 + error === 'free_mode_unavailable'.
 */
export const isFreeModeUnavailableError = (error: unknown): boolean => {
  const details = getCliApiErrorDetails(error)
  return (
    details.statusCode === 403 &&
    details.errorCode === 'free_mode_unavailable'
  )
}

const getTopLevelApiErrorDetails = (
  error: unknown,
): {
  statusCode?: number
  errorCode?: string
  message?: string
  countryCode?: string
  countryBlockReason?: string
  ipPrivacySignals?: string[]
} => {
  if (!error || typeof error !== 'object') return {}
  const statusCode = (error as { statusCode?: unknown }).statusCode
  const status = (error as { status?: unknown }).status
  const errorCode = (error as { error?: unknown }).error
  const message = (error as { message?: unknown }).message
  const countryCode = (error as { countryCode?: unknown }).countryCode
  const countryBlockReason = (error as { countryBlockReason?: unknown })
    .countryBlockReason
  const ipPrivacySignals = (error as { ipPrivacySignals?: unknown })
    .ipPrivacySignals
  const resolvedStatusCode =
    typeof statusCode === 'number'
      ? statusCode
      : typeof status === 'number'
        ? status
        : undefined

  return {
    ...(resolvedStatusCode !== undefined && { statusCode: resolvedStatusCode }),
    ...(typeof errorCode === 'string' && { errorCode }),
    ...(typeof message === 'string' && message.length > 0 && { message }),
    ...(typeof countryCode === 'string' &&
      countryCode.length > 0 && { countryCode }),
    ...(typeof countryBlockReason === 'string' && { countryBlockReason }),
    ...(Array.isArray(ipPrivacySignals) && {
      ipPrivacySignals: ipPrivacySignals.filter(
        (signal): signal is string => typeof signal === 'string',
      ),
    }),
  }
}

const getCliApiErrorDetails = (error: unknown) => {
  const parsed = extractApiErrorDetails(error)
  const topLevel = getTopLevelApiErrorDetails(error)

  return {
    statusCode: topLevel.statusCode ?? parsed.statusCode,
    errorCode: topLevel.errorCode ?? parsed.errorCode,
    // Prefer responseBody messages over top-level HTTP status text.
    message: parsed.message ?? topLevel.message,
    countryCode: topLevel.countryCode ?? parsed.countryCode,
    countryBlockReason:
      topLevel.countryBlockReason ?? parsed.countryBlockReason,
    ipPrivacySignals: topLevel.ipPrivacySignals ?? parsed.ipPrivacySignals,
  }
}

export const getFreebuffRateLimitErrorMessage = (
  error: unknown,
): string | null => {
  const details = getCliApiErrorDetails(error)
  if (details.statusCode !== 429) return null
  if (details.errorCode === 'free_mode_rate_limited') {
    return details.message ?? FREEBUFF_RATE_LIMIT_MESSAGE
  }
  return FREEBUFF_RATE_LIMIT_MESSAGE
}

export const getCountryBlockFromFreeModeError = (
  error: unknown,
): {
  countryCode: string
  countryBlockReason?: FreebuffCountryBlockReason
  ipPrivacySignals?: FreebuffIpPrivacySignal[]
} | null => {
  if (!isFreeModeUnavailableError(error)) return null
  const errorDetails = getCliApiErrorDetails(error)
  const countryCode =
    typeof errorDetails.countryCode === 'string' &&
    errorDetails.countryCode.length > 0
      ? errorDetails.countryCode
      : 'UNKNOWN'

  return {
    countryCode,
    countryBlockReason:
      typeof errorDetails.countryBlockReason === 'string'
        ? (errorDetails.countryBlockReason as FreebuffCountryBlockReason)
        : undefined,
    ipPrivacySignals: errorDetails.ipPrivacySignals as
      | FreebuffIpPrivacySignal[]
      | undefined,
  }
}

export const getFreeModeUnavailableErrorMessage = (
  error: unknown,
): string => {
  const details = getCliApiErrorDetails(error)
  const block = getCountryBlockFromFreeModeError(error)
  if (block?.countryBlockReason === 'anonymous_network') {
    return `${IS_FREEBUFF ? 'Freebuff' : 'Free mode'} cannot be used from ${formatFreebuffHardBlockedPrivacySignals(
      block.ipPrivacySignals,
    )} traffic. Please disable it and try again.`
  }
  return details.message ?? FREE_MODE_UNAVAILABLE_MESSAGE
}

/**
 * Freebuff session gate errors returned by /api/v1/chat/completions.
 *
 * Contract (see docs/freebuff-waiting-room.md):
 *   - 428 `waiting_room_required`   — no session row exists; POST /session to join.
 *   - 429 `waiting_room_queued`     — row exists but still queued.
 *   - 409 `session_superseded`      — another CLI rotated our instance id.
 *   - 409 `session_model_mismatch`  — session tier/model no longer matches.
 *   - 410 `session_expired`         — active session's expires_at has passed.
 */
export type FreebuffGateErrorKind =
  | 'waiting_room_required'
  | 'waiting_room_queued'
  | 'session_superseded'
  | 'session_model_mismatch'
  | 'session_expired'

const FREEBUFF_GATE_STATUS: Record<FreebuffGateErrorKind, number> = {
  waiting_room_required: 428,
  waiting_room_queued: 429,
  session_superseded: 409,
  session_model_mismatch: 409,
  session_expired: 410,
}

export const getFreebuffGateErrorKind = (
  error: unknown,
): FreebuffGateErrorKind | null => {
  if (!error || typeof error !== 'object') return null
  const errorCode = (error as { error?: unknown }).error
  const statusCode = (error as { statusCode?: unknown }).statusCode
  if (typeof errorCode !== 'string') return null
  const expected = FREEBUFF_GATE_STATUS[errorCode as FreebuffGateErrorKind]
  if (expected === undefined || statusCode !== expected) return null
  return errorCode as FreebuffGateErrorKind
}

export const OUT_OF_CREDITS_MESSAGE = `Out of credits. Please add credits at ${defaultAppUrl}/usage`

export const FREEBUFF_RATE_LIMIT_MESSAGE =
  'Freebuff is temporarily busy. Please try again in a moment.'

export const FREE_MODE_UNAVAILABLE_MESSAGE = IS_FREEBUFF
  ? 'Freebuff is not available in your country.'
  : 'Free mode is not available in your country. You can use another mode to continue.'

export const createErrorMessage = (
  error: unknown,
  aiMessageId: string,
): Partial<ChatMessage> => {
  const message = extractErrorMessage(error, 'Unknown error occurred')

  return {
    id: aiMessageId,
    content: `**Error:** ${message}`,
    blocks: undefined,
    isComplete: true,
  }
}
