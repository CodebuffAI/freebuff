/** Env var that overrides the upstream LLM endpoint with an OpenAI-compatible base URL.
 *  Lower precedence than per-agent providerOptions.baseUrl and the CodebuffClient option. */
export const PROVIDER_BASE_URL_ENV_VAR = 'CODEBUFF_BASE_URL'

/** Env var providing the API key for the endpoint set by PROVIDER_BASE_URL_ENV_VAR.
 *  Most local runtimes (Ollama, LM Studio) ignore the key entirely. */
export const PROVIDER_API_KEY_ENV_VAR = 'CODEBUFF_PROVIDER_API_KEY'

/** Env var overriding the agent's declared model when a custom provider is active.
 *  Used by `/local on <model>` to substitute the cloud model (e.g.
 *  `anthropic/claude-opus-4-7`) with a model the local provider actually has
 *  (e.g. `llama3.1:8b`).
 *
 *  Only takes effect when PROVIDER_BASE_URL_ENV_VAR is set AND the agent
 *  itself doesn't declare its own `providerOptions.baseUrl` — agents with an
 *  explicit baseUrl are assumed to declare a matching model. */
export const PROVIDER_MODEL_ENV_VAR = 'CODEBUFF_PROVIDER_MODEL'
