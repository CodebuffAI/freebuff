/**
 * SDK environment helper for dependency injection.
 *
 * This module provides SDK-specific env helpers that extend the base
 * process env with SDK-specific vars for binary paths and WASM.
 */

import { BYOK_OPENROUTER_ENV_VAR } from '@codebuff/common/constants/byok'
import { CHATGPT_OAUTH_TOKEN_ENV_VAR } from '@codebuff/common/constants/chatgpt-oauth'
import {
  PROVIDER_API_KEY_ENV_VAR,
  PROVIDER_BASE_URL_ENV_VAR,
  PROVIDER_MODEL_ENV_VAR,
} from '@codebuff/common/constants/custom-provider'
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

export const getSystemProcessEnv = (): NodeJS.ProcessEnv => {
  return process.env
}

export const getByokOpenrouterApiKeyFromEnv = (): string | undefined => {
  return process.env[BYOK_OPENROUTER_ENV_VAR]
}

/**
 * Get ChatGPT OAuth token from environment variable.
 */
export const getChatGptOAuthTokenFromEnv = (): string | undefined => {
  return process.env[CHATGPT_OAUTH_TOKEN_ENV_VAR]
}

/**
 * Get the custom upstream provider base URL from environment.
 * Used when an agent's providerOptions.baseUrl is unset and no CodebuffClient option overrides it.
 */
export const getCustomProviderBaseUrlFromEnv = (): string | undefined => {
  return process.env[PROVIDER_BASE_URL_ENV_VAR]
}

/**
 * Get the custom upstream provider API key from environment.
 * Paired with getCustomProviderBaseUrlFromEnv.
 */
export const getCustomProviderApiKeyFromEnv = (): string | undefined => {
  return process.env[PROVIDER_API_KEY_ENV_VAR]
}

/**
 * Get the override model name from environment. When the custom provider is
 * active, this value replaces the agent's declared model.
 * Returns undefined if unset.
 */
export const getCustomProviderModelFromEnv = (): string | undefined => {
  return process.env[PROVIDER_MODEL_ENV_VAR]
}
