import { createHash } from 'crypto'

import { getCiEnv } from '@codebuff/common/env-ci'
import {
  getUserInfoFromApiKey as defaultGetUserInfoFromApiKey,
  isRetryableStatusCode,
  getErrorStatusCode,
  createAuthError,
  createServerError,
  MAX_RETRIES_PER_MESSAGE,
  RETRY_BACKOFF_BASE_DELAY_MS,
} from '@codebuff/sdk'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

import {
  getUserCredentials as defaultGetUserCredentials,
  saveUserCredentials as defaultSaveUserCredentials,
  logoutUser as logoutUserUtil,
  type User,
} from '../utils/auth'
import { resetCodebuffClient } from '../utils/codebuff-client'
import { logger as defaultLogger, loggerContext } from '../utils/logger'

import type { GetUserInfoFromApiKeyFn } from '@codebuff/common/types/contracts/database'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const getApiKeyHash = (apiKey: string): string => {
  return createHash('sha256').update(apiKey).digest('hex')
}

// Query keys for type-safe cache management
export const authQueryKeys = {
  all: ['auth'] as const,
  user: () => [...authQueryKeys.all, 'user'] as const,
  validation: (apiKey: string) =>
    [...authQueryKeys.all, 'validation', getApiKeyHash(apiKey)] as const,
}

interface ValidateAuthParams {
  apiKey: string
  getUserInfoFromApiKey?: GetUserInfoFromApiKeyFn
  logger?: Logger
}

type ValidatedUserInfo = {
  id: string
  email: string
}

/**
 * Check if an error is an authentication error (401, 403)
 */
function isAuthenticationError(error: unknown): boolean {
  const statusCode = getErrorStatusCode(error)
  return statusCode === 401 || statusCode === 403
}

/**
 * Validates an API key by calling the backend
 *
 * CHANGE: Exported for testing purposes and accepts optional dependencies
 * Previously this was not exported, making it impossible to test in isolation
 */
export async function validateApiKey({
  apiKey,
  getUserInfoFromApiKey = defaultGetUserInfoFromApiKey,
  logger = defaultLogger,
}: ValidateAuthParams): Promise<ValidatedUserInfo> {
  const requestedFields = ['id', 'email'] as const

  try {
    const authResult = await getUserInfoFromApiKey({
      apiKey,
      fields: requestedFields,
      logger,
    })

    if (!authResult) {
      logger.error('❌ API key validation failed - invalid credentials')
      throw createAuthError('Invalid API key')
    }

    return authResult
  } catch (error) {
    const statusCode = getErrorStatusCode(error)

    if (isAuthenticationError(error)) {
      logger.error('❌ API key validation failed - authentication error')
      // Rethrow the original error to preserve statusCode for higher layers
      throw error
    }

    if (statusCode !== undefined && isRetryableStatusCode(statusCode)) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          statusCode,
        },
        '❌ API key validation failed - network error',
      )
      // Rethrow the original error to preserve statusCode for higher layers
      throw error
    }

    // Unknown error - wrap with statusCode for consistency
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      '❌ API key validation failed - unknown error',
    )
    throw createServerError('Authentication failed')
  }
}

export interface UseAuthQueryDeps {
  getUserCredentials?: () => User | null
  getUserInfoFromApiKey?: GetUserInfoFromApiKeyFn
  logger?: Logger
  enabled?: boolean
}

/**
 * Hook to validate authentication status
 * Uses stored credentials if available, otherwise checks environment variable
 *
 * CHANGE: Now accepts optional dependencies for testing via dependency injection
 */
export function useAuthQuery(deps: UseAuthQueryDeps = {}) {
  const {
    getUserCredentials = defaultGetUserCredentials,
    getUserInfoFromApiKey = defaultGetUserInfoFromApiKey,
    logger = defaultLogger,
    enabled = true,
  } = deps

  const userCredentials = getUserCredentials()
  const apiKey = userCredentials?.authToken || getCiEnv().CODEBUFF_API_KEY || ''

  return useQuery({
    queryKey: authQueryKeys.validation(apiKey),
    queryFn: () => validateApiKey({ apiKey, getUserInfoFromApiKey, logger }),
    enabled: enabled && !!apiKey,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    // Retry only for retryable network errors (5xx, timeouts, etc.)
    // Don't retry authentication errors (invalid credentials)
    retry: (failureCount, error) => {
      const statusCode = getErrorStatusCode(error)
      // Don't retry authentication errors - user needs to update credentials
      if (isAuthenticationError(error)) {
        return false
      }
      // Retry network errors if they're retryable and we haven't exceeded max retries
      if (statusCode !== undefined && isRetryableStatusCode(statusCode)) {
        return failureCount < MAX_RETRIES_PER_MESSAGE
      }
      // Don't retry other errors
      return false
    },
    retryDelay: (attemptIndex) => {
      // Exponential backoff: 1s, 2s, 4s
      return Math.min(
        RETRY_BACKOFF_BASE_DELAY_MS * Math.pow(2, attemptIndex),
        8000, // Cap at 8 seconds
      )
    },
  })
}

export interface UseLoginMutationDeps {
  saveUserCredentials?: (user: User) => void
  getUserInfoFromApiKey?: GetUserInfoFromApiKeyFn
  logger?: Logger
}

/**
 * Hook for login mutation
 *
 * CHANGE: Now accepts optional dependencies for testing via dependency injection
 */
export function useLoginMutation(deps: UseLoginMutationDeps = {}) {
  const queryClient = useQueryClient()
  const {
    saveUserCredentials = defaultSaveUserCredentials,
    getUserInfoFromApiKey = defaultGetUserInfoFromApiKey,
    logger = defaultLogger,
  } = deps

  return useMutation({
    mutationFn: async (user: User) => {
      // Save credentials to file system
      saveUserCredentials(user)

      // Validate the new credentials
      const authResult = await validateApiKey({
        apiKey: user.authToken,
        getUserInfoFromApiKey,
        logger,
      })

      const mergedUser = { ...user, ...authResult }
      return mergedUser
    },
    onSuccess: () => {
      // Invalidate auth queries to trigger refetch with new credentials
      queryClient.invalidateQueries({ queryKey: authQueryKeys.all })
    },
    onError: (error) => {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        '❌ Login mutation failed',
      )
    },
  })
}

export interface UseLogoutMutationDeps {
  logoutUser?: () => Promise<boolean>
  logger?: Logger
}

/**
 * Hook for logout mutation
 *
 * CHANGE: Now accepts optional dependencies for testing via dependency injection
 */
export function useLogoutMutation(deps: UseLogoutMutationDeps = {}) {
  const queryClient = useQueryClient()
  const { logoutUser = logoutUserUtil, logger = defaultLogger } = deps

  return useMutation({
    mutationFn: logoutUser,
    onSuccess: () => {
      // Reset the SDK client after logout
      resetCodebuffClient()
      // Clear all auth-related cache
      queryClient.removeQueries({ queryKey: authQueryKeys.all })
      // Clear logger context
      delete loggerContext.userId
      delete loggerContext.userEmail
    },
    onError: (error) => {
      logger.error(error, 'Logout failed')
    },
  })
}
