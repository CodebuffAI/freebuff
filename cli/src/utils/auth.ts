import fs from 'fs'
import path from 'path'

import { getCiEnv } from '@codebuff/common/env-ci'
import { z } from 'zod'

import { getApiClient, setApiClientAuthToken } from './codebuff-api'
import { getConfigDir as getConfigDirBase } from './config-dir'
import { logger } from './logger'

import type { CiEnv } from '@codebuff/common/types/contracts/env'

// User schema
const userSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  email: z.string(),
  authToken: z.string(),
  fingerprintId: z.string().optional(),
  fingerprintHash: z.string().optional(),
  credits: z.number().optional(),
})

export type User = z.infer<typeof userSchema>

const credentialsSchema = z
  .object({
    default: userSchema.optional(),
  })
  .catchall(z.unknown())

// Get the config directory path.
// Re-exported as a wrapper (rather than a bare `export ... from`) so existing
// tests can still `spyOn(authModule, 'getConfigDir')`.
export const getConfigDir = (): string => getConfigDirBase()

// Get the credentials file path
export const getCredentialsPath = (): string => {
  return path.join(getConfigDir(), 'credentials.json')
}

/** Owner read/write only: the file holds the bearer token for every API call. */
const CREDENTIALS_FILE_MODE = 0o600
/** Owner-only config dir, matching sdk/src/byok.ts and sponsored-run.ts. */
const CONFIG_DIR_MODE = 0o700

/**
 * Best-effort: clamp the credentials file to owner read/write.
 *
 * `writeFileSync` only applies `mode` when it CREATES the file, so an install
 * that already has a umask-wide `credentials.json` (e.g. `-rw-rw-r--`) keeps
 * it across every rewrite. Called after each write and on read, so existing
 * installs are healed on the next launch. Skipped on Windows, where POSIX
 * mode bits do not apply and `chmod` can throw. Never throws: a failed chmod
 * must not cost the user their login.
 */
const tightenCredentialsFileMode = (credentialsPath: string): void => {
  if (process.platform === 'win32') return
  try {
    const mode = fs.statSync(credentialsPath).mode & 0o777
    if (mode !== CREDENTIALS_FILE_MODE) {
      fs.chmodSync(credentialsPath, CREDENTIALS_FILE_MODE)
    }
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Could not tighten credentials file permissions',
    )
  }
}

/**
 * Parse user from JSON string
 */
const userFromJson = (
  json: string,
  profileName: string = 'default',
): User | undefined => {
  try {
    const allCredentials = credentialsSchema.parse(JSON.parse(json))
    const profile = allCredentials[profileName]
    // Validate that the profile matches the user schema
    const parsed = userSchema.safeParse(profile)
    return parsed.success ? parsed.data : undefined
  } catch (error) {
    logger.error(
      {
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        profileName,
      },
      'Error parsing user JSON',
    )
    return
  }
}

/**
 * Get user credentials from file system
 * @returns User object or null if not found/authenticated
 */
export const getUserCredentials = (): User | null => {
  const credentialsPath = getCredentialsPath()

  // Read user credentials directly from file
  if (!fs.existsSync(credentialsPath)) {
    return null
  }

  try {
    tightenCredentialsFileMode(credentialsPath)
    const credentialsFile = fs.readFileSync(credentialsPath, 'utf8')
    const user = userFromJson(credentialsFile)
    return user || null
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Error reading credentials',
    )
    return null
  }
}

export type AuthTokenSource = 'credentials' | 'environment' | null

export interface AuthTokenDetails {
  token?: string
  source: AuthTokenSource
}

/**
 * Resolve the auth token and track where it came from.
 */
export const getAuthTokenDetails = (
  ciEnv: CiEnv = getCiEnv(),
): AuthTokenDetails => {
  const userCredentials = getUserCredentials()
  if (userCredentials?.authToken) {
    return { token: userCredentials.authToken, source: 'credentials' }
  }

  const envToken = ciEnv.CODEBUFF_API_KEY
  if (envToken) {
    return { token: envToken, source: 'environment' }
  }

  return { source: null }
}

/**
 * Get the auth token from user credentials or environment variable
 */
export const getAuthToken = (): string | undefined => {
  return getAuthTokenDetails().token
}

/**
 * Check if the user has authentication credentials (but doesn't validate them)
 */
export const hasAuthCredentials = (): boolean => {
  return !!getAuthTokenDetails().token
}

export interface AuthValidationResult {
  authenticated: boolean
  hasInvalidCredentials: boolean
}

/**
 * Read existing credentials file, returns empty object if missing/invalid.
 *
 * Drops `chatgptOAuth`, which the removed ChatGPT integration wrote. Both
 * callers spread this result straight back over the file, so the dead key —
 * an OAuth access and refresh token for the user's ChatGPT account — is
 * cleaned up the next time we write for any reason. Doing it here rather than
 * in a startup pass means no extra write and no new race with login/logout;
 * nothing reads the key anymore, and with /connect gone the user has no way
 * to clear it themselves.
 */
const readCredentialsFile = (): Record<string, unknown> => {
  const credentialsPath = getCredentialsPath()
  if (!fs.existsSync(credentialsPath)) return {}
  try {
    const { chatgptOAuth: _removedIntegration, ...rest } = JSON.parse(
      fs.readFileSync(credentialsPath, 'utf8'),
    )
    return rest
  } catch {
    return {}
  }
}

/**
 * Save user credentials to file system.
 */
export const saveUserCredentials = (user: User): void => {
  const configDir = getConfigDir()
  const credentialsPath = getCredentialsPath()

  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: CONFIG_DIR_MODE })
    }

    const updatedData = { ...readCredentialsFile(), default: user }
    fs.writeFileSync(credentialsPath, JSON.stringify(updatedData, null, 2), {
      mode: CREDENTIALS_FILE_MODE,
    })
    tightenCredentialsFileMode(credentialsPath)
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Error saving credentials',
    )
    throw error
  }
}

/**
 * Clear user credentials from file system.
 * Only removes the 'default' field, preserving other credentials.
 */
export const clearUserCredentials = (): void => {
  const credentialsPath = getCredentialsPath()

  try {
    if (!fs.existsSync(credentialsPath)) return

    const { default: _, ...rest } = readCredentialsFile()

    if (Object.keys(rest).length === 0) {
      fs.unlinkSync(credentialsPath)
    } else {
      fs.writeFileSync(credentialsPath, JSON.stringify(rest, null, 2), {
        mode: CREDENTIALS_FILE_MODE,
      })
      tightenCredentialsFileMode(credentialsPath)
    }
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Error clearing credentials',
    )
    throw error
  }
}

export async function logoutUser(): Promise<boolean> {
  try {
    const user = getUserCredentials()
    if (user?.authToken) {
      setApiClientAuthToken(user.authToken)
      const apiClient = getApiClient()
      try {
        const response = await apiClient.logout({
          userId: user.id,
          fingerprintId: user.fingerprintId,
          fingerprintHash: user.fingerprintHash,
        })
        if (!response.ok) {
          logger.error(
            { status: response.status, error: response.error },
            'Logout request failed',
          )
        }
      } catch (err) {
        logger.error(err, 'Logout request error')
      }
    }
  } catch (error) {
    logger.error(error, 'Unexpected error preparing logout')
  }

  try {
    clearUserCredentials()
  } catch (error) {
    logger.debug({ error }, 'Failed to clear credentials during logout')
  }
  return true
}
