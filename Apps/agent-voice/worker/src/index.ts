/** Cloudflare Worker: the license backend.
 *
 * Routes:
 *   POST /activate    {licenseCode, deviceId} → {token}   — claim a device slot
 *   POST /deactivate  {licenseCode, deviceId} → {ok}     — release a device slot
 *   POST /webhook     (Paddle, HMAC verified)  → {ok}     — activate/revoke on events
 *   GET  /health                               → {ok}     — liveness probe
 *
 * Paddle Billing issues no license keys, so the license code *is* the paid
 * transaction id (`txn_…`). Entitlements are only ever granted after Paddle
 * reports `transaction.completed`. The response token is signed with Ed25519 so
 * the app can verify Pro offline.
 */

import {
  actionForEvent,
  adjustmentRevokes,
  expectedSignature,
  idsFromEvent,
  isTransactionId,
  licenseCodeFromEvent,
  parseSignatureHeader,
  signaturesMatch,
  timestampIsFresh,
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

function normalizeCode(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read the license code from a request body. `licenseKey` is accepted so an
 * older build of the app keeps activating after an upgrade.
 */
function licenseCodeFromBody(body: Record<string, unknown>): string {
  return normalizeCode(
    body.licenseCode ??
      body.license_code ??
      body.licenseKey ??
      body.license_key,
  )
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
  const licenseCode = licenseCodeFromBody(body)
  const deviceId = normalizeCode(body.deviceId ?? body.device_id)
  if (!licenseCode || !deviceId)
    return fail('licenseCode and deviceId are required', 400)

  // A license code is a Paddle transaction id and a device id is a UUID minted
  // by the app; refusing anything else keeps KV from becoming a free datastore.
  if (!isTransactionId(licenseCode)) return fail('invalid license code', 400)
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) {
    return fail('invalid deviceId', 400)
  }

  const record = await getLicense(env.LICENSES, licenseCode)
  if (!record)
    return fail(
      'no purchase found for that code — check the txn_… id in your receipt',
      404,
    )
  if (record.status !== 'active') {
    return fail('this license has been revoked (refund or chargeback)', 410)
  }
  if (
    !(await claimDevice(
      env.LICENSES,
      licenseCode,
      record,
      deviceId,
      nowSeconds,
    ))
  ) {
    return fail(
      'this license is already active on the maximum number of devices',
      409,
    )
  }

  const claims = await buildClaims({ licenseCode, deviceId, nowSeconds })
  const token = await mintToken(claims, env.SIGNING_KEY)
  return json({ ok: true, token, expiresAt: claims.exp }, 200)
}

async function deactivate(request: Request, env: Env): Promise<Response> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const body = await readBody(request)
  if (!body) return fail('invalid JSON body', 400)
  const licenseCode = licenseCodeFromBody(body)
  const deviceId = normalizeCode(body.deviceId ?? body.device_id)
  if (!licenseCode || !deviceId)
    return fail('licenseCode and deviceId are required', 400)
  const released = await releaseDevice(
    env.LICENSES,
    licenseCode,
    deviceId,
    nowSeconds,
  )
  // Releasing an unknown slot is fine: the client's intent is "this device no
  // longer counts", which is already true.
  return json({ ok: true, released }, 200)
}

async function webhook(request: Request, env: Env): Promise<Response> {
  // Signature verification runs over the *raw* bytes, before any parsing.
  const body = await request.text()
  const signature = request.headers.get('Paddle-Signature') ?? ''
  const parsed = parseSignatureHeader(signature)

  if (!parsed) return fail('missing or malformed Paddle-Signature', 401)
  if (!env.PADDLE_WEBHOOK_SECRET) {
    return fail('webhook secret is not configured', 500)
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  if (!timestampIsFresh(parsed.ts, nowSeconds)) {
    return fail('signature timestamp outside the accepted window', 401)
  }
  const expected = await expectedSignature(
    parsed.ts,
    body,
    env.PADDLE_WEBHOOK_SECRET,
  )
  if (!signaturesMatch(expected, parsed.h1)) {
    return fail('signature mismatch', 401)
  }

  // Verified — only now is the payload safe to parse.
  let payload: PaddleWebhookPayload
  try {
    payload = (JSON.parse(body) as PaddleWebhookPayload) ?? {}
  } catch {
    return fail('invalid JSON body', 400)
  }
  // Paddle sends no event-type header; `event_type` is a payload field.
  const eventType = payload.event_type ?? ''
  if (!eventType) return fail('missing event_type', 400)

  const action = actionForEvent(eventType)
  if (action === 'ignore') return json({ ok: true, action, handled: false })

  // `adjustment.created` covers refunds, chargebacks *and* harmless credits, so
  // the action decides whether the license actually goes away.
  if (action === 'revoke' && !adjustmentRevokes(payload.data?.action)) {
    return json({ ok: true, action, handled: false })
  }

  const licenseCode = licenseCodeFromEvent(payload)
  if (!licenseCode) return json({ ok: true, action, handled: false })

  const ids = idsFromEvent(payload)
  if (action === 'activate') {
    await activateLicense(env.LICENSES, licenseCode, nowSeconds, ids)
  } else {
    await revokeLicense(env.LICENSES, licenseCode, nowSeconds)
  }
  return json({ ok: true, action, handled: true })
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>
