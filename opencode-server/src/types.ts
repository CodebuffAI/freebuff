export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  ADMIN_TOKEN?: string
  DEFAULT_PROVIDER?: string
  /** JSON array: [{ id, baseUrl, apiKey?, models? }] */
  PROVIDERS?: string

  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  OPENROUTER_API_KEY?: string
  NOUS_API_KEY?: string
  GROQ_API_KEY?: string
  CLOUDFLARE_ACCOUNT_ID?: string
  CLOUDFLARE_API_TOKEN?: string
}
