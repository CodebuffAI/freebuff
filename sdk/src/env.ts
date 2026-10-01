/**
 * SDK environment helper for dependency injection.
 *
 * This module provides SDK-specific env helpers that extend the base
 * process env with SDK-specific vars for binary paths and WASM.
 */

import { BYOK_OPENROUTER_ENV_VAR } from '@codebuff/common/constants/byok'
import { API_KEY_ENV_VAR } from '@codebuff/common/constants/paths'
import { getBaseEnv } from '@codebuff/common/env-process'
import {
  ALLOW_CUSTOM_APP_URL_ENV_VAR,
  RUNTIME_APP_URL_ENV_VARS,
  describeRuntimeAppUrlOrigin,
  isAllowedRuntimeAppUrl,
  isCustomAppUrlOptIn,
  isFirstPartyRuntimeAppUrl,
} from '@codebuff/common/util/runtime-app-url'

import { TRUSTED_AGENT_PUBLISHERS_ENV_VAR } from './agent-publisher-trust'

import type { SdkEnv } from './types/env'

export { isAllowedRuntimeAppUrl }

/**
 * Get SDK environment values.
 * Composes from getBaseEnv() + SDK-specific vars.
 */
export const getSdkEnv = (): SdkEnv => ({
  ...getBaseEnv(),

  // SDK-specific paths
  CODEBUFF_RG_PATH: process.env.CODEBUFF_RG_PATH,
  CODEBUFF_WASM_DIR: process.env.CODEBUFF_WASM_DIR,

  // Registry publishers whose executable (handleSteps) agents may run
  CODEBUFF_TRUSTED_AGENT_PUBLISHERS:
    process.env.CODEBUFF_TRUSTED_AGENT_PUBLISHERS,

  // Build flags
  VERBOSE: process.env.VERBOSE,
  OVERRIDE_TARGET: process.env.OVERRIDE_TARGET,
  OVERRIDE_PLATFORM: process.env.OVERRIDE_PLATFORM,
  OVERRIDE_ARCH: process.env.OVERRIDE_ARCH,
})

export const getCodebuffApiKeyFromEnv = (): string | undefined => {
  return process.env[API_KEY_ENV_VAR]
}

/**
 * Rejected overrides already warned about, keyed by variable and origin, so a
 * bad value produces one line per process rather than one per API call. There
 * is no SDK-wide logger at this layer (the run logger is created per run), so
 * this goes to `console.warn`.
 */
const warnedRuntimeAppUrlOverrides = new Set<string>()

const warnRejectedRuntimeAppUrl = (
  variable: string,
  value: string,
  reason: 'transport' | 'host',
): void => {
  const origin = describeRuntimeAppUrlOrigin(value)
  const key = `${variable}=${origin}`
  if (warnedRuntimeAppUrlOverrides.has(key)) return
  warnedRuntimeAppUrlOverrides.add(key)
  const why =
    reason === 'transport'
      ? 'the runtime app URL must be https, or http on localhost'
      : `the host is not a Codebuff/Freebuff domain; set ${ALLOW_CUSTOM_APP_URL_ENV_VAR}=1 in your shell to send your credentials to it`
  console.warn(
    `[codebuff] Ignoring ${variable} (${origin}): ${why}. Using the bundled URL instead.`,
  )
}

/**
 * Whether a runtime app URL may name a host outside the first-party domains.
 * A development build of the SDK (bundle-time `NEXT_PUBLIC_CB_ENVIRONMENT=dev`;
 * never the published package or a release CLI, which inline `prod`) always
 * may. Anything else needs {@link ALLOW_CUSTOM_APP_URL_ENV_VAR} set in the live
 * environment.
 *
 * The literal `process.env.NEXT_PUBLIC_CB_ENVIRONMENT` (not `@codebuff/common/env`)
 * is deliberate: it is what the SDK and CLI builds inline at bundle time, and
 * importing the validated env here would make every importer of this module
 * (tool modules, fixtures) fail without the full web env.
 */
export const isCustomRuntimeAppUrlAllowed = (): boolean =>
  process.env.NEXT_PUBLIC_CB_ENVIRONMENT === 'dev' ||
  isCustomAppUrlOptIn(process.env[ALLOW_CUSTOM_APP_URL_ENV_VAR])

/**
 * Raw comma-separated list of registry publishers whose agents may run
 * executable `handleSteps` on this machine. See ./agent-publisher-trust.ts.
 */
export const getTrustedAgentPublishersFromEnv = (): string | undefined => {
  return process.env[TRUSTED_AGENT_PUBLISHERS_ENV_VAR]
}

/**
 * Runtime override for the Codebuff backend base URL. Remote hosts that bundle
 * the SDK (Convex Node actions, Next server routes) set this at deploy time;
 * the bundle-time value can inline a dev-machine localhost URL the remote
 * runtime cannot reach.
 *
 * Every request that carries the user's bearer token is addressed to this URL,
 * and it is read from the live environment, so the override is honoured only
 * when:
 * - {@link isAllowedRuntimeAppUrl} accepts its transport (https, or http on a
 *   loopback host), AND
 * - its host is first-party (`codebuff.com` / `freebuff.com` or a subdomain)
 *   or loopback ({@link isFirstPartyRuntimeAppUrl}), unless
 *   {@link isCustomRuntimeAppUrlAllowed} (a dev build, or the explicit
 *   `CODEBUFF_ALLOW_CUSTOM_APP_URL=1` opt-in).
 *
 * The host rule closes an https-to-anywhere redirect of the token: an external
 * report showed a repository's env file steering it. The release CLI no longer
 * reads cwd dotenv files and drops `CODEBUFF_*` / `NEXT_PUBLIC_*` from
 * `.envrc`; this is the SDK's own fence for every other embedder and for
 * anything else able to set one variable. A rejected value is ignored — the
 * caller falls back to the bundled URL — and warned about once.
 */
export const getRuntimeAppUrlFromEnv = (): string | undefined => {
  for (const variable of RUNTIME_APP_URL_ENV_VARS) {
    const value = process.env[variable]
    if (value === undefined) continue
    if (value.trim() === '') return undefined
    if (!isAllowedRuntimeAppUrl(value)) {
      warnRejectedRuntimeAppUrl(variable, value, 'transport')
      return undefined
    }
    if (isFirstPartyRuntimeAppUrl(value) || isCustomRuntimeAppUrlAllowed()) {
      return value
    }
    warnRejectedRuntimeAppUrl(variable, value, 'host')
    return undefined
  }
  return undefined
}

export const getSystemProcessEnv = (): NodeJS.ProcessEnv => {
  return process.env
}

export const getByokOpenrouterApiKeyFromEnv = (): string | undefined => {
  return process.env[BYOK_OPENROUTER_ENV_VAR]
}
