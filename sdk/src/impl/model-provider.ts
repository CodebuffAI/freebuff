/**
 * Model provider abstraction for routing requests to the appropriate LLM provider.
 *
 * This module handles:
 * - ChatGPT OAuth: Direct requests to OpenAI API using user's OAuth token
 * - Default: Requests through Codebuff backend (which routes to OpenRouter)
 */

import path from 'path'

import { BYOK_OPENROUTER_HEADER } from '@codebuff/common/constants/byok'
import { isFreeMode } from '@codebuff/common/constants/free-agents'
import { REQUESTY_BASE_URL } from '@codebuff/common/constants/requesty'
import {
  CHATGPT_BACKEND_BASE_URL,
  CHATGPT_OAUTH_ENABLED,
  isChatGptOAuthModelAllowed,
  isOpenAIProviderModel,
  toOpenAIModelId,
} from '@codebuff/common/constants/chatgpt-oauth'
import {
  OpenAICompatibleChatLanguageModel,
  VERSION,
} from '@codebuff/llm-providers/openai-compatible'

import { getWebsiteUrl } from '../constants'
import { getValidChatGptOAuthCredentials } from '../credentials'
import {
  getByokOpenrouterApiKeyFromEnv,
  getRequestyApiKeyFromEnv,
} from '../env'
import {
  createChatGptBackendFetch,
  extractChatGptAccountId,
} from './chatgpt-backend-fetch'

import type { LanguageModel } from 'ai'

// ============================================================================
// ChatGPT OAuth Rate Limit Cache
// ============================================================================

/** Timestamp (ms) when ChatGPT OAuth rate limit expires, or null if not rate-limited */
let chatGptOAuthRateLimitedUntil: number | null = null

/**
 * Mark ChatGPT OAuth as rate-limited. Subsequent requests will skip direct ChatGPT OAuth
 * and use Codebuff backend until the reset time.
 */
export function markChatGptOAuthRateLimited(resetAt?: Date): void {
  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000
  chatGptOAuthRateLimitedUntil = resetAt
    ? resetAt.getTime()
    : fiveMinutesFromNow
}

/**
 * Check if ChatGPT OAuth is currently rate-limited.
 */
export function isChatGptOAuthRateLimited(): boolean {
  if (chatGptOAuthRateLimitedUntil === null) {
    return false
  }
  if (Date.now() >= chatGptOAuthRateLimitedUntil) {
    chatGptOAuthRateLimitedUntil = null
    return false
  }
  return true
}

/**
 * Reset the ChatGPT OAuth rate-limit cache.
 * Call this when user reconnects their ChatGPT subscription.
 */
export function resetChatGptOAuthRateLimit(): void {
  chatGptOAuthRateLimitedUntil = null
}

/**
 * Parameters for requesting a model.
 */
export interface ModelRequestParams {
  /** Codebuff API key for backend authentication */
  apiKey: string
  /** Model ID (OpenRouter format, e.g., "anthropic/claude-sonnet-4") */
  model: string
  /** If true, skip ChatGPT OAuth and use Codebuff backend (for fallback after rate limit) */
  skipChatGptOAuth?: boolean
  /** Cost mode (e.g. 'free') — affects fallback behavior for OAuth routes */
  costMode?: string
}

/**
 * Result from getModelForRequest.
 */
export interface ModelResult {
  /** The language model to use for requests */
  model: LanguageModel
  /** Whether this model uses ChatGPT OAuth direct (affects cost tracking) */
  isChatGptOAuth: boolean
}

// Usage accounting type for OpenRouter/Codebuff backend responses
type OpenRouterUsageAccounting = {
  cost: number | null
  costDetails: {
    upstreamInferenceCost: number | null
  }
}

/**
 * Get the appropriate model for a request.
 *
 * If ChatGPT OAuth credentials are available and the model is an OpenAI model,
 * returns an OpenAI direct model. Otherwise, returns the Codebuff backend model.
 *
 * This function is async because it may need to refresh the OAuth token.
 */
export async function getModelForRequest(
  params: ModelRequestParams,
): Promise<ModelResult> {
  const { apiKey, model, skipChatGptOAuth, costMode } = params

  // Direct Requesty route: when REQUESTY_API_KEY is set, send chat completions
  // straight to the Requesty OpenAI-compatible router instead of the Codebuff
  // backend. Model ids use the same `provider/model` form (e.g.
  // "openai/gpt-4o-mini"), so no remapping is required.
  const requestyApiKey = getRequestyApiKeyFromEnv()
  if (requestyApiKey) {
    return {
      model: createRequestyModel(model, requestyApiKey),
      isChatGptOAuth: false,
    }
  }

  // Check if we should use ChatGPT OAuth direct
  // Only attempt for allowlisted models; non-allowlisted models silently fall through to backend.
  if (
    CHATGPT_OAUTH_ENABLED &&
    !skipChatGptOAuth &&
    isOpenAIProviderModel(model) &&
    isChatGptOAuthModelAllowed(model)
  ) {
    // In free mode, rate-limited ChatGPT OAuth must not silently fall through to
    // the Codebuff backend — freebuff should only use the direct OpenAI route or fail.
    if (isChatGptOAuthRateLimited()) {
      if (isFreeMode(costMode)) {
        throw new Error(
          'ChatGPT rate limit reached. Please wait a few minutes and try again.',
        )
      }
    } else {
      const chatGptOAuthCredentials = await getValidChatGptOAuthCredentials()

      if (chatGptOAuthCredentials) {
        return {
          model: createOpenAIOAuthModel(
            model,
            chatGptOAuthCredentials.accessToken,
          ),
          isChatGptOAuth: true,
        }
      }

      // In free mode, if credentials are unavailable, don't fall through to backend.
      if (isFreeMode(costMode)) {
        throw new Error(
          'ChatGPT OAuth credentials unavailable. Please reconnect with /connect:chatgpt.',
        )
      }
    }
  }

  // Default: use Codebuff backend
  return {
    model: createCodebuffBackendModel(apiKey, model),
    isChatGptOAuth: false,
  }
}

/**
 * Create an OpenAI model that routes through the ChatGPT backend API (Codex endpoint).
 * Uses a custom fetch that transforms between Chat Completions and Responses API formats.
 */
function createOpenAIOAuthModel(
  model: string,
  oauthToken: string,
): LanguageModel {
  const openAIModelId = toOpenAIModelId(model)
  const accountId = extractChatGptAccountId(oauthToken)

  return new OpenAICompatibleChatLanguageModel(openAIModelId, {
    provider: 'openai',
    url: () => `${CHATGPT_BACKEND_BASE_URL}/codex/responses`,
    headers: () => ({
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      accept: 'text/event-stream',
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/codebuff-chatgpt-oauth`,
      ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
    }),
    fetch: createChatGptBackendFetch(),
    supportsStructuredOutputs: true,
    includeUsage: undefined,
  })
}

/**
 * Create a model that routes directly to the Requesty OpenAI-compatible router
 * (https://router.requesty.ai/v1). Used when REQUESTY_API_KEY is set.
 *
 * This mirrors createOpenAIOAuthModel: it builds an OpenAICompatibleChatLanguageModel
 * pointed at a fixed upstream base URL with a Bearer API key, rather than going
 * through the Codebuff backend. Model ids use the same `provider/model` form as
 * OpenRouter (e.g. "openai/gpt-4o-mini").
 */
function createRequestyModel(model: string, apiKey: string): LanguageModel {
  return new OpenAICompatibleChatLanguageModel(model, {
    provider: 'requesty',
    url: ({ path }) => `${REQUESTY_BASE_URL}${path}`,
    headers: () => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/codebuff-requesty`,
    }),
    fetch: undefined,
    includeUsage: undefined,
    supportsStructuredOutputs: true,
  })
}

/**
 * Create a model that routes through the Codebuff backend.
 * This is the existing behavior - requests go to Codebuff backend which forwards to OpenRouter.
 */
function createCodebuffBackendModel(
  apiKey: string,
  model: string,
): LanguageModel {
  const openrouterUsage: OpenRouterUsageAccounting = {
    cost: null,
    costDetails: {
      upstreamInferenceCost: null,
    },
  }

  const openrouterApiKey = getByokOpenrouterApiKeyFromEnv()

  return new OpenAICompatibleChatLanguageModel(model, {
    provider: 'codebuff',
    url: ({ path: endpoint }) =>
      new URL(path.join('/api/v1', endpoint), getWebsiteUrl()).toString(),
    headers: () => ({
      Authorization: `Bearer ${apiKey}`,
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/codebuff`,
      ...(openrouterApiKey && { [BYOK_OPENROUTER_HEADER]: openrouterApiKey }),
    }),
    metadataExtractor: {
      extractMetadata: async ({ parsedBody }: { parsedBody: any }) => {
        if (openrouterApiKey !== undefined) {
          return { codebuff: { usage: openrouterUsage } }
        }

        if (typeof parsedBody?.usage?.cost === 'number') {
          openrouterUsage.cost = parsedBody.usage.cost
        }
        if (
          typeof parsedBody?.usage?.cost_details?.upstream_inference_cost ===
          'number'
        ) {
          openrouterUsage.costDetails.upstreamInferenceCost =
            parsedBody.usage.cost_details.upstream_inference_cost
        }
        return { codebuff: { usage: openrouterUsage } }
      },
      createStreamExtractor: () => ({
        processChunk: (parsedChunk: any) => {
          if (openrouterApiKey !== undefined) {
            return
          }

          if (typeof parsedChunk?.usage?.cost === 'number') {
            openrouterUsage.cost = parsedChunk.usage.cost
          }
          if (
            typeof parsedChunk?.usage?.cost_details?.upstream_inference_cost ===
            'number'
          ) {
            openrouterUsage.costDetails.upstreamInferenceCost =
              parsedChunk.usage.cost_details.upstream_inference_cost
          }
        },
        buildMetadata: () => {
          return { codebuff: { usage: openrouterUsage } }
        },
      }),
    },
    fetch: undefined,
    includeUsage: undefined,
    supportsStructuredOutputs: true,
  })
}
