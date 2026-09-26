import { describe, test, expect } from 'bun:test'
import {
  FREEBUFF_PROVIDER_USAGE_MESSAGE,
  FREEBUFF_TURN_SPEND_LIMIT_ERROR_CODE,
  FREEBUFF_TURN_SPEND_LIMIT_MESSAGE,
} from '@codebuff/common/constants/freebuff-errors'

import {
  getFreebuffRateLimitErrorMessage,
  getFreeModeUnavailableErrorMessage,
  isOutOfCreditsError,
  isFreeModeUnavailableError,
  getCountryBlockFromFreeModeError,
  OUT_OF_CREDITS_MESSAGE,
  FREE_MODE_UNAVAILABLE_MESSAGE,
  FREEBUFF_RATE_LIMIT_MESSAGE,
  isFreebuffProviderUsageError,
  createErrorMessage,
} from '../error-handling'

describe('error-handling', () => {
  describe('isOutOfCreditsError', () => {
    test('returns true for error with statusCode 402', () => {
      const error = { statusCode: 402, message: 'Payment required' }
      expect(isOutOfCreditsError(error)).toBe(true)
    })

    test('returns false for error with statusCode 401', () => {
      const error = { statusCode: 401, message: 'Unauthorized' }
      expect(isOutOfCreditsError(error)).toBe(false)
    })

    test('returns false for error with statusCode 403', () => {
      const error = { statusCode: 403, message: 'Forbidden' }
      expect(isOutOfCreditsError(error)).toBe(false)
    })

    test('returns false for error with statusCode 500', () => {
      const error = { statusCode: 500, message: 'Server error' }
      expect(isOutOfCreditsError(error)).toBe(false)
    })

    test('returns false for null error', () => {
      expect(isOutOfCreditsError(null)).toBe(false)
    })

    test('returns false for undefined error', () => {
      expect(isOutOfCreditsError(undefined)).toBe(false)
    })

    test('returns false for string error', () => {
      expect(isOutOfCreditsError('error string')).toBe(false)
    })

    test('returns false for Error object without statusCode', () => {
      const error = new Error('Plain error')
      expect(isOutOfCreditsError(error)).toBe(false)
    })

    test('returns false for error with non-402 numeric statusCode', () => {
      const error = { statusCode: 400, message: 'Bad request' }
      expect(isOutOfCreditsError(error)).toBe(false)
    })

    test('returns false for error with string statusCode', () => {
      const error = { statusCode: '402', message: 'Payment required' }
      expect(isOutOfCreditsError(error)).toBe(false)
    })

    test('returns true for 402 errors with additional properties', () => {
      const error = {
        statusCode: 402,
        message: 'Payment required',
        details: { credits: 0 },
        timestamp: new Date().toISOString(),
      }
      expect(isOutOfCreditsError(error)).toBe(true)
    })
  })

  describe('isFreeModeUnavailableError', () => {
    test('returns true for error with statusCode 403 and error free_mode_unavailable', () => {
      const error = {
        statusCode: 403,
        error: 'free_mode_unavailable',
        message: 'Free mode is not available in your country.',
      }
      expect(isFreeModeUnavailableError(error)).toBe(true)
    })

    test('returns true for responseBody free_mode_unavailable errors', () => {
      expect(
        isFreeModeUnavailableError({
          statusCode: 403,
          responseBody: JSON.stringify({
            error: 'free_mode_unavailable',
            message: 'Freebuff cannot be used from VPN traffic.',
          }),
        }),
      ).toBe(true)
    })

    test('returns false for 403 without error field', () => {
      const error = { statusCode: 403, message: 'Forbidden' }
      expect(isFreeModeUnavailableError(error)).toBe(false)
    })

    test('returns false for 403 with different error code', () => {
      const error = {
        statusCode: 403,
        error: 'account_suspended',
        message: 'Suspended',
      }
      expect(isFreeModeUnavailableError(error)).toBe(false)
    })

    test('returns false for non-403 status with free_mode_unavailable error', () => {
      const error = {
        statusCode: 400,
        error: 'free_mode_unavailable',
        message: 'Bad request',
      }
      expect(isFreeModeUnavailableError(error)).toBe(false)
    })

    test('returns false for null', () => {
      expect(isFreeModeUnavailableError(null)).toBe(false)
    })

    test('returns false for undefined', () => {
      expect(isFreeModeUnavailableError(undefined)).toBe(false)
    })

    test('returns false for plain Error object', () => {
      expect(isFreeModeUnavailableError(new Error('Forbidden'))).toBe(false)
    })
  })

  describe('getFreebuffRateLimitErrorMessage', () => {
    test('shows the per-turn spend breaker copy verbatim, not a rate-limit framing', () => {
      expect(
        getFreebuffRateLimitErrorMessage({
          type: 'error',
          statusCode: 429,
          error: FREEBUFF_TURN_SPEND_LIMIT_ERROR_CODE,
          message: FREEBUFF_TURN_SPEND_LIMIT_MESSAGE,
        }),
      ).toBe(FREEBUFF_TURN_SPEND_LIMIT_MESSAGE)
    })

    test('returns the generic message for untyped 429 errors', () => {
      expect(
        getFreebuffRateLimitErrorMessage({
          statusCode: 429,
          message: 'Too Many Requests',
        }),
      ).toBe(FREEBUFF_RATE_LIMIT_MESSAGE)
    })

    test('returns the generic message for thrown API errors with status 429', () => {
      expect(
        getFreebuffRateLimitErrorMessage({
          status: 429,
          message: 'Too Many Requests',
        }),
      ).toBe(FREEBUFF_RATE_LIMIT_MESSAGE)
    })

    test('returns the generic message for retry-wrapped untyped 429 errors', () => {
      expect(
        getFreebuffRateLimitErrorMessage({
          message: 'Failed after 4 attempts. Last error: Too Many Requests',
          lastError: {
            statusCode: 429,
            message: 'Too Many Requests',
          },
        }),
      ).toBe(FREEBUFF_RATE_LIMIT_MESSAGE)
    })

    test('returns null for non-429 status codes', () => {
      expect(getFreebuffRateLimitErrorMessage({ statusCode: 402 })).toBe(null)
      expect(getFreebuffRateLimitErrorMessage({ statusCode: 500 })).toBe(null)
    })

    test('returns null for string statusCode', () => {
      expect(getFreebuffRateLimitErrorMessage({ statusCode: '429' })).toBe(
        null,
      )
    })

    test('preserves normalized free mode quota messages', () => {
      const message =
        'Free mode rate limit exceeded (1 minute limit). Try again in 30 seconds.'

      expect(
        getFreebuffRateLimitErrorMessage({
          statusCode: 429,
          error: 'free_mode_rate_limited',
          message,
        }),
      ).toBe(message)
    })

    test('preserves responseBody free mode quota messages', () => {
      const message =
        'Free mode rate limit exceeded (1 minute limit). Try again in 30 seconds.'

      expect(
        getFreebuffRateLimitErrorMessage({
          statusCode: 429,
          message: 'Too Many Requests',
          responseBody: JSON.stringify({
            error: 'free_mode_rate_limited',
            message,
          }),
        }),
      ).toBe(message)
    })

    test('preserves retry-wrapped free mode quota messages', () => {
      const message =
        'Free mode rate limit exceeded (1 minute limit). Try again in 30 seconds.'

      expect(
        getFreebuffRateLimitErrorMessage({
          message: 'Failed after 4 attempts. Last error: Too Many Requests',
          lastError: {
            statusCode: 429,
            message: 'Too Many Requests',
            responseBody: JSON.stringify({
              error: 'free_mode_rate_limited',
              message,
            }),
          },
        }),
      ).toBe(message)
    })

    test('falls back to the generic message when typed quota errors have no message', () => {
      expect(
        getFreebuffRateLimitErrorMessage({
          statusCode: 429,
          error: 'free_mode_rate_limited',
        }),
      ).toBe(FREEBUFF_RATE_LIMIT_MESSAGE)
    })

    test('appends detail from agent-run output objects for untyped 429s', () => {
      expect(
        getFreebuffRateLimitErrorMessage({
          type: 'error',
          statusCode: 429,
          message: 'Model is at capacity. Please try again later.',
        }),
      ).toBe(
        `${FREEBUFF_RATE_LIMIT_MESSAGE} (Model is at capacity. Please try again later.)`,
      )
    })

    test('appends detail from OpenAI-style nested provider error bodies', () => {
      expect(
        getFreebuffRateLimitErrorMessage({
          statusCode: 429,
          message: 'Too Many Requests',
          responseBody: JSON.stringify({
            error: {
              message: 'Model is at capacity. Please try again later.',
              code: null,
              type: 'rate_limit_error',
            },
          }),
        }),
      ).toBe(
        `${FREEBUFF_RATE_LIMIT_MESSAGE} (Model is at capacity. Please try again later.)`,
      )
    })

    test('does not echo bare HTTP status text from output objects', () => {
      expect(
        getFreebuffRateLimitErrorMessage({
          type: 'error',
          statusCode: 429,
          message: 'Too Many Requests',
        }),
      ).toBe(FREEBUFF_RATE_LIMIT_MESSAGE)
    })
  })

  describe('isFreebuffProviderUsageError', () => {
    test('recognizes Freebuff provider usage failures across upstream shapes', () => {
      for (const error of [
        {
          statusCode: 402,
          message: 'Payment required',
        },
        { statusCode: 401, message: 'Not Enough Credits' },
        {
          type: 'error',
          statusCode: 403,
          message:
            'Insufficient credits. Add more using https://openrouter.ai/settings/credits',
        },
        {
          statusCode: 401,
          responseBody: JSON.stringify({
            error: { message: 'Not Enough Credits' },
          }),
        },
      ]) {
        expect(isFreebuffProviderUsageError(error)).toBe(true)
      }
    })

    // Prod 2026-09-26: a paid (lite) Codebuff request answered 402 with the
    // user's OWN balance message; the CLI said "this is on us, not your
    // account" instead of the out-of-credits flow.
    test("the user's own Codebuff out-of-credits 402 is not a provider problem", () => {
      for (const error of [
        {
          statusCode: 402,
          responseBody: JSON.stringify({
            message:
              'Out of credits. Please add credits at https://www.codebuff.com/usage.',
          }),
        },
        {
          statusCode: 402,
          message:
            'Out of credits. Please add credits at https://www.codebuff.com/usage.',
        },
      ]) {
        expect(isFreebuffProviderUsageError(error)).toBe(false)
      }
    })

    test('does not rewrite unrelated failures', () => {
      expect(
        isFreebuffProviderUsageError({
          statusCode: 500,
          message: 'Internal server error',
        }),
      ).toBe(false)
    })
  })

  describe('getCountryBlockFromFreeModeError', () => {
    test('extracts country block details from free-mode unavailable errors', () => {
      const error = {
        statusCode: 403,
        error: 'free_mode_unavailable',
        countryCode: 'US',
        countryBlockReason: 'anonymous_network',
        ipPrivacySignals: ['vpn', 'hosting', 123],
      }

      expect(getCountryBlockFromFreeModeError(error)).toEqual({
        countryCode: 'US',
        countryBlockReason: 'anonymous_network',
        ipPrivacySignals: ['vpn', 'hosting'],
      })
    })

    test('extracts country block details from responseBody errors', () => {
      const error = {
        statusCode: 403,
        responseBody: JSON.stringify({
          error: 'free_mode_unavailable',
          countryCode: 'US',
          countryBlockReason: 'anonymous_network',
          ipPrivacySignals: ['proxy', 'hosting', 123],
        }),
      }

      expect(getCountryBlockFromFreeModeError(error)).toEqual({
        countryCode: 'US',
        countryBlockReason: 'anonymous_network',
        ipPrivacySignals: ['proxy', 'hosting'],
      })
    })

    test('defaults missing country code to UNKNOWN', () => {
      const error = {
        statusCode: 403,
        error: 'free_mode_unavailable',
      }

      expect(getCountryBlockFromFreeModeError(error)).toEqual({
        countryCode: 'UNKNOWN',
        countryBlockReason: undefined,
        ipPrivacySignals: undefined,
      })
    })

    test('returns null for non-free-mode errors', () => {
      expect(
        getCountryBlockFromFreeModeError({
          statusCode: 403,
          error: 'account_suspended',
        }),
      ).toBe(null)
    })
  })

  describe('FREE_MODE_UNAVAILABLE_MESSAGE', () => {
    test('mentions unavailability in country', () => {
      expect(FREE_MODE_UNAVAILABLE_MESSAGE.toLowerCase()).toContain(
        'not available in your country',
      )
    })
  })

  describe('getFreeModeUnavailableErrorMessage', () => {
    test('uses a VPN/proxy-specific message for anonymous-network blocks', () => {
      expect(
        getFreeModeUnavailableErrorMessage({
          statusCode: 403,
          error: 'free_mode_unavailable',
          message: 'Forbidden',
          countryBlockReason: 'anonymous_network',
          ipPrivacySignals: ['vpn', 'hosting'],
        }),
      ).toContain('VPN')
    })

    test('uses a VPN/proxy-specific message from responseBody details', () => {
      expect(
        getFreeModeUnavailableErrorMessage({
          statusCode: 403,
          message: 'Forbidden',
          responseBody: JSON.stringify({
            error: 'free_mode_unavailable',
            countryBlockReason: 'anonymous_network',
            ipPrivacySignals: ['tor'],
          }),
        }),
      ).toContain('Tor')
    })

    test('preserves server message for non-privacy free mode blocks', () => {
      expect(
        getFreeModeUnavailableErrorMessage({
          statusCode: 403,
          error: 'free_mode_unavailable',
          message: 'Free mode is not available in your country.',
        }),
      ).toBe('Free mode is not available in your country.')
    })
  })

  describe('OUT_OF_CREDITS_MESSAGE', () => {
    test('contains usage URL', () => {
      expect(OUT_OF_CREDITS_MESSAGE).toContain('/usage')
    })

    test('contains out of credits message', () => {
      expect(OUT_OF_CREDITS_MESSAGE.toLowerCase()).toContain('out of credits')
    })

    test('contains add credits instruction', () => {
      expect(OUT_OF_CREDITS_MESSAGE.toLowerCase()).toContain('add credits')
    })
  })

  describe('FREEBUFF_RATE_LIMIT_MESSAGE', () => {
    test('encourages retry without mentioning credits or payment', () => {
      const message = FREEBUFF_RATE_LIMIT_MESSAGE.toLowerCase()
      expect(message).toContain('try again')
      expect(message).not.toContain('credit')
      expect(message).not.toContain('pay')
    })
  })

  describe('FREEBUFF_PROVIDER_USAGE_MESSAGE', () => {
    test('owns the refill without blaming the user account', () => {
      const message = FREEBUFF_PROVIDER_USAGE_MESSAGE.toLowerCase()
      expect(message).toContain('freebuff ran out of provider usage')
      expect(message).toContain('needs a refill')
      expect(message).toContain('not your account')
      expect(message).not.toContain('add credits')
    })
  })

  describe('createErrorMessage', () => {
    test('creates message from Error object', () => {
      const error = new Error('Something went wrong')
      const result = createErrorMessage(error, 'msg-123')

      expect(result.id).toBe('msg-123')
      expect(result.content).toContain('Something went wrong')
      expect(result.content).toContain('**Error:**')
      expect(result.isComplete).toBe(true)
      expect(result.blocks).toBeUndefined()
    })

    test('creates message from string error', () => {
      const result = createErrorMessage('String error', 'msg-456')

      expect(result.id).toBe('msg-456')
      expect(result.content).toContain('String error')
    })

    test('creates message from object with message property', () => {
      const error = { message: 'Object error message', code: 'ERR_001' }
      const result = createErrorMessage(error, 'msg-789')

      expect(result.content).toContain('Object error message')
    })

    test('uses fallback for unknown error types', () => {
      const result = createErrorMessage(null, 'msg-null')

      expect(result.content).toContain('Unknown error occurred')
    })

    test('includes stack trace when available', () => {
      const error = new Error('Error with stack')
      const result = createErrorMessage(error, 'msg-stack')

      expect(result.content).toContain('Error with stack')
      // Stack trace should be included
      expect(result.content).toContain('at')
    })

    test('handles error without message property', () => {
      const error = { code: 'ERR_UNKNOWN' }
      const result = createErrorMessage(error, 'msg-no-msg')

      expect(result.content).toContain('Unknown error occurred')
    })

    test('handles error with empty message', () => {
      const error = { message: '' }
      const result = createErrorMessage(error, 'msg-empty')

      expect(result.content).toContain('Unknown error occurred')
    })

    test('handles error with numeric message', () => {
      const error = { message: 123 }
      const result = createErrorMessage(error, 'msg-num')

      expect(result.content).toContain('Unknown error occurred')
    })

    test('handles out of credits error', () => {
      const error = { statusCode: 402, message: 'Payment required' }
      const result = createErrorMessage(error, 'msg-402')

      expect(result.content).toContain('Payment required')
    })

    test('preserves message ID', () => {
      const error = new Error('Test')
      const result = createErrorMessage(error, 'unique-id-123')

      expect(result.id).toBe('unique-id-123')
    })

    test('marks message as complete', () => {
      const error = new Error('Test')
      const result = createErrorMessage(error, 'msg-complete')

      expect(result.isComplete).toBe(true)
    })

    test('clears blocks from error message', () => {
      const error = new Error('Test')
      const result = createErrorMessage(error, 'msg-blocks')

      expect(result.blocks).toBeUndefined()
    })

    test('handles deeply nested error objects', () => {
      const error = {
        message: 'Outer error',
        cause: {
          message: 'Inner error',
          cause: {
            message: 'Root cause',
          },
        },
      }
      const result = createErrorMessage(error, 'msg-nested')

      // Should only extract the top-level message
      expect(result.content).toContain('Outer error')
    })

    test('handles API error responses', () => {
      const apiError = {
        message: 'API request failed',
        statusCode: 500,
        response: { error: 'Internal server error' },
      }
      const result = createErrorMessage(apiError, 'msg-api')

      expect(result.content).toContain('API request failed')
    })

    test('handles network timeout errors', () => {
      const timeoutError = new Error('Request timeout')
      ;(timeoutError as any).code = 'ETIMEDOUT'
      const result = createErrorMessage(timeoutError, 'msg-timeout')

      expect(result.content).toContain('Request timeout')
    })

    test('handles auth errors', () => {
      const authError = {
        statusCode: 401,
        message: 'Invalid authentication token',
      }
      const result = createErrorMessage(authError, 'msg-auth')

      expect(result.content).toContain('Invalid authentication token')
    })
  })

  describe('error scenarios', () => {
    test('handles rate limit error (429)', () => {
      const rateLimitError = {
        statusCode: 429,
        message: 'Too many requests',
        retryAfter: 60,
      }

      expect(isOutOfCreditsError(rateLimitError)).toBe(false)

      const result = createErrorMessage(rateLimitError, 'msg-rate')
      expect(result.content).toContain('Too many requests')
    })

    test('handles server error (500)', () => {
      const serverError = {
        statusCode: 500,
        message: 'Internal server error',
      }

      expect(isOutOfCreditsError(serverError)).toBe(false)

      const result = createErrorMessage(serverError, 'msg-500')
      expect(result.content).toContain('Internal server error')
    })

    test('handles validation error (400)', () => {
      const validationError = {
        statusCode: 400,
        message: 'Invalid request parameters',
        errors: [{ field: 'prompt', message: 'Required' }],
      }

      expect(isOutOfCreditsError(validationError)).toBe(false)

      const result = createErrorMessage(validationError, 'msg-400')
      expect(result.content).toContain('Invalid request parameters')
    })

    test('handles forbidden error (403)', () => {
      const forbiddenError = {
        statusCode: 403,
        message: 'Access denied',
      }

      expect(isOutOfCreditsError(forbiddenError)).toBe(false)

      const result = createErrorMessage(forbiddenError, 'msg-403')
      expect(result.content).toContain('Access denied')
    })

    test('handles not found error (404)', () => {
      const notFoundError = {
        statusCode: 404,
        message: 'Resource not found',
      }

      expect(isOutOfCreditsError(notFoundError)).toBe(false)

      const result = createErrorMessage(notFoundError, 'msg-404')
      expect(result.content).toContain('Resource not found')
    })

    test('handles conflict error (409)', () => {
      const conflictError = {
        statusCode: 409,
        message: 'Conflict detected',
      }

      expect(isOutOfCreditsError(conflictError)).toBe(false)

      const result = createErrorMessage(conflictError, 'msg-409')
      expect(result.content).toContain('Conflict detected')
    })
  })
})
