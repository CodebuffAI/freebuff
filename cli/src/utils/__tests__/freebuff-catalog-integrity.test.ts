/**
 * Catalog integrity on the CLI (docs/freebuff-model-catalog.md): rows that
 * have not opened (scheduled) never reach a request, the catalog fetch id rides
 * on every session and completions request in catalog mode, and those
 * requests carry a device signature that verifies against the contract.
 */
import { createHash } from 'node:crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import {
  FREEBUFF_CATALOG_FETCH_HEADER,
  FREEBUFF_DEVICE_KEY_HEADER,
  FREEBUFF_DEVICE_KEYS_PATH,
  FREEBUFF_DEVICE_SIGNATURE_HEADER,
  FREEBUFF_DEVICE_TIMESTAMP_HEADER,
  freebuffDeviceSignaturePayload,
} from '@codebuff/common/types/freebuff-model-catalog'
import {
  base64UrlDecode,
  FreebuffDeviceSigner,
} from '@codebuff/common/util/freebuff-device-signing'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import {
  getFreebuffCatalog,
  getFreebuffModelDirectory,
  setFreebuffCatalog,
  useFreebuffCatalogStore,
} from '../../state/freebuff-catalog-store'
import {
  getSelectedFreebuffModel,
  persistFreebuffModelPick,
  useFreebuffModelStore,
} from '../../state/freebuff-model-store'
import * as auth from '../auth'
import {
  createFreebuffDeviceKeyFileStore,
  freebuffCatalogCompletionHeaders,
  freebuffDeviceKeyPath,
  setFreebuffDeviceSigner,
} from '../freebuff-device-key'
import {
  applyFreebuffCatalog,
  fetchFreebuffModelCatalog,
} from '../freebuff-model-catalog'
import { freebuffCatalogHandleFor } from '../freebuff-model-directory'
import { callFreebuffSession } from '../freebuff-session-api'
import { catalogFixture, catalogRow } from './freebuff-catalog-fixtures'

import type { FreebuffDeviceKeyRecord } from '@codebuff/common/util/freebuff-device-signing'

const FUTURE = Date.now() + 365 * 24 * 60 * 60_000
const SCHEDULED = catalogRow('m-scheduled', {
  opensAt: FUTURE,
  legacyIds: [FREEBUFF_MIMO_V25_MODEL_ID],
  handle: 'fbm1.SCHEDULED-HANDLE',
})
const CATALOG = catalogFixture(
  [
    catalogRow('m-flash', { legacyIds: [FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID] }),
    SCHEDULED,
    // Open as of the catalog's own issuedAt (server time, 1_000_000).
    catalogRow('m-open', { opensAt: 999_000 }),
  ],
  { recommendedKey: 'm-scheduled', fallbackKey: 'm-scheduled', fetchId: 'fetch-1' },
)

let configDir: string
let fetchSpy: ReturnType<typeof spyOn> | undefined

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-integrity-test-'))
  spyOn(auth, 'getConfigDir').mockReturnValue(configDir)
})

afterEach(() => {
  fetchSpy?.mockRestore()
  fetchSpy = undefined
  setFreebuffCatalog(null)
  setFreebuffDeviceSigner(null)
  useFreebuffCatalogStore.setState({ refreshAfterStale: null })
  fs.rmSync(configDir, { recursive: true, force: true })
})

const headersOf = (call: unknown[]) =>
  new Headers((call[1] as RequestInit | undefined)?.headers)

/** A signer whose registration answers from memory, never the network. */
function installSigner() {
  const state: { record: FreebuffDeviceKeyRecord | null; registrations: number } = {
    record: null,
    registrations: 0,
  }
  const signer = new FreebuffDeviceSigner({
    store: {
      load: async () => state.record,
      save: async (record) => {
        state.record = JSON.parse(JSON.stringify(record))
      },
    },
    client: 'cli',
    fetch: (async (url: unknown) => {
      expect(String(url)).toEndWith(FREEBUFF_DEVICE_KEYS_PATH)
      state.registrations++
      return Response.json({ keyId: 'dev-key-1' })
    }) as unknown as typeof fetch,
  })
  setFreebuffDeviceSigner(signer)
  return state
}

async function verifies(
  record: FreebuffDeviceKeyRecord,
  headers: Headers,
  request: { method: string; url: string; body?: string; fetchId?: string | null },
): Promise<boolean> {
  const signature = headers.get(FREEBUFF_DEVICE_SIGNATURE_HEADER)
  if (!signature) return false
  const publicKey = await crypto.subtle.importKey(
    'raw',
    base64UrlDecode(record.publicKey) as BufferSource,
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    base64UrlDecode(signature) as BufferSource,
    new TextEncoder().encode(
      freebuffDeviceSignaturePayload({
        method: request.method,
        path: new URL(request.url).pathname,
        timestampMs: Number(headers.get(FREEBUFF_DEVICE_TIMESTAMP_HEADER)),
        bodySha256: createHash('sha256').update(request.body ?? '').digest('hex'),
        fetchId: request.fetchId,
      }),
    ) as BufferSource,
  )
}

describe('rows that have not opened (opensAt after issuedAt)', () => {
  test('are dropped from the held catalog and every directory lookup', () => {
    setFreebuffCatalog(CATALOG)
    expect(getFreebuffCatalog()!.rows.map((row) => row.key)).toEqual([
      'm-flash',
      'm-open',
    ])
    // the fetch id survives the filtering
    expect(getFreebuffCatalog()!.fetchId).toBe('fetch-1')
    const directory = getFreebuffModelDirectory()
    expect(directory.pickerModels('full', false).map((m) => m.id)).toEqual([
      'm-flash',
      'm-open',
    ])
    expect(directory.row('m-scheduled')).toBeUndefined()
    expect(directory.isKnown('m-scheduled')).toBe(false)
    // its legacy digest maps nothing onto it
    expect(directory.row(FREEBUFF_MIMO_V25_MODEL_ID)).toBeUndefined()
    // a recommended / fallback key naming it is ignored
    expect(directory.recommendedModelId('full')).toBe('m-flash')
    expect(directory.fallbackModelId).toBe('m-flash')
    expect(directory.resolveSelection('m-scheduled')).toBe('m-flash')
  })

  test('the raw catalog never yields an unopened row handle at send time', () => {
    expect(freebuffCatalogHandleFor(CATALOG, 'm-scheduled')).toBeUndefined()
    expect(freebuffCatalogHandleFor(CATALOG, 'm-flash')).toBe('fbm1.m-flash-h1')
  })

  test('a saved key that maps only to an unopened row resolves to the recommendation', () => {
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    // saved while the row was open; it has not opened in this catalog
    setFreebuffCatalog(catalogFixture([catalogRow('m-scheduled')]))
    persistFreebuffModelPick('m-scheduled')
    setFreebuffCatalog(null)
    applyFreebuffCatalog(
      catalogFixture(
        [catalogRow('m-other'), catalogRow('m-flash', { legacyIds: [FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID] }), SCHEDULED],
        { recommendedKey: 'm-other' },
      ),
    )
    expect(getSelectedFreebuffModel()).toBe('m-other')
  })

  test("an unopened row's handle never reaches an admission or a session call", async () => {
    setFreebuffCatalog(CATALOG)
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      Response.json({ status: 'none' })) as unknown as typeof fetch)
    await callFreebuffSession('POST', 'tok', { model: 'm-scheduled' })
    await callFreebuffSession('POST', 'tok', { model: FREEBUFF_MIMO_V25_MODEL_ID })
    await callFreebuffSession('GET', 'tok', { instanceId: 'i1' })
    for (const call of fetchSpy.mock.calls) {
      const sent = JSON.stringify([...headersOf(call).entries()])
      expect(sent).not.toContain('SCHEDULED-HANDLE')
    }
  })

  test('the selection can never land on an unopened row, so no turn is built on one', () => {
    applyFreebuffCatalog(CATALOG)
    useFreebuffModelStore.getState().setSelectedModel('m-scheduled')
    applyFreebuffCatalog(catalogFixture([...CATALOG.rows], { ...CATALOG }))
    expect(getSelectedFreebuffModel()).not.toBe('m-scheduled')
    expect(getFreebuffModelDirectory().row(getSelectedFreebuffModel())?.handle).not.toBe(
      SCHEDULED.handle,
    )
  })

  test('a catalog whose only rows have not opened is not a catalog', async () => {
    const result = await fetchFreebuffModelCatalog('tok', {
      baseUrl: 'https://api.test',
      deviceHeaders: async () => ({}),
      fetchImpl: (async () =>
        Response.json(catalogFixture([SCHEDULED]))) as unknown as typeof fetch,
    })
    expect(result.kind).toBe('unsupported')
  })
})

describe('fetch id and device signature on session calls', () => {
  test('catalog mode: every call carries the fetch id and a signature that verifies', async () => {
    const device = installSigner()
    setFreebuffCatalog(CATALOG)
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      Response.json({ status: 'none' })) as unknown as typeof fetch)
    await callFreebuffSession('POST', 'tok', { model: 'm-flash' })
    await callFreebuffSession('GET', 'tok', { instanceId: 'i1' })
    await callFreebuffSession('DELETE', 'tok', { instanceId: 'i1' })
    expect(fetchSpy.mock.calls).toHaveLength(3)
    for (const call of fetchSpy.mock.calls) {
      const headers = headersOf(call)
      const init = call[1] as RequestInit
      expect(headers.get(FREEBUFF_CATALOG_FETCH_HEADER)).toBe('fetch-1')
      expect(headers.get(FREEBUFF_DEVICE_KEY_HEADER)).toBe('dev-key-1')
      expect(
        await verifies(device.record!, headers, {
          method: init.method!,
          url: String(call[0]),
          fetchId: 'fetch-1',
        }),
      ).toBe(true)
    }
    expect(device.registrations).toBe(1)
  })

  test('fallback mode: no fetch id, no signature, no registration', async () => {
    const device = installSigner()
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ status: 'none' }),
    )
    await callFreebuffSession('POST', 'tok', { model: 'mimo/mimo-v2.5' })
    const headers = headersOf(fetchSpy.mock.calls[0]!)
    expect(headers.get(FREEBUFF_CATALOG_FETCH_HEADER)).toBeNull()
    expect(headers.get(FREEBUFF_DEVICE_KEY_HEADER)).toBeNull()
    expect(headers.get(FREEBUFF_DEVICE_SIGNATURE_HEADER)).toBeNull()
    expect(device.registrations).toBe(0)
    expect(device.record).toBeNull()
  })

  test('an unknown-device-key answer re-registers on the next call', async () => {
    let keyIds = 0
    const signer = new FreebuffDeviceSigner({
      store: { load: async () => null, save: async () => {} },
      client: 'cli',
      fetch: (async () =>
        Response.json({ keyId: `dev-key-${++keyIds}` })) as unknown as typeof fetch,
    })
    setFreebuffDeviceSigner(signer)
    setFreebuffCatalog(CATALOG)
    fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ error: 'freebuff_device_key_unknown' }, { status: 401 }),
      )
      .mockResolvedValueOnce(Response.json({ status: 'none' }))
    await callFreebuffSession('GET', 'tok', { instanceId: 'i1' }).catch(() => {})
    await signer.settled()
    await callFreebuffSession('GET', 'tok', { instanceId: 'i1' })
    expect(
      fetchSpy.mock.calls.map((c: unknown[]) =>
        headersOf(c).get(FREEBUFF_DEVICE_KEY_HEADER),
      ),
    ).toEqual(['dev-key-1', 'dev-key-2'])
  })
})

describe('the catalog GET', () => {
  test('is not signed, and registers nothing, before the server has spoken the catalog', async () => {
    const device = installSigner()
    let sent: Headers | undefined
    await fetchFreebuffModelCatalog('tok', {
      baseUrl: 'https://api.test',
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        sent = new Headers(init?.headers)
        return new Response('not found', { status: 404 })
      }) as unknown as typeof fetch,
    })
    expect(sent!.get(FREEBUFF_DEVICE_SIGNATURE_HEADER)).toBeNull()
    expect(device.registrations).toBe(0)
  })

  test('is signed (with no fetch id) once a key is registered', async () => {
    const device = installSigner()
    setFreebuffCatalog(CATALOG)
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      Response.json({ status: 'none' })) as unknown as typeof fetch)
    await callFreebuffSession('GET', 'tok', { instanceId: 'i1' })
    let sent: { url: string; headers: Headers } | undefined
    const result = await fetchFreebuffModelCatalog('tok', {
      baseUrl: 'https://api.test',
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        sent = { url: String(url), headers: new Headers(init?.headers) }
        return Response.json(CATALOG)
      }) as unknown as typeof fetch,
    })
    expect(result.kind).toBe('ok')
    expect(sent!.headers.get(FREEBUFF_CATALOG_FETCH_HEADER)).toBeNull()
    expect(
      await verifies(device.record!, sent!.headers, { method: 'GET', url: sent!.url }),
    ).toBe(true)
  })
})

describe('completions (the SDK requestHeaders hook)', () => {
  test('catalog mode: fetch id plus a signature over the exact body', async () => {
    const device = installSigner()
    setFreebuffCatalog(CATALOG)
    const request = {
      method: 'POST',
      url: 'https://api.test/api/v1/chat/completions',
      body: '{"model":"fbm1.m-flash-h1","stream":true}',
    }
    const headers = new Headers(await freebuffCatalogCompletionHeaders('tok', request))
    expect(headers.get(FREEBUFF_CATALOG_FETCH_HEADER)).toBe('fetch-1')
    expect(
      await verifies(device.record!, headers, { ...request, fetchId: 'fetch-1' }),
    ).toBe(true)
  })

  test('fallback mode adds nothing', async () => {
    const device = installSigner()
    expect(
      await freebuffCatalogCompletionHeaders('tok', {
        method: 'POST',
        url: 'https://api.test/api/v1/chat/completions',
        body: '{}',
      }),
    ).toEqual({})
    expect(device.registrations).toBe(0)
  })
})

describe('device-key.json', () => {
  test('is written owner-only, reloads the same key, and keeps registrations', async () => {
    const file = freebuffDeviceKeyPath(configDir)
    const registrations: string[] = []
    const make = () =>
      new FreebuffDeviceSigner({
        store: createFreebuffDeviceKeyFileStore(file),
        client: 'cli',
        fetch: (async (url: unknown) => {
          registrations.push(String(url))
          return Response.json({ keyId: 'dev-key-file' })
        }) as unknown as typeof fetch,
      })
    const account = { token: 'tok', accountId: 'u1', apiHost: 'https://api.test' }
    const first = make()
    await first.headers(account, { method: 'GET', url: 'https://api.test/x' })
    await first.settled()
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    }
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved.registrations).toEqual({ 'https://api.test user:u1': 'dev-key-file' })

    const second = make()
    const headers = new Headers(
      await second.headers(account, { method: 'GET', url: 'https://api.test/x' }),
    )
    expect(headers.get(FREEBUFF_DEVICE_KEY_HEADER)).toBe('dev-key-file')
    expect(registrations).toHaveLength(1)
    expect(
      await verifies(saved, headers, { method: 'GET', url: 'https://api.test/x' }),
    ).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).publicKey).toBe(saved.publicKey)
  })

  test('lives in the configured config dir', () => {
    expect(freebuffDeviceKeyPath('/tmp/profile-a')).toBe('/tmp/profile-a/device-key.json')
  })
})
