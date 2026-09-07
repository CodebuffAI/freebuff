import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { useCallback, useEffect, useState } from 'react'

import { useAuthQuery, useLogoutMutation } from './use-auth-query'
import { getSessionBoundUserId } from './use-freebuff-session'
import { useLoginStore } from '../state/login-store'
import { identifyUser, trackEvent } from '../utils/analytics'
import { clearUserCredentials, getUserCredentials } from '../utils/auth'
import { resetCodebuffClient } from '../utils/codebuff-client'
import { IS_FREEBUFF } from '../utils/constants'
import { logger, loggerContext } from '../utils/logger'
import { clearSessionBinding } from '../utils/session-binding'

import type { MultilineInputHandle } from '../components/multiline-input'
import type { User } from '../utils/auth'

const setAuthLoggerContext = (params: { userId: string; email: string }) => {
  loggerContext.userId = params.userId
  loggerContext.userEmail = params.email
  identifyUser(params.userId, { email: params.email, freebuff: IS_FREEBUFF })
}

const clearAuthLoggerContext = () => {
  delete loggerContext.userId
  delete loggerContext.userEmail
}

interface UseAuthStateOptions {
  requireAuth: boolean | null
  inputRef: React.MutableRefObject<MultilineInputHandle | null>
  setInputFocused: (focused: boolean) => void
  resetChatStore: () => void
}

export const useAuthState = ({
  requireAuth,
  inputRef,
  setInputFocused,
  resetChatStore,
}: UseAuthStateOptions) => {
  const authQuery = useAuthQuery()
  const logoutMutation = useLogoutMutation()
  const { resetLoginState } = useLoginStore()

  const initialAuthState = requireAuth === null ? null : !requireAuth
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(
    initialAuthState,
  )
  const [user, setUser] = useState<User | null>(null)

  // Update authentication state when requireAuth changes
  useEffect(() => {
    if (requireAuth === null) {
      return
    }
    setIsAuthenticated(!requireAuth)
  }, [requireAuth])

  // Update authentication state based on query results
  useEffect(() => {
    if (authQuery.isSuccess && authQuery.data) {
      setIsAuthenticated(true)
      if (!user) {
        const userCredentials = getUserCredentials()
        const userData: User = {
          id: authQuery.data.id,
          name: userCredentials?.name || '',
          email: authQuery.data.email || '',
          authToken: userCredentials?.authToken || '',
        }
        setUser(userData)
        // Identify first so the login event is attributed to the real user id
        // and the pre-login anonymous history is aliased in.
        setAuthLoggerContext({
          userId: authQuery.data.id,
          email: authQuery.data.email || '',
        })
        // Returning users restore an existing session instead of going through
        // the login modal, so `cli.login` would otherwise never fire for them —
        // making them look like a login-step drop-off in the funnel even though
        // they're authenticated. Emit it here too, tagged by `via`.
        trackEvent(AnalyticsEvent.LOGIN, {
          userId: authQuery.data.id,
          via: 'session_restore',
          hasEmail: Boolean(authQuery.data.email),
          hasName: Boolean(userCredentials?.name),
        })
      }
    } else if (authQuery.isError) {
      setIsAuthenticated(false)
      setUser(null)
      clearAuthLoggerContext()
    }
  }, [authQuery.isSuccess, authQuery.isError, authQuery.data, user])

  // Handle successful login. Returns a rejection reason if the login was
  // blocked (e.g. session bound to a different account), or null on success.
  const handleLoginSuccess = useCallback(
    (loggedInUser: User): string | null => {
      // Prevent multi-account abuse: if a session is bound to a different user,
      // reject the login and clear the just-saved credentials.
      const boundUserId = getSessionBoundUserId()
      if (boundUserId && loggedInUser.id !== boundUserId) {
        logger.warn(
          {
            sessionBoundUserId: boundUserId,
            attemptedUserId: loggedInUser.id,
          },
          '[auth] Login rejected: session bound to different user',
        )
        trackEvent(AnalyticsEvent.ACCOUNT_SWITCH_BLOCKED, {
          sessionBoundUserId: boundUserId,
          attemptedUserId: loggedInUser.id ?? 'unknown',
        })
        clearUserCredentials()
        return 'This session is tied to another account. End the current session first, or log out with /logout --force.'
      }

      // Identify first (aliases the pre-login anonymous history to the real
      // user id) so the login event below is attributed to the user.
      if (loggedInUser.id && loggedInUser.email) {
        setAuthLoggerContext({
          userId: loggedInUser.id,
          email: loggedInUser.email,
        })
      }

      // Track successful login
      trackEvent(AnalyticsEvent.LOGIN, {
        userId: loggedInUser.id,
        via: 'modal',
        hasEmail: Boolean(loggedInUser.email),
        hasName: Boolean(loggedInUser.name),
      })

      // Reset the SDK client to pick up new credentials
      resetCodebuffClient()
      resetChatStore()
      resetLoginState()
      setInputFocused(true)
      setUser(loggedInUser)
      setIsAuthenticated(true)
      return null
    },
    [resetChatStore, resetLoginState, setInputFocused],
  )

  // Auto-focus input after authentication
  useEffect(() => {
    if (isAuthenticated !== true) return

    setInputFocused(true)

    const focusNow = () => {
      const handle = inputRef.current
      if (handle && typeof handle.focus === 'function') {
        handle.focus()
      }
    }

    focusNow()
    const timeoutId = setTimeout(focusNow, 0)

    return () => clearTimeout(timeoutId)
  }, [isAuthenticated, setInputFocused, inputRef])

  return {
    isAuthenticated,
    setIsAuthenticated,
    user,
    setUser,
    handleLoginSuccess,
    logoutMutation,
  }
}
