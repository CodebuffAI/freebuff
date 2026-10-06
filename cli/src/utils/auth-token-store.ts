/**
 * Where the Freebuff CLI keeps its auth token: the operating system's
 * credential store (macOS Keychain, Windows Credential Manager, the Linux
 * Secret Service) through `Bun.secrets`, instead of `credentials.json`.
 *
 * Why: the token in a plain file is readable by any program running as the
 * user. Local bridges read it to drive free mode from other tools, and one
 * leaked into a public dotfiles repo (2026-09-30). The keychain item belongs
 * to this binary; on macOS another program reading it prompts the user.
 *
 * Freebuff only. The Codebuff CLI shares `~/.config/manicode/credentials.json`
 * with the public SDK's `getUserCredentials()`, which runs under Node (no
 * `Bun.secrets`) and would lose the token; free mode through the SDK is
 * refused server-side anyway.
 *
 * The file keeps the profile (name, email, ids) with `tokenStore: 'keychain'`
 * and no `authToken`. Reads stay synchronous: `loadStoredAuthToken()` runs once
 * at startup and caches the token. Writes go to the file first, as before, and
 * the token then moves to the keychain, so a failed or unavailable keychain
 * (headless Linux, a locked keychain over SSH, CI) never logs anyone out: the
 * token just stays in the owner-only file.
 */

import { getCliEnv } from './env'
import { withTimeout } from '@codebuff/common/util/promise'

export type SecretStore = {
  get(): Promise<string | null>
  set(value: string): Promise<void>
  delete(): Promise<void>
}

const KEYCHAIN_TIMEOUT_MS = 2_000

const KEYCHAIN_TIMEOUT_MESSAGE = 'keychain timed out'

type BunSecrets = {
  get(options: { service: string; name: string }): Promise<string | null>
  set(options: { service: string; name: string; value: string }): Promise<void>
  delete(options: { service: string; name: string }): Promise<boolean>
}

/** The `Bun.secrets` store for one credentials file, or null when this
 *  runtime has none (Node, an old Bun). */
export function bunSecretStore(
  service: string,
  name: string,
): SecretStore | null {
  const secrets = (globalThis as { Bun?: { secrets?: BunSecrets } }).Bun
    ?.secrets
  if (!secrets) return null
  return {
    get: () =>
      withTimeout(
        secrets.get({ service, name }),
        KEYCHAIN_TIMEOUT_MS,
        KEYCHAIN_TIMEOUT_MESSAGE,
      ),
    set: (value) =>
      withTimeout(
        secrets.set({ service, name, value }),
        KEYCHAIN_TIMEOUT_MS,
        KEYCHAIN_TIMEOUT_MESSAGE,
      ),
    delete: async () => {
      await withTimeout(
        secrets.delete({ service, name }),
        KEYCHAIN_TIMEOUT_MS,
        KEYCHAIN_TIMEOUT_MESSAGE,
      )
    },
  }
}

/** undefined = not loaded yet (or no keychain); null = loaded, nothing there. */
let cachedToken: string | null | undefined
let storeOverride: SecretStore | null | undefined

export function getCachedKeychainToken(): string | null | undefined {
  return cachedToken
}

export function setCachedKeychainToken(token: string | null | undefined): void {
  cachedToken = token
}

/** Test-only: inject a store (null disables the keychain). */
export function setSecretStoreForTests(
  store: SecretStore | null | undefined,
): void {
  storeOverride = store
  cachedToken = undefined
}

/**
 * The store to use, or null for "keep the token in the file". Never the real
 * keychain under `bun test`, so a test run cannot write to a developer's
 * login keychain.
 */
export function resolveSecretStore(params: {
  isFreebuff: boolean
  credentialsPath: string
}): SecretStore | null {
  if (storeOverride !== undefined) return storeOverride
  if (!params.isFreebuff) return null
  if (getCliEnv().NODE_ENV === 'test') return null
  // One item per credentials file, so FREEBUFF_CONFIG_DIR profiles and dev
  // stacks never share a token.
  return bunSecretStore('freebuff-cli', params.credentialsPath)
}
