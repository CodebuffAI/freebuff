import { beforeEach, describe, expect, test } from 'bun:test'
import { handleRequest, type Env } from '../src/index'
import { expectedSignature } from '../src/paddle'
import { activateLicense, revokeLicense } from '../src/store'
import { verifyToken } from '../src/tokens'
import { MemoryKV } from './memory-kv'

const PRIVATE_KEY =
  'MC4CAQAwBQYDK2VwBCIEIOoHCq5N2gp01ShDliYEDZj5BjchLFHfkvI2CD3jpzvu'
const PUBLIC_KEY = 'ouHWrlcY5+OOry5d0fMknb4il4mIIHb4n+lOhP61+K8='
const WEBHOOK_SECRET = 'whsec_test'
/** Realistic Paddle transaction ids — a license code *is* a transaction id. */
const TXN = 'txn_01m45q62gzqns1n98dwp38038q'
const TXN_OTHER = 'txn_01m45q62gzqns1n98dwp38038z'
const TXN_REFUNDED = 'txn_01m45q62gzqns1n98dwp38039y'
/** A transaction the worker has never seen, used to prove a webhook mints it. */
const TXN_UNKNOWN = 'txn_01m45q62gzqns1n98dwp38037r'

let kv: MemoryKV
let env: Env

beforeEach(() => {
  kv = new MemoryKV()
  env = {
    LICENSES: kv,
    SIGNING_KEY: PRIVATE_KEY,
    PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  }
})

/** `Response.json()` is typed as `Promise<undefined>` by workers-types; this
 *  helper keeps the assertions readable. Test-only, hence `any`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return (await res.json()) as any
}

const post = (path: string, body: unknown) =>
  handleRequest(
    new Request(`https://license.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  )

const activate = (licenseCode: string, deviceId: string) =>
  post('/activate', { licenseCode, deviceId })

async function signedWebhook(
  eventType: string,
  data: unknown,
  secret = WEBHOOK_SECRET,
  options: { timestamp?: number } = {},
): Promise<Response> {
  const body = JSON.stringify({ event_type: eventType, data })
  const ts = options.timestamp ?? Math.floor(Date.now() / 1000)
  const h1 = await expectedSignature(String(ts), body, secret)
  return handleRequest(
    new Request('https://license.test/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Paddle sends no event-type header — the event type is in the body.
        'Paddle-Signature': `ts=${ts};h1=${h1}`,
      },
      body,
    }),
    env,
  )
}

describe('routing', () => {
  test('health responds without touching KV', async () => {
    const res = await handleRequest(
      new Request('https://license.test/health'),
      env,
    )
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      ok: true,
      service: 'agent-voice-license',
    })
  })

  test('unknown routes and methods are 404', async () => {
    expect(
      (await handleRequest(new Request('https://license.test/nope'), env))
        .status,
    ).toBe(404)
    expect((await post('/health', {})).status).toBe(404)
  })
})

describe('activate', () => {
  test('rejects an unknown license', async () => {
    const res = await activate(TXN_OTHER, 'device-1')
    expect(res.status).toBe(404)
    expect((await json(res)).error).toContain('no purchase found')
  })

  test('validates the request body', async () => {
    expect((await post('/activate', { deviceId: 'device-1' })).status).toBe(400)
    expect((await post('/activate', { licenseCode: TXN })).status).toBe(400)
    expect((await activate(TXN, 'short')).status).toBe(400)
    const res = await handleRequest(
      new Request('https://license.test/activate', {
        method: 'POST',
        body: 'not json',
      }),
      env,
    )
    expect(res.status).toBe(400)
  })

  test('refuses anything that is not a paddle transaction id', async () => {
    const res = await activate('PA-ABCD-1234', 'device-1')
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('invalid license code')
  })

  test('still accepts the legacy licenseKey field', async () => {
    await activateLicense(kv, TXN, 1)
    const res = await post('/activate', {
      licenseKey: TXN,
      deviceId: 'device-1',
    })
    expect(res.status).toBe(200)
  })

  test('mints a token the app can verify for that device', async () => {
    await activateLicense(kv, TXN, 1)
    const res = await activate(TXN, 'device-1')
    expect(res.status).toBe(200)
    const issued = await json(res)
    expect(issued.expiresAt).toBeGreaterThan(Date.now() / 1000)

    const claims = await verifyToken(
      issued.token,
      PUBLIC_KEY,
      Math.floor(Date.now() / 1000),
      'device-1',
    )
    expect(claims.ent).toEqual(['pro'])
    expect(claims.dev).toBe('device-1')

    // The device slot is remembered so a refresh re-issues without a new slot.
    const stored = await kv.get(`license:${TXN}`)
    expect(JSON.parse(stored!).devices).toEqual(['device-1'])
    const again = await activate(TXN, 'device-1')
    expect(again.status).toBe(200)
    expect(JSON.parse((await kv.get(`license:${TXN}`))!).devices).toEqual([
      'device-1',
    ])
  })

  test('caps a license at three devices', async () => {
    await activateLicense(kv, TXN, 1)
    for (const device of ['device-1', 'device-2', 'device-3']) {
      expect((await activate(TXN, device)).status).toBe(200)
    }
    const rejected = await activate(TXN, 'device-4')
    expect(rejected.status).toBe(409)
    expect((await json(rejected)).error).toContain('maximum number of devices')
  })

  test('refuses a revoked license', async () => {
    await activateLicense(kv, TXN_REFUNDED, 1)
    await revokeLicense(kv, TXN_REFUNDED, 2)
    const res = await activate(TXN_REFUNDED, 'device-1')
    expect(res.status).toBe(410)
    expect((await json(res)).error).toContain('revoked')
  })

  test('rate limits by client ip', async () => {
    await activateLicense(kv, TXN, 1)
    const req = () =>
      handleRequest(
        new Request('https://license.test/activate', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'CF-Connecting-IP': '1.2.3.4',
          },
          body: JSON.stringify({ licenseCode: TXN, deviceId: 'device-1' }),
        }),
        env,
      )
    let limited: Response | null = null
    for (let i = 0; i < 25; i += 1) {
      const res = await req()
      if (res.status === 429) {
        limited = res
        break
      }
    }
    expect(limited).not.toBeNull()
    expect((await json(limited!)).error).toContain('too many attempts')
  })
})

describe('deactivate', () => {
  test('frees the device slot', async () => {
    await activateLicense(kv, TXN, 1)
    for (const device of ['device-1', 'device-2', 'device-3']) {
      expect((await activate(TXN, device)).status).toBe(200)
    }
    expect((await activate(TXN, 'device-4')).status).toBe(409)

    const res = await post('/deactivate', {
      licenseCode: TXN,
      deviceId: 'device-2',
    })
    expect(res.status).toBe(200)
    expect((await json(res)).released).toBe(true)
    expect((await activate(TXN, 'device-4')).status).toBe(200)

    // Releasing an unknown slot is a no-op, not an error.
    const repeat = await post('/deactivate', {
      licenseCode: TXN,
      deviceId: 'device-2',
    })
    expect((await json(repeat)).released).toBe(false)
  })

  test('validates the body', async () => {
    expect((await post('/deactivate', { licenseCode: TXN })).status).toBe(400)
  })
})

describe('webhook', () => {
  test('activates a license on a completed transaction', async () => {
    const res = await signedWebhook('transaction.completed', {
      id: TXN,
      status: 'completed',
    })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      ok: true,
      action: 'activate',
      handled: true,
    })
    expect((await activate(TXN, 'device-1')).status).toBe(200)
    // The transaction id is kept for support.
    expect(
      JSON.parse((await kv.get(`license:${TXN}`))!).paddleTransactionId,
    ).toBe(TXN)
  })

  test('reads the event type from the payload, not a header', async () => {
    // Paddle sends no Paddle-Event-Type header; this request must not send one
    // either, and it still has to be routed correctly.
    expect((await activate(TXN_UNKNOWN, 'device-1')).status).toBe(404)
    const res = await signedWebhook('transaction.completed', {
      id: TXN_UNKNOWN,
      status: 'completed',
    })
    expect(await json(res)).toEqual({
      ok: true,
      action: 'activate',
      handled: true,
    })
    expect((await activate(TXN_UNKNOWN, 'device-1')).status).toBe(200)
  })

  test('a refund adjustment revokes the license and frees every device', async () => {
    await activateLicense(kv, TXN, 1)
    await activate(TXN, 'device-1')
    await activate(TXN, 'device-2')

    const res = await signedWebhook('adjustment.created', {
      id: 'adj_01m45q62gzqns1n98dwp38038q',
      action: 'refund',
      transaction_id: TXN,
    })
    expect((await json(res)).action).toBe('revoke')
    const revoked = await activate(TXN, 'device-3')
    expect(revoked.status).toBe(410)
    expect(JSON.parse((await kv.get(`license:${TXN}`))!).devices).toEqual([])
  })

  test('a chargeback adjustment revokes too', async () => {
    await activateLicense(kv, TXN, 1)
    const res = await signedWebhook('adjustment.created', {
      id: 'adj_1',
      action: 'chargeback',
      transaction_id: TXN,
    })
    expect((await json(res)).handled).toBe(true)
    expect((await activate(TXN, 'device-1')).status).toBe(410)
  })

  test('a credit note or dispute warning keeps the license', async () => {
    for (const action of ['credit', 'chargeback_warning']) {
      await activateLicense(kv, TXN, 1)
      const res = await signedWebhook('adjustment.created', {
        id: 'adj_1',
        action,
        transaction_id: TXN,
      })
      expect(await json(res)).toEqual({
        ok: true,
        action: 'revoke',
        handled: false,
      })
      expect((await activate(TXN, 'device-1')).status).toBe(200)
    }
  })

  test('ignores events with no transaction or no interest', async () => {
    const noData = await signedWebhook('subscription.created', {})
    expect(await json(noData)).toEqual({
      ok: true,
      action: 'ignore',
      handled: false,
    })
    // An activation with a non-transaction id must not mint a license.
    const junk = await signedWebhook('transaction.completed', {
      id: 'che_01m45q62gzqns1n98dwp38038q',
    })
    expect((await json(junk)).handled).toBe(false)
    expect(await kv.get('license:che_01m45q62gzqns1n98dwp38038q')).toBeNull()
  })

  test('rejects a forged or mismatched signature', async () => {
    const forged = await signedWebhook(
      'transaction.completed',
      { id: TXN },
      'whsec_wrong',
    )
    expect(forged.status).toBe(401)
    expect((await json(forged)).error).toContain('signature mismatch')

    const unsigned = await handleRequest(
      new Request('https://license.test/webhook', {
        method: 'POST',
        body: '{}',
      }),
      env,
    )
    expect(unsigned.status).toBe(401)
  })

  test('rejects a body edited after signing', async () => {
    const ts = Math.floor(Date.now() / 1000)
    const original = JSON.stringify({
      event_type: 'transaction.completed',
      data: { id: TXN },
    })
    const h1 = await expectedSignature(String(ts), original, WEBHOOK_SECRET)
    const res = await handleRequest(
      new Request('https://license.test/webhook', {
        method: 'POST',
        headers: { 'Paddle-Signature': `ts=${ts};h1=${h1}` },
        body: JSON.stringify({
          event_type: 'transaction.completed',
          data: { id: TXN_UNKNOWN },
        }),
      }),
      env,
    )
    expect(res.status).toBe(401)
    expect((await json(res)).error).toContain('signature mismatch')
  })

  test('rejects a stale timestamp to blunt replay', async () => {
    const stale = Math.floor(Date.now() / 1000) - 4000
    const res = await signedWebhook(
      'transaction.completed',
      { id: TXN },
      WEBHOOK_SECRET,
      { timestamp: stale },
    )
    expect(res.status).toBe(401)
    expect((await json(res)).error).toContain('timestamp')
    expect(await kv.get(`license:${TXN}`)).toBeNull()
  })

  test('rejects a timestamp that is not a number', async () => {
    const body = JSON.stringify({
      event_type: 'transaction.completed',
      data: { id: TXN },
    })
    const h1 = await expectedSignature('nope', body, WEBHOOK_SECRET)
    const res = await handleRequest(
      new Request('https://license.test/webhook', {
        method: 'POST',
        headers: { 'Paddle-Signature': `ts=nope;h1=${h1}` },
        body,
      }),
      env,
    )
    expect(res.status).toBe(401)
    expect((await json(res)).error).toContain('timestamp')
  })

  test('rejects a payload with no event type', async () => {
    const ts = Math.floor(Date.now() / 1000)
    const body = JSON.stringify({ data: { id: TXN } })
    const h1 = await expectedSignature(String(ts), body, WEBHOOK_SECRET)
    const res = await handleRequest(
      new Request('https://license.test/webhook', {
        method: 'POST',
        headers: { 'Paddle-Signature': `ts=${ts};h1=${h1}` },
        body,
      }),
      env,
    )
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('event_type')
    expect(await kv.get(`license:${TXN}`)).toBeNull()
  })

  test('fails closed when no webhook secret is configured', async () => {
    const noSecretEnv = { ...env, PADDLE_WEBHOOK_SECRET: '' }
    const ts = Math.floor(Date.now() / 1000)
    const res = await handleRequest(
      new Request('https://license.test/webhook', {
        method: 'POST',
        headers: { 'Paddle-Signature': `ts=${ts};h1=deadbeef` },
        body: '{}',
      }),
      noSecretEnv,
    )
    expect(res.status).toBe(500)
  })
})
