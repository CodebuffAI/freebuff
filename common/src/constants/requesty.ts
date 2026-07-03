/**
 * Constants for the optional direct Requesty provider route.
 *
 * Requesty (https://requesty.ai) exposes an OpenAI-compatible router at
 * https://router.requesty.ai/v1. When `REQUESTY_API_KEY` is set, the SDK can
 * route chat completions directly to Requesty using the same OpenAI-compatible
 * language model shim used elsewhere, instead of going through the Codebuff
 * backend. Model ids use the same `provider/model` form as OpenRouter
 * (e.g. `openai/gpt-4o-mini`, `anthropic/claude-sonnet-4.5`).
 */

/** Base URL for the Requesty OpenAI-compatible router. */
export const REQUESTY_BASE_URL = 'https://router.requesty.ai/v1'

/** Environment variable holding the Requesty API key. */
export const REQUESTY_ENV_VAR = 'REQUESTY_API_KEY'
