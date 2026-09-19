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
  RUNTIME_APP_URL_ENV_VARS,
  describeRuntimeAppUrlOrigin,
  isAllowedRuntimeAppUrl,
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
  CODEBUFF_TRUSTED_AGENT_PUBLISHERS: process.env.CODEBUFF_TRUSTED_AGENT_PUBLISHERS,

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

const warnRejectedRuntimeAppUrl = (variable: string, value: string): void => {
  const origin = describeRuntimeAppUrlOrigin(value)
  const key = `${variable}=${origin}`
  if (warnedRuntimeAppUrlOverrides.has(key)) return
  warnedRuntimeAppUrlOverrides.add(key)
  console.warn(
    `[codebuff] Ignoring ${variable} (${origin}): the runtime app URL must be https, or http on localhost. Using the bundled URL instead.`,
  )
}

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
 * The override is honoured only when {@link isAllowedRuntimeAppUrl} accepts it
 * (https anywhere, or http on a loopback host). Every request that carries the
 * user's bearer token is addressed to this URL, and it is read from the live
 * environment after things like the CLI's direnv import have run, so an
 * unchecked value lets anything that can set an env var redirect the
 * credential-bearing API plane. A rejected value is ignored — the caller falls
 * back to the bundled URL — and warned about once.
 */
export const getRuntimeAppUrlFromEnv = (): string | undefined => {
  for (const variable of RUNTIME_APP_URL_ENV_VARS) {
    const value = process.env[variable]
    if (value === undefined) continue
    if (value.trim() === '') return undefined
    if (isAllowedRuntimeAppUrl(value)) return value
    warnRejectedRuntimeAppUrl(variable, value)
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
