import { afterEach, describe, expect, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ByokCredentialError,
  createByokConnectionStore,
  createBunByokConnectionStore,
  createBunByokMetadataStore,
  normalizeByokBaseUrl,
  byokModelLimits,
  byokCompletionUrl,
  BYOK_DEFAULT_CONTEXT_WINDOW,
  BYOK_DISCOVERED_CONTEXT_WINDOW_CAP,
  BYOK_UNKNOWN_REMOTE_CONTEXT_WINDOW,
  clearByokContextWindowCache,
  contextWindowFromModelList,
  withEffectiveByokLimits,
  type ResolvedByokConnection,
  type ByokConnection,
  type ByokSecretStore,
} from './byok'
import {
  CHATGPT_CONTEXT_WINDOW,
  CHATGPT_DEFAULT_MODELS,
  CHATGPT_SIGN_IN_AGAIN,
  type ChatGptTokens,
} from './chatgpt'
import { fakeChatGptJwt } from './__tests__/fixtures/chatgpt-jwt'

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
  test('adding models reuses the endpoint and key with independent limits and lifetimes', async () => {
    const { store, rows } = fixture()
    const original = await store.create({
      ...input,
      contextWindow: 64000,
      maxOutputTokens: 8192,
    })
    const added = await store.addModel({
      ...original,
      model: {
        name: 'Second model',
        model: 'second-model',
        contextWindow: 128000,
        maxOutputTokens: 16000,
      },
    })
    expect(added).toMatchObject({
      provider: original.provider,
      baseUrl: original.baseUrl,
      model: 'second-model',
      contextWindow: 128000,
      maxOutputTokens: 16000,
      revision: 1,
    })
    expect(added.id).not.toBe(original.id)
    expect(added.credentialRef).not.toBe(original.credentialRef)
    expect(await store.resolve(original)).toMatchObject({
      revision: 1,
      contextWindow: 64000,
    })
    expect((await store.resolve(added)).apiKey).toBe(input.apiKey)
    expect(JSON.stringify(rows())).not.toContain(input.apiKey)
    const changed = await store.update({
      ...original,
      patch: { apiKey: 'replacement' },
    })
    expect((await store.resolve(added)).apiKey).toBe(input.apiKey)
    await expect(
      store.addModel({ ...original, model: { name: 'Stale', model: 'stale' } }),
    ).rejects.toThrow('changed')
    await store.remove(changed)
    expect((await store.resolve(added)).apiKey).toBe(input.apiKey)
    await expect(
      store.addModel({
        ...changed,
        model: { name: 'Missing', model: 'missing' },
      }),
    ).rejects.toThrow('removed')
    await store.remove(added)
    expect(await store.list()).toEqual([])
  })
  test('adding an environment-backed model preserves the reference and starts with its own default limits', async () => {
    const { store, secret } = fixture()
    const original = await store.create({
      ...input,
      apiKey: undefined,
      credentialRef: 'env:PROVIDER_KEY',
      contextWindow: 64000,
    })
    const added = await store.addModel({
      ...original,
      model: { name: 'Second', model: 'second' },
    })
    expect(added.credentialRef).toBe('env:PROVIDER_KEY')
    expect(added.contextWindow).toBe(BYOK_DEFAULT_CONTEXT_WINDOW)
    expect(secret.values.size).toBe(0)
    secret.values.set('env:PROVIDER_KEY', 'environment-canary')
    await store.remove(original)
    expect((await store.resolve(added)).apiKey).toBe('environment-canary')
  })
  test('a failed model save cleans up its copied key and keeps the source usable', async () => {
    let rows: ByokConnection[] = []
    let failSave = false
    const secret = secrets()
    const store = createByokConnectionStore({
      secretStore: secret.store,
      metadataStore: {
        get: async () => rows,
        set: async (value) => {
          if (failSave) throw new Error('disk full')
          rows = value
        },
      },
    })
    const original = await store.create(input)
    failSave = true
    await expect(
      store.addModel({
        ...original,
        model: { name: 'Second', model: 'second' },
      }),
    ).rejects.toThrow('disk full')
    expect(await store.list()).toEqual([original])
    expect([...secret.values.keys()]).toEqual([original.credentialRef])
    expect((await store.resolve(original)).apiKey).toBe(input.apiKey)
  })
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
  // A local OmniRoute-style proxy (user writeup, 2026-09-30): the check used
  // to say only "reachable" or "failed (HTTP n)", so a wrong model id, a base
  // URL without /v1 and a stopped proxy all surfaced later, as run failures.
  describe('endpoint check diagnostics', () => {
    const proxy = {
      ...input,
      baseUrl: 'http://localhost:20128/v1',
      model: 'mistral/codestral-latest',
    }
    const listing = (ids: string[]) =>
      (async () =>
        Response.json({
          object: 'list',
          data: ids.map((id) => ({ id, object: 'model' })),
        })) as unknown as typeof fetch

    test('reports the status and whether the model is listed', async () => {
      const { store } = fixture(
        listing(['mistral/codestral-latest', 'openai/gpt-4o-mini']),
      )
      const added = await store.create(proxy)
      expect(await store.validate(added)).toMatchObject({
        ok: true,
        statusCode: 200,
        modelListed: true,
      })
    })

    test('an unlisted model lists what the endpoint offers, filtered, never the key', async () => {
      const { store } = fixture(
        listing([
          'codestral-latest',
          'openai/gpt-4o-mini',
          `leak-${input.apiKey}`,
          'bad id with spaces',
          'x'.repeat(201),
        ]),
      )
      const added = await store.create(proxy)
      const result = await store.validate(added)
      expect(result).toMatchObject({
        ok: true,
        modelListed: false,
        availableModels: ['codestral-latest', 'openai/gpt-4o-mini'],
      })
      expect(JSON.stringify(result)).not.toContain(input.apiKey)
    })

    test('a listing without ids makes no claim about the model', async () => {
      const { store } = fixture(
        (async () => new Response('ok')) as unknown as typeof fetch,
      )
      const added = await store.create(proxy)
      const result = await store.validate(added)
      expect(result.ok).toBe(true)
      expect('modelListed' in result).toBe(false)
    })

    test('a 404 at a base URL without /v1 suggests adding it', async () => {
      const { store } = fixture(
        (async () =>
          new Response('Not found', { status: 404 })) as unknown as typeof fetch,
      )
      const added = await store.create({
        ...proxy,
        baseUrl: 'http://localhost:20128',
      })
      const result = await store.validate(added)
      expect(result).toMatchObject({ ok: false, statusCode: 404 })
      expect(result.ok ? '' : result.message).toBe(
        'Provider connection check failed (HTTP 404 from http://localhost:20128/models). OpenAI-compatible base URLs usually end in /v1; try http://localhost:20128/v1.',
      )
    })

    test('a web page at /models is a wrong base URL, not a reachable endpoint', async () => {
      const { store } = fixture(
        (async () =>
          new Response('<!doctype html><html>dashboard</html>', {
            headers: { 'content-type': 'text/html' },
          })) as unknown as typeof fetch,
      )
      const added = await store.create({
        ...proxy,
        baseUrl: 'http://localhost:20128',
      })
      const result = await store.validate(added)
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.message).toContain(
        'answered with a web page, not an OpenAI-compatible model list (HTTP 200). OpenAI-compatible base URLs usually end in /v1; try http://localhost:20128/v1.',
      )
    })

    test('a stopped proxy is named as connection refused at its origin', async () => {
      const server = Bun.serve({ port: 0, fetch: () => new Response('') })
      const port = server.port
      server.stop(true)
      const { store } = fixture(globalThis.fetch)
      const added = await store.create({
        ...proxy,
        baseUrl: `http://127.0.0.1:${port}/v1`,
      })
      const result = await store.validate(added)
      expect(result.ok ? '' : result.message).toBe(
        `Nothing is accepting connections at http://127.0.0.1:${port} (connection refused). Start the provider or proxy, or check the host and port.`,
      )
    })
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
  // A user writeup (2026-09-30): OmniRoute on http://localhost:20128/v1 with
  // OMNIROUTE_API_KEY. Freebuff was started before the variable existed, and
  // every command answered "BYOK credential is unavailable or invalid" — the
  // `add` even threw after saving, so a retry said "already exists".
  describe('environment credential diagnostics', () => {
    const omniroute = {
      name: 'omniroute',
      provider: 'openai-compatible' as const,
      model: 'mistral/codestral-latest',
      baseUrl: 'http://localhost:20128/v1',
      credentialRef: 'env:OMNIROUTE_API_KEY',
    }
    const syntheticKey = 'synthetic-omniroute-key-canary'

    test('an unset variable fails validation (not the command) and names the variable', async () => {
      const directory = await temporaryDirectory()
      const environment: Record<string, string | undefined> = {}
      let fetched = 0
      const store = createBunByokConnectionStore({
        directory,
        environment,
        fetch: (async () => {
          fetched++
          return new Response('{}')
        }) as unknown as typeof fetch,
      })
      const added = await store.create(omniroute)
      const result = await store.validate(added)
      expect(result).toMatchObject({
        ok: false,
        connection: { id: added.id, name: 'omniroute' },
        message:
          'OMNIROUTE_API_KEY is not set in this Freebuff process. Set it and restart Freebuff from that terminal.',
      })
      expect(fetched).toBe(0)
      // A run start sees the same precise reason, as a typed credential error.
      const failure = await store.resolve(added).catch((error) => error)
      expect(failure).toBeInstanceOf(ByokCredentialError)
      expect(failure.message).toContain('OMNIROUTE_API_KEY is not set')
      environment.OMNIROUTE_API_KEY = '   '
      expect((await store.validate(added)).ok).toBe(false)
    })

    test('a set variable the provider refuses says 401, names the variable, never the key', async () => {
      const directory = await temporaryDirectory()
      const store = createBunByokConnectionStore({
        directory,
        environment: { OMNIROUTE_API_KEY: syntheticKey },
        fetch: (async () =>
          new Response(`bad key ${syntheticKey}`, {
            status: 401,
          })) as unknown as typeof fetch,
      })
      const added = await store.create(omniroute)
      const result = await store.validate(added)
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.message).toBe(
        'The provider rejected the key in OMNIROUTE_API_KEY (HTTP 401). OMNIROUTE_API_KEY is set in this Freebuff process; check that it holds the key this endpoint expects, then restart Freebuff from that terminal.',
      )
      expect(JSON.stringify(result)).not.toContain(syntheticKey)
    })

    test('a CRLF .env value is the key, not an invalid credential', async () => {
      const directory = await temporaryDirectory()
      const store = createBunByokConnectionStore({
        directory,
        environment: { OMNIROUTE_API_KEY: `${syntheticKey}\r` },
      })
      const added = await store.create(omniroute)
      expect((await store.resolve(added)).apiKey).toBe(syntheticKey)
    })

    test('a line break inside the value is refused by name', async () => {
      const directory = await temporaryDirectory()
      const store = createBunByokConnectionStore({
        directory,
        environment: { OMNIROUTE_API_KEY: `${syntheticKey}\nsecond-line` },
      })
      const added = await store.create(omniroute)
      const result = await store.validate(added)
      expect(result.ok ? '' : result.message).toContain(
        'OMNIROUTE_API_KEY contains a line break',
      )
      expect(JSON.stringify(result)).not.toContain(syntheticKey)
    })

    test('a removed connection still fails loudly rather than as a check', async () => {
      const directory = await temporaryDirectory()
      const store = createBunByokConnectionStore({ directory, environment: {} })
      const added = await store.create(omniroute)
      await store.remove(added)
      await expect(store.validate(added)).rejects.toThrow('removed')
    })
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

describe('effective BYOK limits for a run', () => {
  afterEach(() => clearByokContextWindowCache())
  function resolved(
    overrides: Partial<ByokConnection> = {},
  ): ResolvedByokConnection {
    const connection = {
      id: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      name: 'Fixture',
      provider: 'openai-compatible' as const,
      baseUrl: 'https://llm.example.com/v1',
      model: 'acme/coder',
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      credentialRef: 'connection:11111111-1111-4111-8111-111111111111:1',
      createdAt: '2026-09-27T00:00:00.000Z',
      updatedAt: '2026-09-27T00:00:00.000Z',
      ...overrides,
    }
    const assertCurrent = async () => {}
    Object.defineProperty(connection, 'apiKey', {
      value: 'listing-secret',
      enumerable: false,
    })
    Object.defineProperty(connection, 'assertCurrent', {
      value: assertCurrent,
      enumerable: false,
    })
    return Object.freeze(connection) as ResolvedByokConnection
  }
  function listing(body: unknown, status = 200) {
    const calls: Array<{ url: string; auth: string | null }> = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({
        url: String(input),
        auth: new Headers(init?.headers).get('authorization'),
      })
      return Response.json(body, { status })
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
  }

  test('limits a user typed are kept and never trigger a lookup', async () => {
    const { calls, fetchImpl } = listing({ data: [] })
    const typed = resolved({ contextWindow: 102_400, maxOutputTokens: 8_192 })
    expect(await withEffectiveByokLimits(typed, { fetch: fetchImpl })).toBe(typed)
    // The window alone at the default still counts as a choice when the output limit moved.
    const tuned = resolved({ maxOutputTokens: 2_048 })
    expect(await withEffectiveByokLimits(tuned, { fetch: fetchImpl })).toBe(tuned)
    expect(calls).toEqual([])
  })

  test('an untouched default takes the window the provider lists, keeping the credential hidden', async () => {
    const { calls, fetchImpl } = listing({
      data: [{ id: 'acme/coder', max_model_len: 65_536 }],
    })
    const connection = resolved()
    const effective = await withEffectiveByokLimits(connection, { fetch: fetchImpl })
    expect(effective).toMatchObject({ contextWindow: 65_536, maxOutputTokens: 4_096 })
    expect(effective.apiKey).toBe('listing-secret')
    expect(effective.assertCurrent).toBe(connection.assertCurrent)
    expect(Object.keys(effective)).not.toContain('apiKey')
    expect(JSON.stringify(effective)).not.toContain('listing-secret')
    expect(Object.isFrozen(effective)).toBe(true)
    expect(byokModelLimits(effective).maxContextLength).toBe(
      Math.floor((65_536 - 4_096) * 0.9),
    )
    expect(calls).toEqual([
      { url: 'https://llm.example.com/v1/models', auth: 'Bearer listing-secret' },
    ])
    // One listing per endpoint and model, not one per turn.
    await withEffectiveByokLimits(connection, { fetch: fetchImpl })
    expect(calls).toHaveLength(1)
  })

  test('OpenRouter is asked without the key, and a huge window is capped', async () => {
    const { calls, fetchImpl } = listing({
      data: [
        { id: 'vendor/giant', context_length: 1_048_576 },
        { id: 'vendor/small', context_length: 40_960 },
      ],
    })
    const giant = await withEffectiveByokLimits(
      resolved({ provider: 'openrouter', baseUrl: undefined, model: 'vendor/giant' }),
      { fetch: fetchImpl },
    )
    expect(giant.contextWindow).toBe(BYOK_DISCOVERED_CONTEXT_WINDOW_CAP)
    const free = await withEffectiveByokLimits(
      resolved({ provider: 'openrouter', baseUrl: undefined, model: 'vendor/small:free' }),
      { fetch: fetchImpl },
    )
    expect(free.contextWindow).toBe(40_960)
    expect(calls[0]).toEqual({ url: 'https://openrouter.ai/api/v1/models', auth: null })
  })

  test('an unlisted remote model gets 128k; a local server keeps its configured default', async () => {
    const miss = listing({ data: [{ id: 'someone/else', context_length: 8_192 }] })
    expect(
      (await withEffectiveByokLimits(resolved(), { fetch: miss.fetchImpl })).contextWindow,
    ).toBe(BYOK_UNKNOWN_REMOTE_CONTEXT_WINDOW)
    const local = resolved({ baseUrl: 'http://127.0.0.1:1234/v1' })
    expect(await withEffectiveByokLimits(local, { fetch: miss.fetchImpl })).toBe(local)
    expect(local.contextWindow).toBe(BYOK_DEFAULT_CONTEXT_WINDOW)
  })

  test('a failing or unreachable listing never fails the run', async () => {
    const failed = listing({ error: 'nope' }, 500)
    expect(
      (await withEffectiveByokLimits(resolved(), { fetch: failed.fetchImpl })).contextWindow,
    ).toBe(BYOK_UNKNOWN_REMOTE_CONTEXT_WINDOW)
    clearByokContextWindowCache()
    const offline = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect(
      (await withEffectiveByokLimits(resolved(), { fetch: offline })).contextWindow,
    ).toBe(BYOK_UNKNOWN_REMOTE_CONTEXT_WINDOW)
  })

  test('reads the window fields common OpenAI-compatible listings use', () => {
    expect(contextWindowFromModelList({ data: [{ id: 'm', context_window: 131_072 }] }, 'm')).toBe(131_072)
    expect(contextWindowFromModelList([{ id: 'm', loaded_context_length: '16384' }], 'm')).toBe(16_384)
    expect(
      contextWindowFromModelList(
        { data: [{ id: 'x', canonical_slug: 'm', top_provider: { context_length: 200_000 } }] },
        'm',
      ),
    ).toBe(200_000)
    expect(contextWindowFromModelList({ data: [{ id: 'm' }] }, 'm')).toBeUndefined()
    expect(contextWindowFromModelList('not a listing', 'm')).toBeUndefined()
  })
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

describe('ChatGPT sign-in connections', () => {
  const tokens = (overrides: Partial<ChatGptTokens> = {}): ChatGptTokens => ({
    accessToken: 'access-canary',
    refreshToken: 'refresh-canary',
    expiresAt: Date.now() + 3_600_000,
    accountId: 'acct_fixture',
    ...overrides,
  })

  test('a sign-in saves the default models on one shared credential, kept out of metadata', async () => {
    const { store, secret, rows } = fixture()
    const created = await store.saveChatGptSignIn(tokens())
    expect(created.map((item) => item.model)).toEqual(
      CHATGPT_DEFAULT_MODELS.map((item) => item.model),
    )
    const references = new Set(rows().map((item) => item.credentialRef))
    expect(references.size).toBe(1)
    expect([...references][0]).toMatch(/^chatgpt:/)
    expect(secret.values.size).toBe(1)
    expect(JSON.stringify(rows())).not.toContain('canary')
    expect(rows().every((item) => item.provider === 'chatgpt')).toBe(true)

    // Signing in again replaces the shared tokens and adds nothing.
    const again = await store.saveChatGptSignIn(tokens({ accessToken: 'access-2' }))
    expect(again.map((item) => item.id)).toEqual(created.map((item) => item.id))
    expect(rows()).toHaveLength(created.length)
    expect([...secret.values.values()][0]).toContain('access-2')
  })

  test('a sign-in saves the plan’s models, and signing in again adds only new ones', async () => {
    const { store, rows } = fixture()
    await store.saveChatGptSignIn(tokens(), [
      { model: 'gpt-6.1-sol', name: 'GPT-6.1-Sol (ChatGPT)', contextWindow: 400_000 },
      { model: 'gpt-6-luna', name: 'GPT-6-Luna (ChatGPT)' },
    ])
    expect(rows().map((item) => [item.model, item.contextWindow])).toEqual([
      ['gpt-6.1-sol', 400_000],
      ['gpt-6-luna', CHATGPT_CONTEXT_WINDOW],
    ])
    const all = await store.saveChatGptSignIn(tokens({ accessToken: 'access-2' }), [
      { model: 'gpt-6.1-sol', name: 'GPT-6.1-Sol (ChatGPT)' },
      { model: 'gpt-7', name: 'GPT-7 (ChatGPT)' },
    ])
    expect(all.map((item) => item.model)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-luna',
      'gpt-7',
    ])
    expect(new Set(rows().map((item) => item.credentialRef)).size).toBe(1)
  })

  test('models share the sign-in, and removing any of them removes it whole', async () => {
    const { store, secret, rows } = fixture()
    const other = await store.create(input)
    const [first, second] = await store.saveChatGptSignIn(tokens())
    const added = await store.addModel({
      id: first!.id,
      revision: first!.revision,
      model: { name: 'Codex mini', model: 'gpt-codex-mini' },
    })
    expect(added.credentialRef).toBe(first!.credentialRef)
    expect(added.contextWindow).toBe(CHATGPT_CONTEXT_WINDOW)
    expect(secret.values.size).toBe(2)
    await store.remove({ id: second!.id, revision: second!.revision })
    // Every ChatGPT model went, with the sign-in; the other provider stayed.
    expect(rows().map((item) => item.id)).toEqual([other.id])
    expect([...secret.values.keys()]).toEqual([other.credentialRef])
    await expect(
      store.resolve({ id: first!.id, revision: first!.revision }),
    ).rejects.toThrow('removed')
  })

  test('only the sign-in flow creates one, and its sign-in cannot be edited', async () => {
    const { store } = fixture()
    await expect(
      store.create({ name: 'x', provider: 'chatgpt', model: 'gpt-6-sol', apiKey: 'k' }),
    ).rejects.toThrow('Sign in with ChatGPT')
    const [first] = await store.saveChatGptSignIn(tokens())
    await expect(
      store.update({ id: first!.id, revision: 1, patch: { apiKey: 'k' } }),
    ).rejects.toThrow('Sign in with ChatGPT again')
    const renamed = await store.update({
      id: first!.id,
      revision: 1,
      patch: { name: 'Work plan', model: 'gpt-6-astra' },
    })
    expect(renamed).toMatchObject({ name: 'Work plan', model: 'gpt-6-astra', revision: 2 })
    expect(renamed.credentialRef).toBe(first!.credentialRef)
  })

  test('resolving refreshes an expiring sign-in once, saves it, and hides the token', async () => {
    let refreshes = 0
    const fetchImpl = (async (url: string) => {
      expect(url).toBe('https://auth.openai.com/oauth/token')
      refreshes++
      return Response.json({
        access_token: fakeChatGptJwt(),
        refresh_token: 'refresh-rotated',
      })
    }) as unknown as typeof fetch
    const { store, secret } = fixture(fetchImpl)
    const [first] = await store.saveChatGptSignIn(
      tokens({ expiresAt: Date.now() + 1_000 }),
    )
    const resolved = await store.resolve({ id: first!.id, revision: 1 })
    expect(refreshes).toBe(1)
    expect([...secret.values.values()][0]).toContain('refresh-rotated')
    expect(await resolved.accessToken!()).toBe(resolved.apiKey)
    expect(refreshes).toBe(1)
    expect(JSON.stringify(resolved)).not.toContain(resolved.apiKey)
    expect(Object.keys(resolved)).not.toContain('accessToken')
    // Sibling models reuse the rotated sign-in instead of refreshing again.
    const others = (await store.list()).filter((item) => item.id !== first!.id)
    await store.resolve({ id: others[0]!.id, revision: 1 })
    expect(refreshes).toBe(1)
  })

  test('a sign-in that can no longer refresh fails with the sign-in-again message', async () => {
    const fetchImpl = (async () =>
      Response.json({ error: 'refresh_token_reused' }, { status: 401 })) as unknown as typeof fetch
    const { store } = fixture(fetchImpl)
    const [first] = await store.saveChatGptSignIn(tokens({ expiresAt: 0 }))
    await expect(store.resolve({ id: first!.id, revision: 1 })).rejects.toThrow(
      CHATGPT_SIGN_IN_AGAIN,
    )
    expect(await store.validate({ id: first!.id, revision: 1 })).toMatchObject({
      ok: false,
      message: CHATGPT_SIGN_IN_AGAIN,
    })
  })

  test('ChatGPT credentials cannot be borrowed by another provider', async () => {
    const { store, rows } = fixture()
    await store.saveChatGptSignIn(tokens())
    const shared = rows()[0]!.credentialRef
    const metadata = createBunByokMetadataStore({ directory: await temporaryDirectory() })
    await expect(
      metadata.set([
        { ...rows()[0]!, provider: 'openai-compatible', baseUrl: 'https://example.com/v1', credentialRef: shared },
      ]),
    ).rejects.toThrow('different connection')
  })
})
