/** Cloudflare Worker: the license backend.
 *
 * Routes:
 *   POST /activate    {licenseKey, deviceId} → {token}   — claim a device slot
 *   POST /deactivate  {licenseKey, deviceId} → {ok}     — release a device slot
 *   POST /webhook     (Paddle, HMAC verified)  → {ok}     — activate/revoke on events
 *   GET  /health                               → {ok}     — liveness probe
 *
 * Entitlements are only ever granted after Paddle says a license key is active.
 * The response token is signed with Ed25519 so the app can verify Pro offline.
 */

import {
  actionForEvent,
  expectedSignature,
  idsFromEvent,
  licenseKeyFromEvent,
  parseSignatureHeader,
  type PaddleWebhookPayload,
} from './paddle'
import {
  activateLicense,
  claimDevice,
  getLicense,
  isRateLimited,
  releaseDevice,
  revokeLicense,
  type KVLike,
} from './store'
import { buildClaims, mintToken } from './tokens'

export interface Env {
  /** KV namespace holding license records. */
  LICENSES: KVLike
  /** PKCS#8 Ed25519 private key (base64) — `wrangler secret put SIGNING_KEY`. */
  SIGNING_KEY: string
  /** Paddle webhook secret — `wrangler secret put PADDLE_WEBHOOK_SECRET`. */
  PADDLE_WEBHOOK_SECRET: string
  /** Optional override of the client IP used for rate limiting. */
  RATE_LIMIT_DISABLED?: string
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function fail(error: string, status: number): Response {
  return json({ ok: false, error }, status)
}

/** Client identity for rate limiting: real client IP, or a caller's header. */
function clientId(request: Request, env: Env): string {
  if (env.RATE_LIMIT_DISABLED === 'true') return 'disabled'
  const cfIp = request.headers.get('CF-Connecting-IP')
  if (cfIp) return cfIp
  return (
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown'
  )
}

function normalizeKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url)
  const route = `${request.method} ${url.pathname}`

  switch (route) {
    case 'GET /health':
      return json({ ok: true, service: 'agent-voice-license' })

    case 'POST /activate':
      return activate(request, env)

    case 'POST /deactivate':
      return deactivate(request, env)

    case 'POST /webhook':
      return webhook(request, env)

    default:
      return fail('not found', 404)
  }
}

async function readBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await request.json()) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

async function activate(request: Request, env: Env): Promise<Response> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (await isRateLimited(env.LICENSES, clientId(request, env), nowSeconds)) {
    return fail('too many attempts — try again in a minute', 429)
  }
  const body = await readBody(request)
  if (!body) return fail('invalid JSON body', 400)
  const licenseKey = normalizeKey(body.licenseKey ?? body.license_key)
  const deviceId = normalizeKey(body.deviceId ?? body.device_id)
  if (!licenseKey || !deviceId)
    return fail('licenseKey and deviceId are required', 400)

  // A device id is a UUID minted by the app; refuse junk so KV is not abused
  // as a free datastore.
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) {
    return fail('invalid deviceId', 400)
  }

  const record = await getLicense(env.LICENSES, licenseKey)
  if (!record) return fail('unknown license key', 404)
  if (record.status !== 'active') {
    return fail('this license has been revoked (refund or chargeback)', 410)
  }
  if (
    !(await claimDevice(env.LICENSES, licenseKey, record, deviceId, nowSeconds))
  ) {
    return fail(
      'this license is already active on the maximum number of devices',
      409,
    )
  }

  const claims = await buildClaims({ licenseKey, deviceId, nowSeconds })
  const token = await mintToken(claims, env.SIGNING_KEY)
  return json({ ok: true, token, expiresAt: claims.exp }, 200)
}

async function deactivate(request: Request, env: Env): Promise<Response> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const body = await readBody(request)
  if (!body) return fail('invalid JSON body', 400)
  const licenseKey = normalizeKey(body.licenseKey ?? body.license_key)
  const deviceId = normalizeKey(body.deviceId ?? body.device_id)
  if (!licenseKey || !deviceId)
    return fail('licenseKey and deviceId are required', 400)
  const released = await releaseDevice(
    env.LICENSES,
    licenseKey,
    deviceId,
    nowSeconds,
  )
  // Releasing an unknown slot is fine: the client's intent is "this device no
  // longer counts", which is already true.
  return json({ ok: true, released }, 200)
}

async function webhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text()
  const eventType = request.headers.get('Paddle-Event-Type') ?? ''
  const signature = request.headers.get('Paddle-Signature') ?? ''
  const parsed = parseSignatureHeader(signature)

  if (!eventType) return fail('missing Paddle-Event-Type', 400)
  if (!parsed) return fail('missing or malformed Paddle-Signature', 401)
  if (!env.PADDLE_WEBHOOK_SECRET) {
    return fail('webhook secret is not configured', 500)
  }
  const expected = await expectedSignature(
    eventType,
    body,
    env.PADDLE_WEBHOOK_SECRET,
  )
  if (expected !== parsed.h1) return fail('signature mismatch', 401)

  const action = actionForEvent(eventType)
  if (action === 'ignore') return json({ ok: true, action, handled: false })

  const payload = (JSON.parse(body) as PaddleWebhookPayload) ?? {}
  const licenseKey = licenseKeyFromEvent(payload)
  if (!licenseKey) return json({ ok: true, action, handled: false })

  const nowSeconds = Math.floor(Date.now() / 1000)
  const ids = idsFromEvent(payload)
  if (action === 'activate') {
    await activateLicense(env.LICENSES, licenseKey, nowSeconds, ids)
  } else {
    await revokeLicense(env.LICENSES, licenseKey, nowSeconds)
  }
  return json({ ok: true, action, handled: true })
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>
