/** Machine-local connection metadata, separate from OS-protected credentials. */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod/v4'
import { isByokReasoningEffort } from '@codebuff/common/constants/reasoning-effort'
import type { ByokReasoningEffort } from '@codebuff/common/constants/reasoning-effort'
import { getSystemProcessEnv } from './env'
import { recoverByokLock } from './impl/byok-lock'

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
  /**
   * The run's reasoning effort, a per-task choice rather than connection
   * metadata (so never stored). Absent sends no reasoning field at all, which
   * is the provider's own default. See `withByokReasoningEffort`.
   */
  reasoningEffort?: ByokReasoningEffort
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
  | {
      ok: true
      connection: ByokConnection
      /** The endpoint check's HTTP status. */
      statusCode?: number
      /**
       * OpenAI-compatible only, when `/models` returned a list: whether the
       * connection's model id is in it. A proxy may route ids it does not
       * list, so false is a warning, not a failed check.
       */
      modelListed?: boolean
      /** When the model is not listed: the ids the endpoint does list (capped). */
      availableModels?: string[]
    }
  | {
      ok: false
      connection: ByokConnection
      message: string
      statusCode?: number
    }
export type ByokConnectionStore = {
  create(input: ByokConnectionInput): Promise<ByokConnection>
  addModel(input: {
    id: string
    revision: number
    model: Pick<
      ByokConnectionInput,
      'name' | 'model' | 'contextWindow' | 'maxOutputTokens'
    >
  }): Promise<ByokConnection>
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

/**
 * The connection's credential could not be read. Its message is ours, names
 * at most an environment-variable NAME, and never carries a key value, so a
 * caller may show it as is.
 */
export class ByokCredentialError extends Error {
  override name = 'ByokCredentialError'
}

/** A local connection-state failure with a safe, SDK-authored message. */
export class ByokConnectionStateError extends Error {
  override name = 'ByokConnectionStateError'
}

/** The environment variable a connection reads its key from, if any. */
export function byokCredentialVariable(
  connection: Pick<ByokConnection, 'credentialRef'>,
): string | undefined {
  return envReference.test(connection.credentialRef)
    ? connection.credentialRef.slice(4)
    : undefined
}

/**
 * Unset (or empty) in THIS process. The usual cause is starting Freebuff
 * before exporting the variable, or from another terminal: a running process
 * never sees a later `export`, so saying "restart" is the actual fix.
 */
export function missingEnvironmentCredentialMessage(variable: string): string {
  return `${variable} is not set in this Freebuff process. Set it and restart Freebuff from that terminal.`
}

/**
 * The provider refused the key (401/403). For an environment reference the
 * variable IS set (an unset one never reaches the provider), so name it and
 * point at its value rather than at its presence.
 */
export function rejectedByokCredentialMessage(
  connection: Pick<ByokConnection, 'credentialRef'>,
  status: number,
): string {
  const variable = byokCredentialVariable(connection)
  return variable
    ? `The provider rejected the key in ${variable} (HTTP ${status}). ${variable} is set in this Freebuff process; check that it holds the key this endpoint expects, then restart Freebuff from that terminal.`
    : `The provider rejected the saved API key (HTTP ${status}). Check or replace the key.`
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
    throw new ByokConnectionStateError(
      'BYOK connection metadata is corrupt; restore it before continuing',
    )
  if (new Set(parsed.data.map((item) => item.id)).size !== parsed.data.length) {
    throw new ByokConnectionStateError('BYOK connection metadata contains duplicate connections')
  }
  for (const item of parsed.data) {
    byokModelLimits(item)
    normalizeByokBaseUrl(item.provider, item.baseUrl)
    if (
      !envReference.test(item.credentialRef) &&
      !item.credentialRef.startsWith(`connection:${item.id}:`)
    ) {
      throw new ByokConnectionStateError(
        'BYOK credential reference belongs to a different connection',
      )
    }
  }
  return parsed.data
}
/**
 * The limits a connection gets when nobody chose any. The Desktop settings
 * form pre-fills exactly this pair, and the store persists it, so a stored
 * 32,768 / 4,096 almost always means "not configured" rather than a decision.
 */
export const BYOK_DEFAULT_CONTEXT_WINDOW = 32_768
export const BYOK_DEFAULT_MAX_OUTPUT_TOKENS = 4_096
/** A remote endpoint that does not report its model's window. */
export const BYOK_UNKNOWN_REMOTE_CONTEXT_WINDOW = 131_072
/**
 * The most an automatically-chosen window may be: the hosted budget's order of
 * magnitude, since every token of a BYOK request is billed to the user's key.
 * A user who wants more types it into the connection.
 */
export const BYOK_DISCOVERED_CONTEXT_WINDOW_CAP = 400_000

export function byokModelLimits(connection: {
  contextWindow?: number
  maxOutputTokens?: number
}) {
  const contextWindow = connection.contextWindow ?? BYOK_DEFAULT_CONTEXT_WINDOW
  const maxOutputTokens =
    connection.maxOutputTokens ??
    Math.min(BYOK_DEFAULT_MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 4))
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

/** True when the connection carries the untouched default limits (see above). */
export function hasDefaultByokLimits(connection: {
  contextWindow?: number
  maxOutputTokens?: number
}): boolean {
  return (
    (connection.contextWindow ?? BYOK_DEFAULT_CONTEXT_WINDOW) ===
      BYOK_DEFAULT_CONTEXT_WINDOW &&
    (connection.maxOutputTokens ?? BYOK_DEFAULT_MAX_OUTPUT_TOKENS) ===
      BYOK_DEFAULT_MAX_OUTPUT_TOKENS
  )
}

function isLoopbackByokEndpoint(
  connection: Pick<ByokConnection, 'provider' | 'baseUrl'>,
): boolean {
  if (connection.provider !== 'openai-compatible') return false
  try {
    const { hostname } = new URL(
      normalizeByokBaseUrl(connection.provider, connection.baseUrl),
    )
    return ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
  } catch {
    return false
  }
}

/** Fields OpenAI-compatible `/models` listings use for a model's window:
 *  OpenRouter/Together (`context_length`), Groq (`context_window`), vLLM
 *  (`max_model_len`), LM Studio (`loaded_context_length`), and others. */
const CONTEXT_WINDOW_FIELDS = [
  'context_length',
  'context_window',
  'max_model_len',
  'max_context_length',
  'loaded_context_length',
] as const

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isInteger(number) && number > 0
    ? number
    : undefined
}

/** The window a `/models` listing reports for `model`, or undefined. */
export function contextWindowFromModelList(
  body: unknown,
  model: string,
): number | undefined {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as any).data)
      ? ((body as any).data as unknown[])
      : []
  const entries = list.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === 'object',
  )
  // OpenRouter variants (`vendor/model:free`) fall back to the base model.
  const candidates = [model, model.replace(/:[^/:]+$/, '')]
  for (const id of candidates) {
    const entry = entries.find(
      (item) => item.id === id || item.canonical_slug === id,
    )
    if (!entry) continue
    const topProvider =
      entry.top_provider && typeof entry.top_provider === 'object'
        ? (entry.top_provider as Record<string, unknown>)
        : {}
    for (const value of [
      ...CONTEXT_WINDOW_FIELDS.map((field) => entry[field]),
      topProvider.context_length,
    ]) {
      const window = positiveInteger(value)
      if (window !== undefined) return window
    }
  }
  return undefined
}

const discoveredWindows = new Map<
  string,
  { expiresAt: number; window: Promise<number | undefined> }
>()
const DISCOVERY_HIT_TTL_MS = 6 * 60 * 60 * 1000
const DISCOVERY_MISS_TTL_MS = 10 * 60 * 1000
const DISCOVERY_TIMEOUT_MS = 4_000

/** Test seam: forget every cached discovery. */
export function clearByokContextWindowCache(): void {
  discoveredWindows.clear()
}

/**
 * Ask the provider's `/models` listing how large this model's window is.
 * Best effort: never throws, and a miss is remembered briefly so a provider
 * without the field is not asked on every turn. The listing is what the
 * connection check already calls; OpenRouter's is public, so the key is sent
 * only to an OpenAI-compatible endpoint that needs it.
 */
export async function discoverByokContextWindow(
  connection: Pick<
    ResolvedByokConnection,
    'provider' | 'baseUrl' | 'model' | 'apiKey'
  >,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<number | undefined> {
  let base: string
  try {
    base = normalizeByokBaseUrl(connection.provider, connection.baseUrl)
  } catch {
    return undefined
  }
  const key = `${base}\n${connection.model}`
  const now = Date.now()
  const cached = discoveredWindows.get(key)
  if (cached && cached.expiresAt > now) return cached.window
  const window = (async () => {
    try {
      const response = await fetchImpl(`${base}/models`, {
        headers:
          connection.provider === 'openrouter'
            ? {}
            : { Authorization: `Bearer ${connection.apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      })
      if (!response.ok) {
        await response.body?.cancel()
        return undefined
      }
      return contextWindowFromModelList(await response.json(), connection.model)
    } catch {
      return undefined
    }
  })()
  discoveredWindows.set(key, { expiresAt: now + DISCOVERY_HIT_TTL_MS, window })
  const result = await window
  if (result === undefined)
    discoveredWindows.set(key, {
      expiresAt: now + DISCOVERY_MISS_TTL_MS,
      window,
    })
  return result
}

/**
 * The connection with a run's reasoning effort attached, or the connection
 * itself when there is none to attach (anything that is not a BYOK rung means
 * "the provider's default"). A copy, never a mutation: the resolved connection
 * is frozen and shared. The credential and revocation check stay
 * non-enumerable on the copy, exactly as the resolver made them.
 */
export function withByokReasoningEffort(
  connection: ResolvedByokConnection,
  effort: unknown,
): ResolvedByokConnection {
  if (!isByokReasoningEffort(effort)) {
    if (connection.reasoningEffort === undefined) return connection
    const { reasoningEffort: _dropped, ...rest } = connection
    return copyRuntimeFields(rest as ResolvedByokConnection, connection)
  }
  if (connection.reasoningEffort === effort) return connection
  return copyRuntimeFields(
    { ...connection, reasoningEffort: effort } as ResolvedByokConnection,
    connection,
  )
}

function copyRuntimeFields(
  target: ResolvedByokConnection,
  source: ResolvedByokConnection,
): ResolvedByokConnection {
  Object.defineProperty(target, 'apiKey', {
    value: source.apiKey,
    enumerable: false,
  })
  if (source.assertCurrent)
    Object.defineProperty(target, 'assertCurrent', {
      value: source.assertCurrent,
      enumerable: false,
    })
  return target
}

/**
 * The connection a run should use: identical, unless its limits are the
 * untouched defaults. Those are a 32,768-token guess, and for a coding agent
 * whose tool schemas and prompt alone are ~15-20k tokens, compacting at 80% of
 * 90% of (32,768 - 4,096) leaves a few thousand tokens of conversation: every
 * few tool calls the run compacted, and the summary itself sat above the line
 * (Desktop feedback 2026-09-24 and 09-27, "compacts every 3-5 turns").
 *
 * The provider's own number wins when its `/models` listing reports one
 * (capped at BYOK_DISCOVERED_CONTEXT_WINDOW_CAP). Otherwise a remote endpoint
 * gets 128k, which nearly every hosted coding model supports, and a loopback
 * server keeps the configured default, because a local server's window is
 * whatever it was launched with. Limits a user actually typed are never
 * replaced. The credential stays non-enumerable on the copy.
 */
export async function withEffectiveByokLimits(
  connection: ResolvedByokConnection,
  options: { fetch?: typeof globalThis.fetch } = {},
): Promise<ResolvedByokConnection> {
  if (!hasDefaultByokLimits(connection)) return connection
  const discovered = await discoverByokContextWindow(connection, options.fetch)
  const contextWindow =
    // A window must exceed the output limit (byokModelLimits' own rule).
    discovered !== undefined && discovered > BYOK_DEFAULT_MAX_OUTPUT_TOKENS
      ? Math.min(discovered, BYOK_DISCOVERED_CONTEXT_WINDOW_CAP)
      : isLoopbackByokEndpoint(connection)
        ? BYOK_DEFAULT_CONTEXT_WINDOW
        : BYOK_UNKNOWN_REMOTE_CONTEXT_WINDOW
  if (
    contextWindow === (connection.contextWindow ?? BYOK_DEFAULT_CONTEXT_WINDOW)
  )
    return connection
  const effective = {
    ...connection,
    contextWindow,
    maxOutputTokens:
      connection.maxOutputTokens ?? BYOK_DEFAULT_MAX_OUTPUT_TOKENS,
  } as ResolvedByokConnection
  Object.defineProperty(effective, 'apiKey', {
    value: connection.apiKey,
    enumerable: false,
  })
  if (connection.assertCurrent)
    Object.defineProperty(effective, 'assertCurrent', {
      value: connection.assertCurrent,
      enumerable: false,
    })
  return Object.freeze(effective)
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
/** At most this many listed ids are returned when the model is not among them. */
export const BYOK_AVAILABLE_MODELS_LIMIT = 50

/** The ids of an OpenAI-compatible `/models` listing (`{data: [...]}` or a bare array). */
function modelIdsFromListing(body: unknown): string[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as any).data)
      ? ((body as any).data as unknown[])
      : []
  return list
    .map((entry) =>
      entry && typeof entry === 'object'
        ? (entry as Record<string, unknown>).id
        : undefined,
    )
    .filter((id): id is string => typeof id === 'string')
}

/**
 * What a successful `/models` answer says about this connection. A web page
 * (an SPA or dashboard answering every path) means the base URL is wrong —
 * typically a proxy's root instead of its `/v1`. Ids echoed back are printable,
 * bounded, and never contain the key.
 */
async function readModelListing(
  response: Response,
  connection: Pick<ResolvedByokConnection, 'provider' | 'model' | 'apiKey'>,
): Promise<
  | { webPage: true }
  | { webPage: false; modelListed?: boolean; availableModels?: string[] }
> {
  if (connection.provider !== 'openai-compatible') {
    await response.body?.cancel()
    return { webPage: false }
  }
  let text: string
  try {
    text = await response.text()
  } catch {
    return { webPage: false }
  }
  if (
    /text\/html/i.test(response.headers.get('content-type') ?? '') ||
    /^\s*<(?:!doctype|html)/i.test(text)
  )
    return { webPage: true }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { webPage: false }
  }
  const ids = modelIdsFromListing(body)
  if (ids.length === 0) return { webPage: false }
  if (ids.includes(connection.model)) return { webPage: false, modelListed: true }
  const shown = ids.filter(
    (id) =>
      id.length <= 200 &&
      /^[\x21-\x7e]+$/.test(id) &&
      !id.includes(connection.apiKey),
  )
  return {
    webPage: false,
    modelListed: false,
    availableModels: shown.slice(0, BYOK_AVAILABLE_MODELS_LIMIT),
  }
}

/** The fix for a base URL that answered 404 or a web page at `/models`. */
function baseUrlHint(base: string): string {
  const { pathname } = new URL(base)
  return /\/v\d+[a-z0-9]*(?:\/|$)/i.test(pathname)
    ? 'Check the base URL.'
    : `OpenAI-compatible base URLs usually end in /v1; try ${base}/v1.`
}

/**
 * A transport failure, classified by its code. Only the endpoint's origin is
 * shown — the thrown error itself can echo request details.
 */
function unreachableProviderMessage(
  error: unknown,
  base: string | undefined,
): string {
  const origin = base ? new URL(base).origin : 'the provider'
  const code = [
    (error as { code?: unknown } | null)?.code,
    ((error as { cause?: { code?: unknown } } | null)?.cause ?? {}).code,
  ].find((value): value is string => typeof value === 'string')
  if (code === 'ConnectionRefused' || code === 'ECONNREFUSED')
    return `Nothing is accepting connections at ${origin} (connection refused). Start the provider or proxy, or check the host and port.`
  if ((error as { name?: unknown } | null)?.name === 'TimeoutError')
    return `${origin} did not answer within 10 seconds. Check that the provider or proxy is running and reachable.`
  return 'Could not reach the provider securely. Check its URL, connection and credentials.'
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
      throw new ByokConnectionStateError(
        'BYOK connection was removed; select another provider or a Freebuff model to continue',
      )
    if (connection.revision !== revision)
      throw new ByokConnectionStateError(
        'BYOK connection changed; select its current revision to continue',
      )
    return { connection, connections }
  }
  async function getSecret(reference: string) {
    let key: string | undefined
    try {
      key = await secretStore.get(reference)
    } catch {
      throw new ByokCredentialError('Could not unlock the BYOK credential store')
    }
    // Surrounding whitespace is not part of a key: a CRLF `.env` file leaves
    // a trailing "\r" on the value, which used to reject a correct key.
    const trimmed = key?.trim()
    const variable = envReference.test(reference)
      ? reference.slice(4)
      : undefined
    if (!trimmed)
      throw new ByokCredentialError(
        variable
          ? missingEnvironmentCredentialMessage(variable)
          : 'BYOK credential is unavailable or invalid',
      )
    if (/[\r\n]/.test(trimmed))
      throw new ByokCredentialError(
        variable
          ? `${variable} contains a line break. Set it to the key alone and restart Freebuff from that terminal.`
          : 'BYOK credential is unavailable or invalid',
      )
    return trimmed
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
  // Called only under the metadata lock, including when copying a saved provider.
  async function create(input: ByokConnectionInput) {
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
  }
  const store: ByokConnectionStore = {
    create: (input) => exclusive(() => create(input)),
    addModel: ({ id, revision, model }) =>
      exclusive(async () => {
        const { connection } = await lookup(id, revision)
        return create({
          name: model.name,
          model: model.model,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          provider: connection.provider,
          baseUrl: connection.baseUrl,
          // Each saved model owns its key, so rotation/removal cannot break siblings.
          // Environment references remain references, never copied key values.
          ...(envReference.test(connection.credentialRef)
            ? { credentialRef: connection.credentialRef }
            : { apiKey: await getSecret(connection.credentialRef) }),
        })
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
      let resolved: ResolvedByokConnection
      try {
        resolved = await store.resolve(selection)
      } catch (error) {
        // A missing key is a failed check of an existing connection, not a
        // failed command: `/byok add` has already saved it by now.
        if (!(error instanceof ByokCredentialError)) throw error
        const saved = (await read()).find(
          (item) =>
            item.id === selection.id && item.revision === selection.revision,
        )
        if (!saved) throw error
        return { ok: false, connection: { ...saved }, message: error.message }
      }
      const connection = { ...resolved }
      let base: string | undefined
      try {
        await resolved.assertCurrent?.()
        base = normalizeByokBaseUrl(resolved.provider, resolved.baseUrl)
        const response = await fetchImpl(
          base + (resolved.provider === 'openrouter' ? '/key' : '/models'),
          {
            headers: { Authorization: `Bearer ${resolved.apiKey}` },
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          },
        )
        // No provider-controlled error body is logged or returned; it may echo
        // headers. Only a successful model list is read, and only model ids
        // (filtered, never the key) leave it.
        const listing = response.ok
          ? await readModelListing(response, resolved)
          : (await response.body?.cancel(), undefined)
        if (response.status === 404 && resolved.provider === 'openai-compatible')
          return {
            ok: false,
            connection,
            message: `Provider connection check failed (HTTP 404 from ${base}/models). ${baseUrlHint(base)}`,
            statusCode: response.status,
          }
        if (!response.ok)
          return {
            ok: false,
            connection,
            message:
              response.status === 401
                ? rejectedByokCredentialMessage(resolved, response.status)
                : `Provider connection check failed (HTTP ${response.status})`,
            statusCode: response.status,
          }
        if (listing?.webPage)
          return {
            ok: false,
            connection,
            message: `${base}/models answered with a web page, not an OpenAI-compatible model list (HTTP ${response.status}). ${baseUrlHint(base)}`,
            statusCode: response.status,
          }
        return {
          ok: true,
          connection,
          statusCode: response.status,
          ...(listing?.modelListed !== undefined
            ? { modelListed: listing.modelListed }
            : {}),
          ...(listing?.availableModels
            ? { availableModels: listing.availableModels }
            : {}),
        }
      } catch (error) {
        return {
          ok: false,
          connection,
          message: unreachableProviderMessage(error, base),
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
        throw new ByokConnectionStateError(
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
      const candidate = path.join(
        directory,
        `connections-lock-${crypto.randomUUID()}.tmp`,
      )
      let acquired = false
      try {
        // Publish an already-complete PID atomically. Creating an empty lock and
        // then writing its owner leaves an unrecoverable lock if killed between.
        await fs.writeFile(candidate, String(process.pid), {
          flag: 'wx',
          mode: 0o600,
        })
        while (!acquired) {
          try {
            await fs.link(candidate, lock)
            acquired = true
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            await recoverByokLock(lock)
            if (Date.now() - started >= 5000)
              throw new ByokConnectionStateError(
                'BYOK settings are locked. Close other Freebuff processes and retry. If the problem persists, close all Freebuff processes before removing connections.lock from the BYOK configuration directory.',
              )
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
        }
        await fs.unlink(candidate)
        return await operation()
      } finally {
        try {
          if (acquired) await fs.unlink(lock)
        } finally {
          await fs.unlink(candidate).catch(() => {})
        }
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
