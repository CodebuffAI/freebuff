import { useActivityQuery } from './use-activity-query'
import { getAuthToken } from '../utils/auth'
import { IS_FREEBUFF } from '../utils/constants'
import { getApiClient } from '../utils/codebuff-api'
import { logger as defaultLogger } from '../utils/logger'

import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { SubscriptionResponse } from '@codebuff/common/types/subscription'

export type { SubscriptionResponse }

export const subscriptionQueryKeys = {
  all: ['subscription'] as const,
  current: () => [...subscriptionQueryKeys.all, 'current'] as const,
}

export async function fetchSubscriptionData(
  logger: Logger = defaultLogger,
): Promise<SubscriptionResponse> {
  const client = getApiClient()
  const response = await client.get<SubscriptionResponse>(
    '/api/user/subscription',
  )

  if (!response.ok) {
    logger.debug(
      { status: response.status },
      'Failed to fetch subscription data',
    )
    throw new Error(`Failed to fetch subscription: ${response.status}`)
  }

  return response.data!
}

export interface UseSubscriptionQueryDeps {
  logger?: Logger
  enabled?: boolean
  refetchInterval?: number | false
  refetchOnActivity?: boolean
  pauseWhenIdle?: boolean
  idleThreshold?: number
}

export function useSubscriptionQuery(deps: UseSubscriptionQueryDeps = {}) {
  const {
    logger = defaultLogger,
    enabled = true,
    refetchInterval = 60 * 1000,
    refetchOnActivity = true,
    pauseWhenIdle = true,
    idleThreshold = 30_000,
  } = deps

  const authToken = getAuthToken()

  return useActivityQuery({
    queryKey: subscriptionQueryKeys.current(),
    queryFn: () => fetchSubscriptionData(logger),
    enabled: enabled && !!authToken && !IS_FREEBUFF,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
    retry: 1,
    refetchOnMount: true,
    refetchInterval,
    refetchOnActivity,
    pauseWhenIdle,
    idleThreshold,
  })
}
