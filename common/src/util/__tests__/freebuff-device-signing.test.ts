import { createHash } from 'node:crypto'

import { describe, expect, mock, test } from 'bun:test'

import {
  FREEBUFF_DEVICE_KEY_HEADER,
  FREEBUFF_DEVICE_KEYS_PATH,
  FREEBUFF_DEVICE_SIGNATURE_HEADER,
  FREEBUFF_DEVICE_TIMESTAMP_HEADER,
  freebuffDeviceSignaturePayload,
} from '../../types/freebuff-model-catalog'
import {
  base64UrlDecode,
  FreebuffDeviceSigner,
  isFreebuffDeviceKeyUnknownError,
  parseFreebuffDeviceKeyRecord,
} from '../freebuff-device-signing'

import type { FreebuffDeviceKeyRecord } from '../freebuff-device-signing'

const ACCOUNT = { token: 'tok-1', accountId: 'user-1', apiHost: 'https://api.test' }

function memoryStore(initial: FreebuffDeviceKeyRecord | null = null) {
  const state = { record: initial, saves: 0 }
  return {
    state,
    store: {
      load: async () =>
        state.record ? parseFreebuffDeviceKeyRecord(JSON.parse(JSON.stringify(state.record))) : null,
      save: async (record: FreebuffDeviceKeyRecord) => {
        state.saves++
        state.record = JSON.parse(JSON.stringify(record))
      },
    },
  }
}

function registrar(answer: () => Response = () => Response.json({ keyId: 'key-1' })) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = mock(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return answer()
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

/** Verifies the three headers independently of the signer: node's SHA-256,
 *  the contract's payload, WebCrypto's Ed25519 verify. */
async function verifies(
  record: FreebuffDeviceKeyRecord,
  headers: Record<string, string>,
  request: { method: string; url: string; body?: string; fetchId?: string | null },
): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey(
    'raw',
    base64UrlDecode(record.publicKey) as BufferSource,
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  const payload = freebuffDeviceSignaturePayload({
    method: request.method,
    path: new URL(request.url).pathname,
    timestampMs: Number(headers[FREEBUFF_DEVICE_TIMESTAMP_HEADER]),
    bodySha256: createHash('sha256').update(request.body ?? '').digest('hex'),
    fetchId: request.fetchId,
  })
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    base64UrlDecode(headers[FREEBUFF_DEVICE_SIGNATURE_HEADER]!) as BufferSource,
    new TextEncoder().encode(payload) as BufferSource,
  )
}

describe('FreebuffDeviceSigner', () => {
  test('registers once, then signs a request that verifies against the contract payload', async () => {
    const { state, store } = memoryStore()
    const { calls, fetchImpl } = registrar()
    const signer = new FreebuffDeviceSigner({
      store,
      client: 'cli',
      fetch: fetchImpl,
      now: () => 1_700_000_000_000,
    })
    const request = {
      method: 'POST',
      url: 'https://api.test/api/v1/chat/completions?x=1',
      body: '{"model":"fbm1.abc","messages":[]}',
      fetchId: 'fetch-9',
    }
    const headers = await signer.headers(ACCOUNT, request)
    expect(headers[FREEBUFF_DEVICE_KEY_HEADER]).toBe('key-1')
    expect(headers[FREEBUFF_DEVICE_TIMESTAMP_HEADER]).toBe('1700000000000')
    expect(await verifies(state.record!, headers, request)).toBe(true)
    // a different body, path or fetch id does not verify
    expect(await verifies(state.record!, headers, { ...request, body: '{}' })).toBe(false)
    expect(await verifies(state.record!, headers, { ...request, fetchId: null })).toBe(false)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://api.test${FREEBUFF_DEVICE_KEYS_PATH}`)
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer tok-1')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      publicKey: state.record!.publicKey,
      client: 'cli',
    })
    expect(base64UrlDecode(state.record!.publicKey)).toHaveLength(32)

    // a body-less request signs the empty body
    const get = { method: 'GET', url: 'https://api.test/api/v1/freebuff/session' }
    const getHeaders = await signer.headers(ACCOUNT, get)
    expect(await verifies(state.record!, getHeaders, get)).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test('the key and its registration survive a restart; a new account or host registers once each', async () => {
    const { state, store } = memoryStore()
    const first = registrar()
    await new FreebuffDeviceSigner({ store, client: 'cli', fetch: first.fetchImpl })
      .headers(ACCOUNT, { method: 'GET', url: 'https://api.test/x' })
    const publicKey = state.record!.publicKey

    const second = registrar(() => Response.json({ keyId: 'key-2' }))
    const signer = new FreebuffDeviceSigner({ store, client: 'cli', fetch: second.fetchImpl })
    const headers = await signer.headers(ACCOUNT, { method: 'GET', url: 'https://api.test/x' })
    expect(headers[FREEBUFF_DEVICE_KEY_HEADER]).toBe('key-1')
    expect(second.calls).toHaveLength(0)
    expect(state.record!.publicKey).toBe(publicKey)

    await signer.headers({ ...ACCOUNT, accountId: 'user-2' }, { method: 'GET', url: 'https://api.test/x' })
    await signer.headers({ ...ACCOUNT, accountId: 'user-2' }, { method: 'GET', url: 'https://api.test/x' })
    await signer.headers({ ...ACCOUNT, apiHost: 'https://other.test' }, { method: 'GET', url: 'https://other.test/x' })
    expect(second.calls.map((c) => c.url)).toEqual([
      `https://api.test${FREEBUFF_DEVICE_KEYS_PATH}`,
      `https://other.test${FREEBUFF_DEVICE_KEYS_PATH}`,
    ])
    await signer.settled()
    expect(Object.keys(state.record!.registrations)).toHaveLength(3)
  })

  test('concurrent first requests share one registration', async () => {
    const { store } = memoryStore()
    const { calls, fetchImpl } = registrar()
    const signer = new FreebuffDeviceSigner({ store, client: 'desktop', fetch: fetchImpl })
    const all = await Promise.all(
      [1, 2, 3].map(() => signer.headers(ACCOUNT, { method: 'GET', url: 'https://api.test/x' })),
    )
    expect(all.every((h) => h[FREEBUFF_DEVICE_KEY_HEADER] === 'key-1')).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test('forgetting a registration registers again on the next request', async () => {
    const { store } = memoryStore()
    let next = 1
    const { calls, fetchImpl } = registrar(() => Response.json({ keyId: `key-${next++}` }))
    const signer = new FreebuffDeviceSigner({ store, client: 'cli', fetch: fetchImpl })
    const request = { method: 'GET', url: 'https://api.test/x' }
    expect((await signer.headers(ACCOUNT, request))[FREEBUFF_DEVICE_KEY_HEADER]).toBe('key-1')
    signer.forgetRegistration(ACCOUNT)
    await signer.settled()
    expect((await signer.headers(ACCOUNT, request))[FREEBUFF_DEVICE_KEY_HEADER]).toBe('key-2')
    expect(calls).toHaveLength(2)
  })

  test('a failed registration sends unsigned and is not retried on every request', async () => {
    const { store } = memoryStore()
    let now = 1_000
    const { calls, fetchImpl } = registrar(() => new Response('nope', { status: 404 }))
    const signer = new FreebuffDeviceSigner({ store, client: 'cli', fetch: fetchImpl, now: () => now })
    const request = { method: 'GET', url: 'https://api.test/x' }
    expect(await signer.headers(ACCOUNT, request)).toEqual({})
    expect(await signer.headers(ACCOUNT, request)).toEqual({})
    expect(calls).toHaveLength(1)
    now += 61 * 60_000
    expect(await signer.headers(ACCOUNT, request)).toEqual({})
    expect(calls).toHaveLength(2)
  })

  test('register: false never registers or generates, but signs with a registration it has', async () => {
    const { state, store } = memoryStore()
    const { calls, fetchImpl } = registrar()
    const signer = new FreebuffDeviceSigner({ store, client: 'cli', fetch: fetchImpl })
    const request = { method: 'GET', url: 'https://api.test/api/v1/freebuff/models' }
    expect(await signer.headers(ACCOUNT, request, { register: false })).toEqual({})
    expect(calls).toHaveLength(0)
    expect(state.record).toBeNull()

    await signer.headers(ACCOUNT, request)
    const headers = await signer.headers(ACCOUNT, request, { register: false })
    expect(headers[FREEBUFF_DEVICE_KEY_HEADER]).toBe('key-1')
    expect(await verifies(state.record!, headers, request)).toBe(true)
  })

  test('no WebCrypto Ed25519: nothing is signed, stored or registered', async () => {
    const { state, store } = memoryStore()
    const { calls, fetchImpl } = registrar()
    const signer = new FreebuffDeviceSigner({ store, client: 'cli', fetch: fetchImpl, subtle: null })
    expect(await signer.headers(ACCOUNT, { method: 'GET', url: 'https://api.test/x' })).toEqual({})
    expect(calls).toHaveLength(0)
    expect(state.record).toBeNull()
  })

  test('an Ed25519 the runtime refuses falls back to unsigned', async () => {
    const { store } = memoryStore()
    const { calls, fetchImpl } = registrar()
    const refusing = {
      generateKey: async () => {
        throw new Error('Ed25519 not supported')
      },
    } as unknown as SubtleCrypto
    const signer = new FreebuffDeviceSigner({ store, client: 'cli', fetch: fetchImpl, subtle: refusing })
    expect(await signer.headers(ACCOUNT, { method: 'GET', url: 'https://api.test/x' })).toEqual({})
    expect(calls).toHaveLength(0)
  })

  test('a store that cannot be read turns signing off instead of replacing the key', async () => {
    const save = mock(async () => {})
    const { calls, fetchImpl } = registrar()
    const signer = new FreebuffDeviceSigner({
      store: {
        load: async () => {
          throw new Error('keychain refused')
        },
        save,
      },
      client: 'desktop',
      fetch: fetchImpl,
    })
    expect(await signer.headers(ACCOUNT, { method: 'GET', url: 'https://api.test/x' })).toEqual({})
    expect(save).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  test('a slow registration does not hold the request past waitMs, and signs the next one', async () => {
    const { store } = memoryStore()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl = (async () => {
      await gate
      return Response.json({ keyId: 'late' })
    }) as unknown as typeof fetch
    const signer = new FreebuffDeviceSigner({ store, client: 'cli', fetch: fetchImpl, waitMs: 20 })
    const request = { method: 'GET', url: 'https://api.test/x' }
    expect(await signer.headers(ACCOUNT, request)).toEqual({})
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await signer.headers(ACCOUNT, request))[FREEBUFF_DEVICE_KEY_HEADER]).toBe('late')
  })

  test('an account without a known id is scoped by its token', async () => {
    const { calls, fetchImpl } = registrar()
    const signer = new FreebuffDeviceSigner({ store: memoryStore().store, client: 'cli', fetch: fetchImpl })
    const anon = { token: 't-a', apiHost: 'https://api.test' }
    await signer.headers(anon, { method: 'GET', url: 'https://api.test/x' })
    await signer.headers(anon, { method: 'GET', url: 'https://api.test/x' })
    await signer.headers({ ...anon, token: 't-b' }, { method: 'GET', url: 'https://api.test/x' })
    expect(calls).toHaveLength(2)
  })
})

test('isFreebuffDeviceKeyUnknownError matches device-key codes only', () => {
  expect(isFreebuffDeviceKeyUnknownError('freebuff_device_key_unknown')).toBe(true)
  expect(isFreebuffDeviceKeyUnknownError('device_key_not_found')).toBe(true)
  expect(isFreebuffDeviceKeyUnknownError('invalid_device_key')).toBe(true)
  expect(isFreebuffDeviceKeyUnknownError('freebuff_catalog_stale')).toBe(false)
  expect(isFreebuffDeviceKeyUnknownError('not_found')).toBe(false)
  expect(isFreebuffDeviceKeyUnknownError(undefined)).toBe(false)
})
