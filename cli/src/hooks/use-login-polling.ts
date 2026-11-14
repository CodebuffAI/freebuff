import { useEffect, useRef } from 'react'

import { LOGIN_WEBSITE_URL } from '../login/constants'
import { pollLoginStatus } from '../login/login-flow'
import { captureCliFunnel } from '../utils/cli-product-funnel'
import { trackEvent } from '../utils/analytics'
import { logger } from '../utils/logger'

import type { User } from '../utils/auth'

interface UseLoginPollingParams {
  loginUrl: string | null
  fingerprintId: string | null
  fingerprintHash: string | null
  expiresAt: string | null
  isWaitingForEnter: boolean
  onSuccess: (user: User) => void
  onTimeout: () => void
  onError: (error: string) => void
}

/**
 * Custom hook that handles polling for login status
 * Extracts the 109-line polling effect from login-modal.tsx
 */
export function useLoginPolling({
  loginUrl,
  fingerprintId,
  fingerprintHash,
  expiresAt,
  isWaitingForEnter,
  onSuccess,
  onTimeout,
  onError,
}: UseLoginPollingParams) {
  // Store callbacks in refs to prevent effect re-runs
  const onSuccessRef = useRef(onSuccess)
  const onTimeoutRef = useRef(onTimeout)
  const onErrorRef = useRef(onError)

  useEffect(() => {
    onSuccessRef.current = onSuccess
  }, [onSuccess])

  useEffect(() => {
    onTimeoutRef.current = onTimeout
  }, [onTimeout])

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    // fingerprintHash only becomes non-null after the login-URL mutation
    // succeeds, and that path always sets fingerprintId first — so gating
    // on fingerprintHash implicitly gates on fingerprintId.
    if (!loginUrl || !fingerprintId || !fingerprintHash || !expiresAt || !isWaitingForEnter) {
      return
    }

    let active = true

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      })

    pollLoginStatus(
      {
        sleep,
        logger,
        trackEvent,
      },
      {
        baseUrl: LOGIN_WEBSITE_URL,
        fingerprintId: fingerprintId!,
        fingerprintHash,
        expiresAt,
        shouldContinue: () => active,
        via: 'modal',
      },
    )
      .then((result) => {
        if (!active) {
          return
        }

        if (result.status === 'success') {
          const user = result.user as User
          onSuccessRef.current(user)
        } else if (result.status === 'timeout') {
          captureCliFunnel('login', 'failed', { reason: 'timeout' })
          logger.warn('Login polling timed out after configured limit')
          onTimeoutRef.current()
        }
      })
      .catch((error) => {
        if (!active) {
          return
        }
        logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          '💥 Unexpected error while polling login status',
        )
        onErrorRef.current(
          error instanceof Error ? error.message : 'Failed to complete login',
        )
      })

    return () => {
      active = false
    }
  }, [loginUrl, fingerprintHash, expiresAt, isWaitingForEnter, fingerprintId])
}
