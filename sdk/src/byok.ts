/** Machine-local connection metadata, separate from OS-protected credentials. */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod/v4'
import { getSystemProcessEnv } from './env'

export const BYOK_SECRET_SERVICE = 'com.freebuff.byok.v1'
const envReference = /^env:[A-Za-z_][A-Za-z0-9_]*$/
const ownedReference = /^connection:[a-f0-9-]+:[1-9][0-9]*$/
const text = z.string().trim().min(1).max(256)
const connectionSchema = z
  .object({
    id: z.uuid(),
    revision: z.number().int().positive(),
    name: text,
    provider: z.enum(['openrouter', 'openai-compatible']),
    model: text,
    baseUrl: z.string().max(2048).optional(),
    contextWindow: z.number().int().min(4096).max(2_000_000).optional(),
    maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
    credentialRef: z
      .string()
      .refine(
        (value) => envReference.test(value) || ownedReference.test(value),
      ),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
export type ByokConnection = z.infer<typeof connectionSchema>
export type ByokProvider = ByokConnection['provider']
/** Runtime-only. The built-in resolver makes apiKey non-enumerable. */
export type ResolvedByokConnection = ByokConnection & {
  apiKey: string
  /** Recheck revocation before every provider request; never serialized. */
  assertCurrent?: () => Promise<void>
}
export type ByokSecretStore = {
  get(reference: string): Promise<string | undefined>
  set(reference: string, value: string): Promise<void>
  delete(reference: string): Promise<void>
}
export type ByokMetadataStore = {
  get(): Promise<ByokConnection[]>
  set(connections: ByokConnection[]): Promise<void>
  /** Must serialize read/modify/write across processes for persistent stores. */
  withLock?<T>(operation: () => Promise<T>): Promise<T>
}
export type ByokConnectionInput = {
  /** User-configured limits, not a claim of tested model capability. */
  contextWindow?: number
  maxOutputTokens?: number
  name: string
  provider: ByokProvider
  model: string
  baseUrl?: string
  apiKey?: string
  credentialRef?: string
}
export type ByokConnectionPatch = Partial<ByokConnectionInput>
export type ByokValidationResult =
  | { ok: true; connection: ByokConnection }
  | {
      ok: false
      connection: ByokConnection
      message: string
      statusCode?: number
    }
export type ByokConnectionStore = {
  create(input: ByokConnectionInput): Promise<ByokConnection>
  list(): Promise<ByokConnection[]>
  update(input: {
    id: string
    revision: number
    patch: ByokConnectionPatch
  }): Promise<ByokConnection>
  remove(input: { id: string; revision: number }): Promise<void>
  resolve(input: {
    id: string
    revision: number
  }): Promise<ResolvedByokConnection>
  validate(input: {
    id: string
    revision: number
  }): Promise<ByokValidationResult>
}

/** Validate before either storing a connection or attaching credentials to a request. */
export function normalizeByokBaseUrl(
  provider: ByokProvider,
  baseUrl?: string,
): string {
  if (provider === 'openrouter') return 'https://openrouter.ai/api/v1'
  if (provider !== 'openai-compatible')
    throw new Error('Unsupported BYOK provider')
  let url: URL
  try {
    url = new URL(baseUrl ?? '')
  } catch {
    throw new Error('Enter a valid provider base URL')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      'Provider endpoints require HTTPS; HTTP is allowed only on loopback',
    )
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Provider URLs cannot contain credentials, query parameters or fragments',
    )
  }
  return url.toString().replace(/\/+$/, '')
}
export function byokCompletionUrl(
  connection: Pick<ByokConnection, 'provider' | 'baseUrl'>,
): string {
  return (
    normalizeByokBaseUrl(connection.provider, connection.baseUrl) +
    '/chat/completions'
  )
}
function parseConnections(value: unknown): ByokConnection[] {
  const parsed = z.array(connectionSchema).safeParse(value)
  if (!parsed.success)
    throw new Error(
      'BYOK connection metadata is corrupt; restore it before continuing',
    )
  if (new Set(parsed.data.map((item) => item.id)).size !== parsed.data.length) {
    throw new Error('BYOK connection metadata contains duplicate connections')
  }
  for (const item of parsed.data) {
    byokModelLimits(item)
    normalizeByokBaseUrl(item.provider, item.baseUrl)
    if (
      !envReference.test(item.credentialRef) &&
      !item.credentialRef.startsWith(`connection:${item.id}:`)
    ) {
      throw new Error(
        'BYOK credential reference belongs to a different connection',
      )
    }
  }
  return parsed.data
}
export function byokModelLimits(connection: {
  contextWindow?: number
  maxOutputTokens?: number
}) {
  const contextWindow = connection.contextWindow ?? 32768
  const maxOutputTokens =
    connection.maxOutputTokens ?? Math.min(4096, Math.floor(contextWindow / 4))
  if (
    !Number.isInteger(contextWindow) ||
    contextWindow < 4096 ||
    contextWindow > 2_000_000 ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens >= contextWindow
  ) {
    throw new Error(
      'Choose a context limit of 4096–2000000 tokens and a smaller positive output limit',
    )
  }
  return {
    contextWindow,
    maxOutputTokens,
    maxContextLength: Math.floor((contextWindow - maxOutputTokens) * 0.9),
  }
}

function cleanInput(input: ByokConnectionInput) {
  const limits = byokModelLimits(input)
  const name = text.safeParse(input.name),
    model = text.safeParse(input.model)
  if (!name.success || !model.success)
    throw new Error('Connection name and model must contain 1–256 characters')
  const baseUrl = normalizeByokBaseUrl(input.provider, input.baseUrl)
  if (
    input.apiKey !== undefined &&
    (!input.apiKey.trim() ||
      /[\r\n]/.test(input.apiKey) ||
      input.apiKey.length > 4096)
  ) {
    throw new Error(
      'Enter a non-empty API key without line breaks (maximum 4096 characters)',
    )
  }
  if (
    input.credentialRef !== undefined &&
    !envReference.test(input.credentialRef)
  ) {
    throw new Error(
      'Only explicit env:VARIABLE credential references may be supplied',
    )
  }
  if (input.apiKey !== undefined && input.credentialRef !== undefined) {
    throw new Error('Choose an API key or an environment reference, not both')
  }
  return {
    contextWindow: limits.contextWindow,
    maxOutputTokens: limits.maxOutputTokens,
    name: name.data,
    model: model.data,
    provider: input.provider,
    baseUrl,
  }
}
const queues = new WeakMap<ByokMetadataStore, Promise<unknown>>()
export function createByokConnectionStore(params: {
  metadataStore: ByokMetadataStore
  secretStore: ByokSecretStore
  fetch?: typeof globalThis.fetch
}): ByokConnectionStore {
  const {
    metadataStore,
    secretStore,
    fetch: fetchImpl = globalThis.fetch,
  } = params
  const read = async () => parseConnections(await metadataStore.get())
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(metadataStore) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() =>
        metadataStore.withLock
          ? metadataStore.withLock(operation)
          : operation(),
      )
    queues.set(
      metadataStore,
      next.catch(() => {}),
    )
    return next
  }
  async function lookup(id: string, revision: number) {
    const connections = await read()
    const connection = connections.find((item) => item.id === id)
    if (!connection)
      throw new Error(
        'BYOK connection was removed; choose a connection for a new task',
      )
    if (connection.revision !== revision)
      throw new Error(
        'BYOK connection changed; start a new task with its current revision',
      )
    return { connection, connections }
  }
  async function getSecret(reference: string) {
    let key: string | undefined
    try {
      key = await secretStore.get(reference)
    } catch {
      throw new Error('Could not unlock the BYOK credential store')
    }
    if (!key?.trim() || /[\r\n]/.test(key))
      throw new Error('BYOK credential is unavailable or invalid')
    return key.trim()
  }
  async function writeSecret(reference: string, key: string) {
    try {
      await secretStore.set(reference, key.trim())
    } catch {
      throw new Error('Could not save the API key in OS credential storage')
    }
  }
  async function eraseSecret(reference: string) {
    if (envReference.test(reference)) return
    try {
      await secretStore.delete(reference)
    } catch {
      throw new Error(
        'Could not remove the OS credential; unlock the store and retry',
      )
    }
  }
  const store: ByokConnectionStore = {
    create: (input) =>
      exclusive(async () => {
        const fields = cleanInput(input)
        if (!input.apiKey && !input.credentialRef)
          throw new Error('An API key or environment reference is required')
        const connections = await read()
        const id = crypto.randomUUID(),
          now = new Date().toISOString()
        const credentialRef = input.credentialRef ?? `connection:${id}:1`
        const connection = {
          ...fields,
          id,
          revision: 1,
          credentialRef,
          createdAt: now,
          updatedAt: now,
        }
        if (input.apiKey !== undefined)
          await writeSecret(credentialRef, input.apiKey)
        try {
          await metadataStore.set([...connections, connection])
        } catch (error) {
          if (input.apiKey !== undefined)
            await secretStore.delete(credentialRef).catch(() => {})
          throw error
        }
        return { ...connection }
      }),
    list: read,
    update: ({ id, revision, patch }) =>
      exclusive(async () => {
        const { connection: existing, connections } = await lookup(id, revision)
        const fields = cleanInput({
          ...existing,
          ...patch,
          credentialRef: patch.credentialRef,
          apiKey: patch.apiKey,
        })
        const changedEndpoint =
          fields.baseUrl !==
          normalizeByokBaseUrl(existing.provider, existing.baseUrl)
        if (
          (changedEndpoint || fields.provider !== existing.provider) &&
          patch.apiKey === undefined &&
          patch.credentialRef === undefined
        ) {
          throw new Error(
            'Changing provider endpoints requires explicitly supplying the credential again',
          )
        }
        const nextRevision = revision + 1
        // New stored revision gets its own credential, so old reads cannot observe replacement keys.
        const credentialRef =
          patch.credentialRef ??
          (patch.apiKey === undefined &&
          envReference.test(existing.credentialRef)
            ? existing.credentialRef
            : `connection:${id}:${nextRevision}`)
        const ownsNewSecret = !envReference.test(credentialRef)
        if (ownsNewSecret)
          await writeSecret(
            credentialRef,
            patch.apiKey ?? (await getSecret(existing.credentialRef)),
          )
        const updated = {
          ...existing,
          ...fields,
          credentialRef,
          revision: nextRevision,
          updatedAt: new Date().toISOString(),
        }
        try {
          await metadataStore.set(
            connections.map((item) => (item.id === id ? updated : item)),
          )
        } catch (error) {
          if (ownsNewSecret)
            await secretStore.delete(credentialRef).catch(() => {})
          throw error
        }
        if (credentialRef !== existing.credentialRef) {
          try {
            await eraseSecret(existing.credentialRef)
          } catch {
            // Keep the old reference reachable so cleanup can be retried.
            await metadataStore.set(connections)
            if (ownsNewSecret)
              await secretStore.delete(credentialRef).catch(() => {})
            throw new Error(
              'Could not rotate the OS credential; connection unchanged. Unlock the store and retry.',
            )
          }
        }
        return { ...updated }
      }),
    remove: ({ id, revision }) =>
      exclusive(async () => {
        const { connection, connections } = await lookup(id, revision)
        // Erase first: on failure metadata remains so the user can retry.
        await eraseSecret(connection.credentialRef)
        await metadataStore.set(connections.filter((item) => item.id !== id))
      }),
    resolve: ({ id, revision }) =>
      exclusive(async () => {
        const { connection } = await lookup(id, revision)
        const result = { ...connection } as ResolvedByokConnection
        Object.defineProperty(result, 'apiKey', {
          value: await getSecret(connection.credentialRef),
          enumerable: false,
        })
        Object.defineProperty(result, 'assertCurrent', {
          value: () =>
            exclusive(async () => {
              await lookup(id, revision)
            }),
          enumerable: false,
        })
        return Object.freeze(result)
      }),
    async validate(selection) {
      const resolved = await store.resolve(selection)
      const connection = { ...resolved }
      try {
        await resolved.assertCurrent?.()
        const response = await fetchImpl(
          normalizeByokBaseUrl(resolved.provider, resolved.baseUrl) +
            (resolved.provider === 'openrouter' ? '/key' : '/models'),
          {
            headers: { Authorization: `Bearer ${resolved.apiKey}` },
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          },
        )
        // No provider-controlled error body is logged or returned; it may echo headers.
        await response.body?.cancel()
        if (!response.ok)
          return {
            ok: false,
            connection,
            message: `Provider connection check failed (HTTP ${response.status})`,
            statusCode: response.status,
          }
        return { ok: true, connection }
      } catch {
        return {
          ok: false,
          connection,
          message:
            'Could not reach the provider securely. Check its URL, connection and credentials.',
        }
      }
    },
  }
  return store
}

type BunSecrets = {
  get(options: { service: string; name: string }): Promise<string | null>
  set(service: string, name: string, value: string): Promise<void>
  delete(options: { service: string; name: string }): Promise<boolean>
}
function bunSecrets(): BunSecrets {
  const secrets = (
    globalThis as typeof globalThis & { Bun?: { secrets?: BunSecrets } }
  ).Bun?.secrets
  if (!secrets)
    throw new Error(
      'OS credential storage requires Bun; use an explicit environment credential for this runtime',
    )
  return secrets
}
export function createEnvironmentByokSecretStore(
  environment: NodeJS.ProcessEnv = getSystemProcessEnv(),
): ByokSecretStore {
  return {
    async get(reference) {
      return envReference.test(reference)
        ? environment[reference.slice(4)]
        : undefined
    },
    async set() {
      throw new Error('Environment credentials are read-only')
    },
    async delete() {},
  }
}

/** Metadata only. Same default directory in packaged Desktop and standalone CLI. */
export function createBunByokMetadataStore(
  options: { directory?: string } = {},
): ByokMetadataStore {
  const directory =
    options.directory ??
    getSystemProcessEnv().FREEBUFF_BYOK_CONFIG_DIR ??
    path.join(homedir(), '.config', 'freebuff', 'byok')
  const file = path.join(directory, 'connections.json')
  const lock = path.join(directory, 'connections.lock')
  return {
    async get() {
      try {
        return parseConnections(JSON.parse(await fs.readFile(file, 'utf8')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw new Error(
          'Cannot read BYOK connection metadata; restore the configuration before continuing',
        )
      }
    },
    async set(connections) {
      const parsed = parseConnections(connections)
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = path.join(
        directory,
        `connections-${crypto.randomUUID()}.tmp`,
      )
      try {
        await fs.writeFile(temporary, JSON.stringify(parsed, null, 2) + '\n', {
          mode: 0o600,
          flag: 'wx',
        })
        await fs.rename(temporary, file)
      } finally {
        await fs.unlink(temporary).catch(() => {})
      }
    },
    async withLock(operation) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const started = Date.now()
      let handle
      while (!handle) {
        try {
          handle = await fs.open(lock, 'wx', 0o600)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          if (Date.now() - started >= 5000)
            throw new Error(
              'BYOK settings are locked. Close other Freebuff processes; if a process crashed, remove connections.lock from the BYOK configuration directory and retry.',
            )
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      try {
        await handle.writeFile(String(process.pid))
        return await operation()
      } finally {
        await handle.close()
        await fs.unlink(lock)
      }
    },
  }
}
export function createBunByokConnectionStore(
  options: {
    directory?: string
    environment?: NodeJS.ProcessEnv
    secretStore?: ByokSecretStore
    fetch?: typeof globalThis.fetch
  } = {},
): ByokConnectionStore {
  const environment = options.environment ?? getSystemProcessEnv()
  const secretStore: ByokSecretStore = options.secretStore ?? {
    async get(reference) {
      if (envReference.test(reference)) return environment[reference.slice(4)]
      return (
        (await bunSecrets().get({
          service: BYOK_SECRET_SERVICE,
          name: reference,
        })) ?? undefined
      )
    },
    async set(reference, value) {
      await bunSecrets().set(BYOK_SECRET_SERVICE, reference, value)
    },
    async delete(reference) {
      if (!envReference.test(reference))
        await bunSecrets().delete({
          service: BYOK_SECRET_SERVICE,
          name: reference,
        })
    },
  }
  return createByokConnectionStore({
    metadataStore: createBunByokMetadataStore(options),
    secretStore,
    fetch: options.fetch,
  })
}
