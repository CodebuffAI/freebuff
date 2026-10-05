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

const activate = (licenseKey: string, deviceId: string) =>
  post('/activate', { licenseKey, deviceId })

async function signedWebhook(
  eventType: string,
  payload: unknown,
  secret = WEBHOOK_SECRET,
): Promise<Response> {
  const body = JSON.stringify(payload)
  const h1 = await expectedSignature(eventType, body, secret)
  return handleRequest(
    new Request('https://license.test/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Paddle-Event-Type': eventType,
        'Paddle-Signature': `ts=1700000000;h1=${h1}`,
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
    const res = await activate('PA-UNKNOWN', 'device-1')
    expect(res.status).toBe(404)
    expect((await json(res)).error).toContain('unknown license')
  })

  test('validates the request body', async () => {
    expect((await post('/activate', { deviceId: 'device-1' })).status).toBe(400)
    expect((await post('/activate', { licenseKey: 'PA-1' })).status).toBe(400)
    expect((await activate('PA-1', 'short')).status).toBe(400)
    const res = await handleRequest(
      new Request('https://license.test/activate', {
        method: 'POST',
        body: 'not json',
      }),
      env,
    )
    expect(res.status).toBe(400)
  })

  test('mints a token the app can verify for that device', async () => {
    await activateLicense(kv, 'PA-GOOD', 1)
    const res = await activate('PA-GOOD', 'device-1')
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
    const stored = await kv.get('license:PA-GOOD')
    expect(JSON.parse(stored!).devices).toEqual(['device-1'])
    const again = await activate('PA-GOOD', 'device-1')
    expect(again.status).toBe(200)
    expect(JSON.parse((await kv.get('license:PA-GOOD'))!).devices).toEqual([
      'device-1',
    ])
  })

  test('caps a license at three devices', async () => {
    await activateLicense(kv, 'PA-GOOD', 1)
    for (const device of ['device-1', 'device-2', 'device-3']) {
      expect((await activate('PA-GOOD', device)).status).toBe(200)
    }
    const rejected = await activate('PA-GOOD', 'device-4')
    expect(rejected.status).toBe(409)
    expect((await json(rejected)).error).toContain('maximum number of devices')
  })

  test('refuses a revoked license', async () => {
    await activateLicense(kv, 'PA-REFUNDED', 1)
    await revokeLicense(kv, 'PA-REFUNDED', 2)
    const res = await activate('PA-REFUNDED', 'device-1')
    expect(res.status).toBe(410)
    expect((await json(res)).error).toContain('revoked')
  })

  test('rate limits by client ip', async () => {
    await activateLicense(kv, 'PA-GOOD', 1)
    const req = () =>
      handleRequest(
        new Request('https://license.test/activate', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'CF-Connecting-IP': '1.2.3.4',
          },
          body: JSON.stringify({ licenseKey: 'PA-GOOD', deviceId: 'device-1' }),
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
    await activateLicense(kv, 'PA-GOOD', 1)
    for (const device of ['device-1', 'device-2', 'device-3']) {
      expect((await activate('PA-GOOD', device)).status).toBe(200)
    }
    expect((await activate('PA-GOOD', 'device-4')).status).toBe(409)

    const res = await post('/deactivate', {
      licenseKey: 'PA-GOOD',
      deviceId: 'device-2',
    })
    expect(res.status).toBe(200)
    expect((await json(res)).released).toBe(true)
    expect((await activate('PA-GOOD', 'device-4')).status).toBe(200)

    // Releasing an unknown slot is a no-op, not an error.
    const repeat = await post('/deactivate', {
      licenseKey: 'PA-GOOD',
      deviceId: 'device-2',
    })
    expect((await json(repeat)).released).toBe(false)
  })

  test('validates the body', async () => {
    expect((await post('/deactivate', { licenseKey: 'PA-GOOD' })).status).toBe(
      400,
    )
  })
})

describe('webhook', () => {
  test('activates a license key on issuance', async () => {
    const res = await signedWebhook('license_key_created', {
      event_type: 'license_key_created',
      data: { id: 'txn_1', license_key: { id: 'lic_1', key: 'PA-NEW' } },
    })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      ok: true,
      action: 'activate',
      handled: true,
    })
    expect((await activate('PA-NEW', 'device-1')).status).toBe(200)
  })

  test('a refund revokes the license and frees every device', async () => {
    await activateLicense(kv, 'PA-NEW', 1)
    await activate('PA-NEW', 'device-1')
    await activate('PA-NEW', 'device-2')

    const res = await signedWebhook('transaction.refunded', {
      event_type: 'transaction.refunded',
      data: { license_key: { key: 'PA-NEW' } },
    })
    expect((await json(res)).action).toBe('revoke')
    const revoked = await activate('PA-NEW', 'device-3')
    expect(revoked.status).toBe(410)
    expect(JSON.parse((await kv.get('license:PA-NEW'))!).devices).toEqual([])
  })

  test('ignores events with no license key or no interest', async () => {
    const noKey = await signedWebhook('subscription.created', {
      event_type: 'subscription.created',
      data: {},
    })
    expect(await json(noKey)).toEqual({
      ok: true,
      action: 'ignore',
      handled: false,
    })
    const unrelated = await signedWebhook('license_key_activated', {
      event_type: 'license_key_activated',
      data: {},
    })
    expect((await json(unrelated)).handled).toBe(false)
  })

  test('rejects a forged or mismatched signature', async () => {
    const forged = await signedWebhook(
      'license_key_created',
      { data: { license_key: { key: 'PA-NEW' } } },
      'whsec_wrong',
    )
    expect(forged.status).toBe(401)
    expect((await json(forged)).error).toContain('signature mismatch')

    const unsigned = await handleRequest(
      new Request('https://license.test/webhook', {
        method: 'POST',
        headers: { 'Paddle-Event-Type': 'license_key_created' },
        body: '{}',
      }),
      env,
    )
    expect(unsigned.status).toBe(401)
  })

  test('rejects a body edited after signing', async () => {
    const body = JSON.stringify({ data: { license_key: { key: 'PA-A' } } })
    const h1 = await expectedSignature(
      'license_key_created',
      body,
      WEBHOOK_SECRET,
    )
    const res = await handleRequest(
      new Request('https://license.test/webhook', {
        method: 'POST',
        headers: {
          'Paddle-Event-Type': 'license_key_created',
          'Paddle-Signature': `ts=1;h1=${h1}`,
        },
        body: JSON.stringify({ data: { license_key: { key: 'PA-B' } } }),
      }),
      env,
    )
    expect(res.status).toBe(401)
  })

  test('fails closed when no webhook secret is configured', async () => {
    const noSecretEnv = { ...env, PADDLE_WEBHOOK_SECRET: '' }
    const res = await handleRequest(
      new Request('https://license.test/webhook', {
        method: 'POST',
        headers: {
          'Paddle-Event-Type': 'license_key_created',
          'Paddle-Signature': 'ts=1;h1=deadbeef',
        },
        body: '{}',
      }),
      noSecretEnv,
    )
    expect(res.status).toBe(500)
  })
})
