import { listModels, readProviders } from './config'
import {
  checkLimits,
  createKey,
  ensureSchema,
  keyFromRequest,
  listKeys,
  revokeKey,
  summarizeUsage,
} from './keys'
import { forward } from './proxy'
import type { Env } from './types'

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-admin-token',
  'access-control-max-age': '86400',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  })
}

function errorResponse(status: number, message: string, type = 'invalid_request_error'): Response {
  return json({ error: { message, type } }, status)
}

/** Length-independent comparison so a wrong token cannot be timed. */
function sameToken(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

function isAdmin(request: Request, env: Env): 'ok' | 'missing' | 'denied' {
  const expected = env.ADMIN_TOKEN
  if (!expected || expected.length === 0) return 'missing'
  const header = request.headers.get('x-admin-token') ?? ''
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (sameToken(header, expected) || sameToken(bearer, expected)) return 'ok'
  return 'denied'
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  return null
}

async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/')) return null

  const admin = isAdmin(request, env)
  if (admin === 'missing') {
    return errorResponse(503, 'ADMIN_TOKEN is not configured on this deployment.', 'configuration_error')
  }
  if (admin === 'denied') {
    return errorResponse(401, 'Invalid admin token.', 'authentication_error')
  }

  if (request.method === 'GET' && url.pathname === '/api/me') {
    return json({ ok: true })
  }

  if (request.method === 'GET' && url.pathname === '/api/models') {
    const providers = readProviders(env)
    return json({
      providers: providers.map((provider) => ({
        id: provider.id,
        baseUrl: provider.baseUrl,
        models: provider.models,
      })),
      models: listModels(providers),
      defaultProvider: env.DEFAULT_PROVIDER ?? null,
    })
  }

  if (url.pathname === '/api/keys') {
    if (request.method === 'GET') {
      return json({ keys: await listKeys(env.DB) })
    }
    if (request.method === 'POST') {
      let body: Record<string, unknown> = {}
      try {
        body = (await request.json()) as Record<string, unknown>
      } catch {
        // Empty body is fine: name defaults below.
      }
      const name =
        typeof body.name === 'string' && body.name.trim().length > 0
          ? body.name.trim().slice(0, 64)
          : `key-${new Date().toISOString().slice(0, 10)}`
      const created = await createKey(env.DB, {
        name,
        rateLimitRpm: optionalNumber(body.rateLimitRpm),
        monthlyTokenBudget: optionalNumber(body.monthlyTokenBudget),
      })
      return json({ key: created.key, record: created.row }, 201)
    }
    return errorResponse(405, 'Method not allowed.', 'method_error')
  }

  const revokeMatch = /^\/api\/keys\/([A-Za-z0-9]+)\/revoke$/.exec(url.pathname)
  if (revokeMatch && request.method === 'POST') {
    const id = revokeMatch[1]
    if (!id) return errorResponse(400, 'Missing key id.')
    const revoked = await revokeKey(env.DB, id)
    if (!revoked) return errorResponse(404, 'Key not found or already revoked.')
    return json({ ok: true })
  }

  if (request.method === 'GET' && url.pathname === '/api/usage') {
    const requested = Number(url.searchParams.get('days') ?? '7')
    const days = Number.isFinite(requested) ? Math.max(1, Math.min(Math.floor(requested), 365)) : 7
    return json(await summarizeUsage(env.DB, days))
  }

  return errorResponse(404, 'Unknown admin route.', 'not_found_error')
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    await ensureSchema(env.DB)

    if (url.pathname === '/healthz') {
      const providers = readProviders(env)
      return json({
        ok: true,
        providers: providers.map((provider) => provider.id),
        configured: providers.length > 0,
      })
    }

    const adminResponse = await handleAdmin(request, env, url)
    if (adminResponse) return adminResponse

    if (url.pathname === '/v1/models') {
      const key = await keyFromRequest(env.DB, request)
      if (!key) return errorResponse(401, 'Missing or invalid API key.', 'authentication_error')
      const providers = readProviders(env)
      const models = listModels(providers)
      return json({
        object: 'list',
        data: models.map((model) => ({
          id: model.id,
          object: 'model',
          owned_by: model.owned_by,
          created: 0,
        })),
      })
    }

    if (url.pathname.startsWith('/v1/') && request.method === 'POST') {
      const key = await keyFromRequest(env.DB, request)
      if (!key) return errorResponse(401, 'Missing or invalid API key.', 'authentication_error')

      const providers = readProviders(env)
      if (providers.length === 0) {
        return errorResponse(
          503,
          'No upstream providers configured. Set OPENAI_API_KEY (or PROVIDERS) as a secret.',
          'configuration_error',
        )
      }

      const limits = await checkLimits(env.DB, key)
      if (!limits.ok) return errorResponse(limits.status, limits.message, 'rate_limit_error')

      return forward(request, env, ctx, key, url.pathname.slice('/v1/'.length), providers)
    }

    return env.ASSETS.fetch(request)
  },
}
