import { CATALOG } from './catalog'
import type { Env } from './types'

export type Provider = {
  id: string
  baseUrl: string
  apiKey: string
  /** Model ids this upstream serves. Empty means "route by explicit provider prefix only". */
  models: string[]
}

type ProviderDefaults = {
  id: string
  baseUrl: string
  keyEnv: keyof Env
  models: string[]
}

/**
 * Providers are only active when their API key is present, so an unconfigured
 * deployment still boots and reports an empty model list instead of failing.
 */
const BUILT_INS: ProviderDefaults[] = [
  { id: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', models: [] },
  {
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    models: [],
  },
  {
    id: 'nous',
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    keyEnv: 'NOUS_API_KEY',
    models: [],
  },
  { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', models: [] },
]

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function fromJson(raw: string): Provider[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('PROVIDERS must be a JSON array')
  const providers: Provider[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : undefined
    const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl : undefined
    if (!id || !baseUrl) continue
    const apiKey = typeof record.apiKey === 'string' ? record.apiKey : ''
    const models = Array.isArray(record.models)
      ? record.models.filter((model): model is string => typeof model === 'string')
      : []
    providers.push({ id, baseUrl: trimSlash(baseUrl), apiKey, models })
  }
  return providers
}

export function readProviders(env: Env): Provider[] {
  if (env.PROVIDERS && env.PROVIDERS.trim().length > 0) {
    return fromJson(env.PROVIDERS)
  }

  const providers: Provider[] = []
  for (const preset of BUILT_INS) {
    const apiKey = env[preset.keyEnv]
    if (typeof apiKey !== 'string' || apiKey.length === 0) continue
    const baseUrl =
      preset.id === 'openai' && env.OPENAI_BASE_URL ? env.OPENAI_BASE_URL : preset.baseUrl
    providers.push({
      id: preset.id,
      baseUrl: trimSlash(baseUrl),
      apiKey,
      // Explicit models win; otherwise advertise the generated catalog.
      models: preset.models.length > 0 ? preset.models : (CATALOG[preset.id] ?? []),
    })
  }

  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    providers.push({
      id: 'workers-ai',
      baseUrl: trimSlash(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
      ),
      apiKey: env.CLOUDFLARE_API_TOKEN,
      models: [],
    })
  }

  return providers
}

export type Route = { provider: Provider; model: string }

/**
 * Resolves a requested model to an upstream. An explicit `<provider>/<model>`
 * prefix always wins; otherwise the default provider handles the request, so a
 * client can use plain ids like `gpt-4.1-mini` without knowing the provider.
 */
export function resolveRoute(
  providers: Provider[],
  requestedModel: string,
  defaultProviderId: string | undefined,
): Route | { error: string } {
  if (providers.length === 0) {
    return { error: 'No upstream providers configured. Set an API key such as OPENAI_API_KEY.' }
  }

  const slash = requestedModel.indexOf('/')
  if (slash > 0) {
    const prefix = requestedModel.slice(0, slash)
    const match = providers.find((provider) => provider.id === prefix)
    if (match) {
      // `openrouter/auto` is an OpenRouter model id, not a provider prefix, so
      // an exact catalog hit keeps the id intact.
      const keepWholeId = match.models.includes(requestedModel)
      return { provider: match, model: keepWholeId ? requestedModel : requestedModel.slice(slash + 1) }
    }
  }

  const owning = providers.find((provider) => provider.models.includes(requestedModel))
  if (owning) return { provider: owning, model: requestedModel }

  const fallback =
    providers.find((provider) => provider.id === defaultProviderId) ?? providers[0]
  if (!fallback) {
    return { error: 'No upstream providers configured.' }
  }
  return { provider: fallback, model: requestedModel }
}

export function listModels(providers: Provider[]): Array<{ id: string; owned_by: string }> {
  const seen = new Set<string>()
  const models: Array<{ id: string; owned_by: string }> = []
  for (const provider of providers) {
    for (const model of provider.models) {
      if (seen.has(model)) continue
      seen.add(model)
      models.push({ id: model, owned_by: provider.id })
    }
  }
  return models
}
