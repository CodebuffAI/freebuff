import { afterEach, describe, expect, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createByokConnectionStore,
  createBunByokConnectionStore,
  createBunByokMetadataStore,
  normalizeByokBaseUrl,
  byokModelLimits,
  byokCompletionUrl,
  type ByokConnection,
  type ByokSecretStore,
} from './byok'

const directories: string[] = []
afterEach(async () => {
  for (const dir of directories.splice(0))
    await fs.rm(dir, { recursive: true, force: true })
})
const input = {
  name: 'Fixture',
  provider: 'openai-compatible' as const,
  model: 'fixture-model',
  baseUrl: 'http://127.0.0.1:9999/v1',
  apiKey: 'canary-secret',
}
function secrets() {
  const values = new Map<string, string>()
  const store: ByokSecretStore = {
    get: async (ref) => values.get(ref),
    set: async (ref, value) => {
      values.set(ref, value)
    },
    delete: async (ref) => {
      values.delete(ref)
    },
  }
  return { values, store }
}
function fixture(fetchImpl?: typeof fetch) {
  let rows: ByokConnection[] = []
  const secret = secrets()
  const store = createByokConnectionStore({
    secretStore: secret.store,
    fetch: fetchImpl,
    metadataStore: {
      get: async () => structuredClone(rows),
      set: async (value) => {
        rows = structuredClone(value)
      },
    },
  })
  return { store, secret, rows: () => rows }
}
async function temporaryDirectory() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'byok-store-'))
  directories.push(dir)
  return dir
}
describe('BYOK endpoint boundary', () => {
  test('retains API base paths and normalizes trailing slash', () => {
    expect(byokCompletionUrl({ provider: 'openrouter' })).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    )
    expect(byokCompletionUrl(input)).toBe(
      'http://127.0.0.1:9999/v1/chat/completions',
    )
    expect(
      normalizeByokBaseUrl('openai-compatible', 'https://example.com/v1/'),
    ).toBe('https://example.com/v1')
  })
  test.each([
    'http://example.com/v1',
    'file:///tmp/a',
    'ftp://example.com',
    'https://user:pass@example.com',
    'https://example.com?api_key=secret',
    'https://example.com/#key',
    'not a URL',
  ])('refuses unsafe endpoint %s', (url) => {
    expect(() => normalizeByokBaseUrl('openai-compatible', url)).toThrow()
  })
})
describe('BYOK connection lifecycle', () => {
  test('keeps keys out of metadata and serialized resolved connections', async () => {
    const { store, rows } = fixture()
    const added = await store.create(input)
    expect(JSON.stringify(rows())).not.toContain(input.apiKey)
    const resolved = await store.resolve(added)
    expect(resolved.apiKey).toBe(input.apiKey)
    expect(JSON.stringify(resolved)).not.toContain(input.apiKey)
    expect(Object.isFrozen(resolved)).toBe(true)
  })
  test('serializes concurrent mutations and invalidates stale revisions', async () => {
    const { store } = fixture()
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.create({ ...input, name: `Connection ${i}` }),
      ),
    )
    expect(await store.list()).toHaveLength(12)
    const initial = created[0]!
    const changed = await store.update({
      ...initial,
      patch: { apiKey: 'replacement-secret' },
    })
    expect(changed.revision).toBe(2)
    await expect(store.resolve(initial)).rejects.toThrow('changed')
    expect((await store.resolve(changed)).apiKey).toBe('replacement-secret')
    await expect(store.remove(initial)).rejects.toThrow('changed')
    await store.remove(changed)
    await expect(store.resolve(changed)).rejects.toThrow('removed')
  })
  test('requires explicit credential rebinding for a new origin or provider', async () => {
    const { store } = fixture()
    const added = await store.create(input)
    await expect(
      store.update({
        ...added,
        patch: { baseUrl: 'https://different.example/v1' },
      }),
    ).rejects.toThrow('supplying the credential')
    expect((await store.resolve(added)).apiKey).toBe(input.apiKey)
  })
  test('rejects foreign credential references and ambiguous credential sources', async () => {
    const { store } = fixture()
    await expect(
      store.create({
        ...input,
        apiKey: undefined,
        credentialRef: 'connection:other:1',
      }),
    ).rejects.toThrow()
    await expect(
      store.create({ ...input, credentialRef: 'env:KEY' }),
    ).rejects.toThrow()
  })
  test('validation does not follow redirects or expose provider error bodies', async () => {
    let redirect: RequestRedirect | undefined
    const { store } = fixture((async (_url, options) => {
      redirect = options?.redirect
      return new Response(input.apiKey, { status: 401 })
    }) as typeof fetch)
    const added = await store.create(input)
    const result = await store.validate(added)
    expect(redirect).toBe('error')
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(input.apiKey)
  })
  test('validation strips credential-reflecting transport errors', async () => {
    const { store } = fixture((async () => {
      throw new Error(input.apiKey)
    }) as unknown as typeof fetch)
    const added = await store.create(input)
    expect(JSON.stringify(await store.validate(added))).not.toContain(
      input.apiKey,
    )
  })
  test('rolls back stored credential if metadata write fails', async () => {
    const secret = secrets()
    const store = createByokConnectionStore({
      secretStore: secret.store,
      metadataStore: {
        get: async () => [],
        set: async () => {
          throw new Error('disk full')
        },
      },
    })
    await expect(store.create(input)).rejects.toThrow('disk full')
    expect(secret.values.size).toBe(0)
  })
})
describe('shared persistent BYOK store', () => {
  test('independent Desktop and CLI instances preserve concurrent writes', async () => {
    const directory = await temporaryDirectory()
    const secretStore = secrets().store
    const desktop = createBunByokConnectionStore({ directory, secretStore })
    const cli = createBunByokConnectionStore({ directory, secretStore })
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        (i % 2 ? desktop : cli).create({ ...input, name: `Connection ${i}` }),
      ),
    )
    expect(await desktop.list()).toHaveLength(16)
    const [one] = await cli.list()
    expect((await desktop.resolve(one!)).apiKey).toBe(input.apiKey)
    const file = await fs.readFile(
      path.join(directory, 'connections.json'),
      'utf8',
    )
    expect(file).not.toContain(input.apiKey)
    if (process.platform !== 'win32')
      expect(
        (await fs.stat(path.join(directory, 'connections.json'))).mode & 0o777,
      ).toBe(0o600)
  })
  test('explicit environment credentials need no native store and are never changed', async () => {
    const directory = await temporaryDirectory()
    const environment = { FIXTURE_KEY: input.apiKey }
    const store = createBunByokConnectionStore({ directory, environment })
    const added = await store.create({
      ...input,
      apiKey: undefined,
      credentialRef: 'env:FIXTURE_KEY',
    })
    expect((await store.resolve(added)).apiKey).toBe(input.apiKey)
    await store.remove(added)
    expect(environment.FIXTURE_KEY).toBe(input.apiKey)
    expect(await store.list()).toEqual([])
  })
  test('fails closed on corrupt or secret-bearing metadata', async () => {
    const directory = await temporaryDirectory()
    const metadata = createBunByokMetadataStore({ directory })
    await fs.writeFile(path.join(directory, 'connections.json'), '{broken')
    await expect(metadata.get()).rejects.toThrow('metadata')
    await fs.writeFile(
      path.join(directory, 'connections.json'),
      JSON.stringify([{ apiKey: input.apiKey }]),
    )
    await expect(metadata.get()).rejects.toThrow('metadata')
  })

  test('calls Bun credential storage with its positional set arguments', async () => {
    const directory = await temporaryDirectory()
    const nativeSecrets = Bun.secrets
    const values = new Map<string, string>()
    const calls: Array<[string, string, string]> = []
    ;(Bun as unknown as { secrets: unknown }).secrets = {
      get: async ({ name }: { service: string; name: string }) =>
        values.get(name) ?? null,
      set: async (service: string, name: string, value: string) => {
        if (
          typeof service !== 'string' ||
          typeof name !== 'string' ||
          typeof value !== 'string'
        )
          throw new Error('Bun.secrets.set requires service, name, and value')
        calls.push([service, name, value])
        values.set(name, value)
      },
      delete: async ({ name }: { service: string; name: string }) =>
        values.delete(name),
    }
    try {
      const store = createBunByokConnectionStore({ directory })
      const added = await store.create(input)
      expect(calls).toEqual([
        [
          'com.freebuff.byok.v1',
          added.credentialRef,
          input.apiKey,
        ],
      ])
      expect((await store.resolve(added)).apiKey).toBe(input.apiKey)
      await store.remove(added)
    } finally {
      ;(Bun as unknown as { secrets: unknown }).secrets = nativeSecrets
    }
  })
})

test('custom model limits reserve output and reject impossible capacities', () => {
  expect(
    byokModelLimits({ contextWindow: 8192, maxOutputTokens: 2048 }),
  ).toEqual({
    contextWindow: 8192,
    maxOutputTokens: 2048,
    maxContextLength: 5529,
  })
  expect(() =>
    byokModelLimits({ contextWindow: 8192, maxOutputTokens: 8192 }),
  ).toThrow()
  expect(() => byokModelLimits({ contextWindow: NaN })).toThrow()
})

test('failed key rotation leaves the old revision recoverable', async () => {
  let rows: ByokConnection[] = []
  const secret = secrets()
  let failCleanup = true
  const store = createByokConnectionStore({
    metadataStore: {
      get: async () => rows,
      set: async (value) => {
        rows = value
      },
    },
    secretStore: {
      ...secret.store,
      delete: async (ref) => {
        if (failCleanup && ref.endsWith(':1')) throw new Error('locked')
        await secret.store.delete(ref)
      },
    },
  })
  const first = await store.create(input)
  const resolved = await store.resolve(first)
  await expect(
    store.update({ ...first, patch: { apiKey: 'new-key' } }),
  ).rejects.toThrow('unchanged')
  expect((await store.resolve(first)).apiKey).toBe(input.apiKey)
  await resolved.assertCurrent?.()
  failCleanup = false
  const updated = await store.update({ ...first, patch: { apiKey: 'new-key' } })
  expect((await store.resolve(updated)).apiKey).toBe('new-key')
  await expect(resolved.assertCurrent!()).rejects.toThrow('changed')
})
