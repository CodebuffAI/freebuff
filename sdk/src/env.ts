/**
 * SDK environment helper for dependency injection.
 *
 * This module provides SDK-specific env helpers that extend the base
 * process env with SDK-specific vars for binary paths and WASM.
 */

import { BYOK_OPENROUTER_ENV_VAR } from '@codebuff/common/constants/byok'
import { CHATGPT_OAUTH_TOKEN_ENV_VAR } from '@codebuff/common/constants/chatgpt-oauth'
import { REQUESTY_ENV_VAR } from '@codebuff/common/constants/requesty'
import { API_KEY_ENV_VAR } from '@codebuff/common/constants/paths'
import { getBaseEnv } from '@codebuff/common/env-process'

import type { SdkEnv } from './types/env'

/**
 * Get SDK environment values.
 * Composes from getBaseEnv() + SDK-specific vars.
 */
export const getSdkEnv = (): SdkEnv => ({
  ...getBaseEnv(),

  // SDK-specific paths
  CODEBUFF_RG_PATH: process.env.CODEBUFF_RG_PATH,
  CODEBUFF_WASM_DIR: process.env.CODEBUFF_WASM_DIR,

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
 * Runtime override for the Codebuff backend base URL. Remote hosts that bundle
 * the SDK (Convex Node actions, Next server routes) set this at deploy time;
 * the bundle-time value can inline a dev-machine localhost URL the remote
 * runtime cannot reach.
 */
export const getRuntimeAppUrlFromEnv = (): string | undefined => {
  return (
    process.env['NEXT_PUBLIC_CODEBUFF_APP_URL'] ??
    process.env['CODEBUFF_APP_URL']
  )
}

export const getSystemProcessEnv = (): NodeJS.ProcessEnv => {
  return process.env
}

export const getByokOpenrouterApiKeyFromEnv = (): string | undefined => {
  return process.env[BYOK_OPENROUTER_ENV_VAR]
}

/**
 * Get the Requesty API key from the environment.
 *
 * When set, the SDK routes chat completions directly to the Requesty
 * OpenAI-compatible router instead of going through the Codebuff backend.
 */
export const getRequestyApiKeyFromEnv = (): string | undefined => {
  return process.env[REQUESTY_ENV_VAR]
}

/**
 * Get ChatGPT OAuth token from environment variable.
 */
export const getChatGptOAuthTokenFromEnv = (): string | undefined => {
  return process.env[CHATGPT_OAUTH_TOKEN_ENV_VAR]
}
