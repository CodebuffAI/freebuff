import { useMutation } from '@tanstack/react-query'
import { randomUUID } from 'node:crypto'
import { safeOpen } from '../utils/open-url'

import { LOGIN_WEBSITE_URL } from '../login/constants'
import { generateLoginUrl } from '../login/login-flow'
import {
  loginLoopbackSupported,
  startLoginLoopback,
} from '../login/loopback-server'
import { getCliEnv } from '../utils/env'
import { captureCliFunnel } from '../utils/cli-product-funnel'
import { trackEvent } from '../utils/analytics'
import { logger } from '../utils/logger'
import { IS_FREEBUFF } from '../utils/constants'

interface UseFetchLoginUrlParams {
  setLoginUrl: (url: string | null) => void
  setFingerprintHash: (hash: string | null) => void
  setExpiresAt: (expiresAt: string | null) => void
  setIsWaitingForEnter: (waiting: boolean) => void
  setHasOpenedBrowser: (opened: boolean) => void
  setError: (error: string | null) => void
}

/**
 * Custom hook that handles fetching the login URL and opening the browser
 */
export function useFetchLoginUrl({
  setLoginUrl,
  setFingerprintHash,
  setExpiresAt,
  setIsWaitingForEnter,
  setHasOpenedBrowser,
  setError,
}: UseFetchLoginUrlParams) {
  const fetchLoginUrlMutation = useMutation({
    mutationFn: async (fingerprintId: string) => {
      captureCliFunnel('login', 'started')
      return generateLoginUrl(
        {
          logger,
          trackEvent,
        },
        {
          baseUrl: LOGIN_WEBSITE_URL,
          fingerprintId,
          via: 'modal',
          cliFlowId: IS_FREEBUFF ? randomUUID() : undefined,
        },
      )
    },
    onSuccess: async (data) => {
      captureCliFunnel('login', 'ready')
      setLoginUrl(data.loginUrl)
      setFingerprintHash(data.fingerprintHash)
      setExpiresAt(data.expiresAt)
      setIsWaitingForEnter(true)
      setHasOpenedBrowser(true)

      // Open the login through a loopback server when the browser runs on
      // this machine, so /onboard can connect without the Connect click
      // (login/loopback-server.ts). The URL shown for copying stays plain.
      const loopback = loginLoopbackSupported(getCliEnv(), process.platform)
        ? startLoginLoopback({
            hostedLoginUrl: data.loginUrl,
            fingerprintHash: data.fingerprintHash,
          })
        : null

      // OS handoff cannot confirm the browser loaded the auth page.
      const opened = await safeOpen(loopback?.launchUrl ?? data.loginUrl)
      captureCliFunnel('browser', opened ? 'opened' : 'failed')
    },
    onError: (err) => {
      captureCliFunnel('login', 'failed', { reason: 'error' })
      setError(err instanceof Error ? err.message : 'Failed to get login URL')
      logger.error(
        {
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to get login URL',
      )
    },
  })

  return fetchLoginUrlMutation
}
