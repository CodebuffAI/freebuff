import fs from 'fs'
import path from 'path'

import { getCiEnv } from '@codebuff/common/env-ci'
import { z } from 'zod'

import {
  getCachedKeychainToken,
  resolveSecretStore,
  setCachedKeychainToken,
} from './auth-token-store'
import { getApiClient, setApiClientAuthToken } from './codebuff-api'
import { getConfigDir as getConfigDirBase } from './config-dir'
import { IS_FREEBUFF } from './constants'
import { logger } from './logger'

import type { CiEnv } from '@codebuff/common/types/contracts/env'

// User schema
const userSchema = z.object({
  id: z.string().optional(),
  // The server's user record allows a null name (see `userSchema` in
  // common/src/util/credentials.ts), and the login response is written to disk
  // as-is. Requiring a string here made every launch fail to parse the file
  // for those accounts, so they could never stay logged in.
  name: z
    .string()
    .nullish()
    .transform((name) => name ?? ''),
  email: z.string(),
  authToken: z.string(),
  fingerprintId: z.string().optional(),
  fingerprintHash: z.string().optional(),
  credits: z.number().optional(),
})

export type User = z.infer<typeof userSchema>

/** What the file may hold: the token itself, or a pointer to the keychain
 *  (auth-token-store.ts). */
const storedUserSchema = userSchema.extend({
  authToken: z.string().optional(),
  tokenStore: z.literal('keychain').optional(),
})

// Each profile is validated on its own (`storedUserSchema` in userFromJson):
// a keychain-pointer profile has no `authToken`, which `userSchema` requires.
const credentialsSchema = z.object({}).catchall(z.unknown())

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
    const parsed = storedUserSchema.safeParse(profile)
    if (!parsed.success) return undefined
    const { tokenStore, ...stored } = parsed.data
    // A keychain pointer resolves to the token loaded at startup; with none
    // loaded (keychain unavailable this run) the user reads as signed out.
    const authToken =
      stored.authToken ??
      (tokenStore === 'keychain' ? getCachedKeychainToken() : undefined)
    return authToken ? { ...stored, authToken } : undefined
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

    // The login response is cast to `User`, so `name` can be null at runtime.
    const normalizedUser = { ...user, name: user.name ?? '' }
    const updatedData = { ...readCredentialsFile(), default: normalizedUser }
    fs.writeFileSync(credentialsPath, JSON.stringify(updatedData, null, 2), {
      mode: CREDENTIALS_FILE_MODE,
    })
    tightenCredentialsFileMode(credentialsPath)
    // The file holds the token until the keychain has it (never throws).
    setCachedKeychainToken(normalizedUser.authToken)
    void moveTokenToKeychain()
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
    setCachedKeychainToken(null)
    const store = resolveSecretStore({
      isFreebuff: IS_FREEBUFF,
      credentialsPath,
    })
    if (store) {
      void store.delete().catch((error) => {
        logger.debug(
          { error: error instanceof Error ? error.message : String(error) },
          'Could not remove the keychain token',
        )
      })
    }

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

/**
 * Move the file's token into the keychain, once the keychain has proved it
 * can hand it back. Leaves the file alone on any failure, and when the file
 * changed meanwhile (a concurrent login). Never throws.
 */
export async function moveTokenToKeychain(): Promise<boolean> {
  const credentialsPath = getCredentialsPath()
  const store = resolveSecretStore({ isFreebuff: IS_FREEBUFF, credentialsPath })
  if (!store) return false
  try {
    const before = readCredentialsFile()
    const profile = storedUserSchema.safeParse(before.default)
    const token = profile.success ? profile.data.authToken : undefined
    if (!token) return false
    await store.set(token)
    if ((await store.get()) !== token) return false
    const now = readCredentialsFile()
    const current = storedUserSchema.safeParse(now.default)
    if (!current.success || current.data.authToken !== token) return false
    const { authToken: _moved, ...profileOnly } = current.data
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify(
        { ...now, default: { ...profileOnly, tokenStore: 'keychain' } },
        null,
        2,
      ),
      { mode: CREDENTIALS_FILE_MODE },
    )
    tightenCredentialsFileMode(credentialsPath)
    setCachedKeychainToken(token)
    return true
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Auth token stays in the credentials file (keychain unavailable)',
    )
    return false
  }
}

/**
 * Startup: load a keychain token into memory so the synchronous readers see
 * it, or move a file token into the keychain. Must run before anything reads
 * the credentials. Never throws.
 */
export async function loadStoredAuthToken(): Promise<void> {
  const credentialsPath = getCredentialsPath()
  const store = resolveSecretStore({ isFreebuff: IS_FREEBUFF, credentialsPath })
  if (!store) return
  const profile = storedUserSchema.safeParse(readCredentialsFile().default)
  if (!profile.success) return
  if (profile.data.authToken) {
    await moveTokenToKeychain()
    return
  }
  if (profile.data.tokenStore !== 'keychain') return
  try {
    setCachedKeychainToken((await store.get()) ?? null)
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Could not read the auth token from the keychain',
    )
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
