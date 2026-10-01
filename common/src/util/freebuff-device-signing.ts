/**
 * Device-bound request signing for catalog clients (the CLI and Desktop), the
 * client half of the contract in `common/src/types/freebuff-model-catalog.ts`
 * (`FREEBUFF_DEVICE_*`, `freebuffDeviceSignaturePayload`).
 *
 * One Ed25519 key pair per install, generated with WebCrypto. The public key
 * is registered once per (account, API host) with
 * `POST FREEBUFF_DEVICE_KEYS_PATH`, and the returned `keyId` is remembered
 * beside the key. Every catalog, session and completions request a catalog
 * client makes then carries the key id, a timestamp and a signature over the
 * exact body bytes it sends.
 *
 * Signing is best-effort by design: no WebCrypto Ed25519, no stored key, a
 * registration that failed or has not answered yet — the request simply goes
 * out unsigned. Nothing here ever throws at a caller or holds a request for
 * longer than `waitMs`.
 *
 * Where the key lives is the host's business (`FreebuffDeviceKeyStore`): the
 * CLI keeps an owner-only file in its config dir, Desktop keeps it encrypted
 * beside its sign-in. Public code: a device's private key is its own secret,
 * and nothing here is one.
 */
import {
  FREEBUFF_DEVICE_KEY_HEADER,
  FREEBUFF_DEVICE_KEYS_PATH,
  FREEBUFF_DEVICE_SIGNATURE_HEADER,
  FREEBUFF_DEVICE_TIMESTAMP_HEADER,
  freebuffDeviceSignaturePayload,
} from '../types/freebuff-model-catalog'

export type FreebuffDeviceClient = 'cli' | 'desktop'

/** What an install stores. The private key never leaves it. */
export interface FreebuffDeviceKeyRecord {
  version: 1
  /** base64url of the raw 32-byte Ed25519 public key: what registration sends. */
  publicKey: string
  /** base64url of the PKCS#8 private key. */
  privateKey: string
  /** The server's key id per registration scope (API host + account). */
  registrations: Record<string, string>
}

export interface FreebuffDeviceKeyStore {
  /** The stored record, or null when there is none (a new one is generated).
   *  Throws when one exists but cannot be read right now: signing is then off
   *  for this process rather than the stored key being replaced. */
  load(): Promise<FreebuffDeviceKeyRecord | null>
  save(record: FreebuffDeviceKeyRecord): Promise<void>
}

/** Who a request is made as: one registration per account and API host. */
export interface FreebuffDeviceAccount {
  token: string
  /** The account's user id when the client knows it; otherwise the account is
   *  identified by a digest of its token (a new login registers again). */
  accountId?: string | null
  /** The API origin requests go to, e.g. `https://www.codebuff.com`. */
  apiHost: string
}

export interface FreebuffDeviceRequest {
  method: string
  /** Absolute URL; only its path is signed. */
  url: string
  /** The exact body sent; absent for a body-less request. */
  body?: string | Uint8Array | null
  /** The catalog fetch id sent with this request (FREEBUFF_CATALOG_FETCH_HEADER), if any. */
  fetchId?: string | null
}

const ED25519 = { name: 'Ed25519' } as const
const REGISTER_TIMEOUT_MS = 10_000
/** How long a request waits for the key and its registration before going out unsigned. */
const DEFAULT_WAIT_MS = 3_000
/** A refused or failed registration is not retried on every request. */
const REGISTER_RETRY_MS = 5 * 60_000
/** A server that has no device-key endpoint (404/405) is asked again this rarely. */
const REGISTER_UNSUPPORTED_RETRY_MS = 60 * 60_000

// --- Encoding ----------------------------------------------------------------

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bodyBytes(body: string | Uint8Array | null | undefined): Uint8Array {
  if (body === null || body === undefined) return new Uint8Array(0)
  return typeof body === 'string' ? new TextEncoder().encode(body) : body
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++)
    out += bytes[i]!.toString(16).padStart(2, '0')
  return out
}

/** Lowercase hex SHA-256 of the body bytes as sent ('' for none). */
export async function freebuffBodySha256(
  body: string | Uint8Array | null | undefined,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  return hex(
    new Uint8Array(await subtle.digest('SHA-256', bodyBytes(body) as BufferSource)),
  )
}

// --- Keys --------------------------------------------------------------------

function defaultSubtle(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null
}

/** A new key pair, or null where this runtime has no WebCrypto Ed25519. */
export async function generateFreebuffDeviceKey(
  subtle: SubtleCrypto | null = defaultSubtle(),
): Promise<FreebuffDeviceKeyRecord | null> {
  if (!subtle) return null
  try {
    const pair = (await subtle.generateKey(ED25519, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const publicKey = new Uint8Array(
      await subtle.exportKey('raw', pair.publicKey),
    )
    const privateKey = new Uint8Array(
      await subtle.exportKey('pkcs8', pair.privateKey),
    )
    return {
      version: 1,
      publicKey: base64UrlEncode(publicKey),
      privateKey: base64UrlEncode(privateKey),
      registrations: {},
    }
  } catch {
    return null
  }
}

/** A stored record, validated; null for anything this build did not write. */
export function parseFreebuffDeviceKeyRecord(
  value: unknown,
): FreebuffDeviceKeyRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    typeof record.publicKey !== 'string' ||
    typeof record.privateKey !== 'string'
  )
    return null
  const registrations: Record<string, string> = {}
  const stored = record.registrations
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [scope, keyId] of Object.entries(stored)) {
      if (typeof keyId === 'string' && keyId) registrations[scope] = keyId
    }
  }
  return {
    version: 1,
    publicKey: record.publicKey,
    privateKey: record.privateKey,
    registrations,
  }
}

export async function importFreebuffDeviceSigningKey(
  record: FreebuffDeviceKeyRecord,
  subtle: SubtleCrypto | null = defaultSubtle(),
): Promise<CryptoKey | null> {
  if (!subtle) return null
  try {
    return await subtle.importKey(
      'pkcs8',
      base64UrlDecode(record.privateKey) as BufferSource,
      ED25519,
      false,
      ['sign'],
    )
  } catch {
    return null
  }
}

/** The three device headers for one request, signed with `privateKey`. */
export async function signFreebuffDeviceRequest(params: {
  privateKey: CryptoKey
  keyId: string
  request: FreebuffDeviceRequest
  timestampMs: number
  subtle?: SubtleCrypto
}): Promise<Record<string, string>> {
  const subtle = params.subtle ?? globalThis.crypto.subtle
  const payload = freebuffDeviceSignaturePayload({
    method: params.request.method,
    path: new URL(params.request.url).pathname,
    timestampMs: params.timestampMs,
    bodySha256: await freebuffBodySha256(params.request.body, subtle),
    fetchId: params.request.fetchId,
  })
  const signature = new Uint8Array(
    await subtle.sign(
      ED25519,
      params.privateKey,
      new TextEncoder().encode(payload) as BufferSource,
    ),
  )
  return {
    [FREEBUFF_DEVICE_KEY_HEADER]: params.keyId,
    [FREEBUFF_DEVICE_TIMESTAMP_HEADER]: String(params.timestampMs),
    [FREEBUFF_DEVICE_SIGNATURE_HEADER]: base64UrlEncode(signature),
  }
}

/**
 * Whether a server error code says the device key a request named is not one
 * it knows (deleted, never registered, another account's). The client then
 * forgets the key id it holds and registers again. Matched loosely, on the
 * code alone: `device_key` plus unknown / not found / invalid.
 */
export function isFreebuffDeviceKeyUnknownError(
  code: string | null | undefined,
): boolean {
  return (
    !!code &&
    /device[_-]?key/i.test(code) &&
    /unknown|not[_-]?found|invalid|unregistered/i.test(code)
  )
}

// --- The signer --------------------------------------------------------------

interface LoadedKey {
  record: FreebuffDeviceKeyRecord
  privateKey: CryptoKey
}

export class FreebuffDeviceSigner {
  /** The stored key only (never generates one). */
  private stored: Promise<LoadedKey | null> | null = null
  /** The stored key, else a newly generated one. */
  private loading: Promise<LoadedKey | null> | null = null
  /** The store holds a key it cannot read right now: no signing this process. */
  private unavailable = false
  private readonly registering = new Map<string, Promise<string | null>>()
  private readonly retryAfter = new Map<string, number>()
  private saving: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: {
      store: FreebuffDeviceKeyStore
      client: FreebuffDeviceClient
      fetch?: typeof fetch
      now?: () => number
      /** How long a request waits for the key and its registration. */
      waitMs?: number
      /** Injectable for a runtime without Ed25519; null disables signing. */
      subtle?: SubtleCrypto | null
      log?: (message: string) => void
    },
  ) {}

  /**
   * The device headers for one request, or `{}` (send it unsigned) when there
   * is no key or registration yet. Never throws. Waits at most `waitMs` for a
   * first key load or registration; the work carries on behind a request that
   * stopped waiting, so the next one is signed.
   */
  async headers(
    account: FreebuffDeviceAccount,
    request: FreebuffDeviceRequest,
    options: {
      /** false: sign only with a key id already registered, never register
       *  (and never wait) for this request. A client that has not yet seen
       *  the server speak the catalog uses it, so a server that predates the
       *  protocol gets no registration traffic at all. */
      register?: boolean
    } = {},
  ): Promise<Record<string, string>> {
    try {
      const ready = await withTimeout(
        this.prepare(account, options.register ?? true),
        this.options.waitMs ?? DEFAULT_WAIT_MS,
      )
      if (!ready) return {}
      return await signFreebuffDeviceRequest({
        privateKey: ready.key.privateKey,
        keyId: ready.keyId,
        request,
        timestampMs: this.now(),
        subtle: this.subtle() ?? undefined,
      })
    } catch (error) {
      this.log(`signing failed: ${describe(error)}`)
      return {}
    }
  }

  /** The server does not know the key id this account sent: register again. */
  forgetRegistration(account: FreebuffDeviceAccount): void {
    void (async () => {
      const loaded = await (this.loading ?? this.stored)
      const scope = await this.scopeFor(account)
      this.retryAfter.delete(scope)
      if (!loaded || !(scope in loaded.record.registrations)) return
      delete loaded.record.registrations[scope]
      await this.persist(loaded.record)
    })().catch(() => {})
  }

  /** Resolves once queued writes have finished. Tests only. */
  settled(): Promise<void> {
    return this.saving
  }

  private async prepare(
    account: FreebuffDeviceAccount,
    register: boolean,
  ): Promise<{ key: LoadedKey; keyId: string } | null> {
    // Not registering, nothing is generated either: a client that has not
    // seen the server speak the catalog writes no key on its account.
    const key = register
      ? await this.ensureKey()
      : await (this.loading ?? this.loadStoredKey())
    if (!key) return null
    const keyId = register
      ? await this.keyIdFor(account, key)
      : (key.record.registrations[await this.scopeFor(account)] ?? null)
    return keyId ? { key, keyId } : null
  }

  private loadStoredKey(): Promise<LoadedKey | null> {
    this.stored ??= (async () => {
      const subtle = this.subtle()
      if (!subtle) return null
      const stored = await this.options.store.load()
      if (!stored) return null
      const privateKey = await importFreebuffDeviceSigningKey(stored, subtle)
      if (privateKey) return { record: stored, privateKey }
      this.log('the stored device key could not be read; a new one replaces it')
      return null
    })().catch((error) => {
      this.unavailable = true
      this.log(`device key unavailable: ${describe(error)}`)
      return null
    })
    return this.stored
  }

  private ensureKey(): Promise<LoadedKey | null> {
    this.loading ??= (async () => {
      const stored = await this.loadStoredKey()
      if (stored || this.unavailable) return stored
      const subtle = this.subtle()
      const record = await generateFreebuffDeviceKey(subtle)
      if (!record) return null
      const privateKey = await importFreebuffDeviceSigningKey(record, subtle)
      if (!privateKey) return null
      await this.persist(record)
      return { record, privateKey }
    })().catch((error) => {
      this.log(`device key unavailable: ${describe(error)}`)
      return null
    })
    return this.loading
  }

  private async keyIdFor(
    account: FreebuffDeviceAccount,
    key: LoadedKey,
  ): Promise<string | null> {
    const scope = await this.scopeFor(account)
    const known = key.record.registrations[scope]
    if (known) return known
    if ((this.retryAfter.get(scope) ?? 0) > this.now()) return null
    let pending = this.registering.get(scope)
    if (!pending) {
      pending = this.register(account, scope, key).finally(() => {
        this.registering.delete(scope)
      })
      this.registering.set(scope, pending)
    }
    return pending
  }

  private async register(
    account: FreebuffDeviceAccount,
    scope: string,
    key: LoadedKey,
  ): Promise<string | null> {
    const fail = (retryMs: number, why: string) => {
      this.retryAfter.set(scope, this.now() + retryMs)
      this.log(`device key registration failed (${why})`)
      return null
    }
    let res: Response
    try {
      res = await (this.options.fetch ?? fetch)(
        `${account.apiHost.replace(/\/$/, '')}${FREEBUFF_DEVICE_KEYS_PATH}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${account.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            publicKey: key.record.publicKey,
            client: this.options.client,
          }),
          signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
        },
      )
    } catch (error) {
      return fail(REGISTER_RETRY_MS, describe(error))
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return fail(
        res.status === 404 || res.status === 405
          ? REGISTER_UNSUPPORTED_RETRY_MS
          : REGISTER_RETRY_MS,
        `HTTP ${res.status}`,
      )
    }
    const body = (await res.json().catch(() => null)) as {
      keyId?: unknown
    } | null
    const keyId = typeof body?.keyId === 'string' ? body.keyId : ''
    if (!keyId) return fail(REGISTER_RETRY_MS, 'no keyId in the answer')
    key.record.registrations[scope] = keyId
    // remembered in memory either way; a failed write only costs a re-registration next launch
    await this.persist(key.record)
    return keyId
  }

  private persist(record: FreebuffDeviceKeyRecord): Promise<void> {
    const snapshot: FreebuffDeviceKeyRecord = {
      ...record,
      registrations: { ...record.registrations },
    }
    this.saving = this.saving
      .then(() => this.options.store.save(snapshot))
      .catch((error) => {
        this.log(`saving the device key failed: ${describe(error)}`)
      })
    return this.saving
  }

  private async scopeFor(account: FreebuffDeviceAccount): Promise<string> {
    const host = account.apiHost.replace(/\/$/, '')
    if (account.accountId) return `${host} user:${account.accountId}`
    const subtle = this.subtle() ?? globalThis.crypto.subtle
    const digest = (await freebuffBodySha256(account.token, subtle)).slice(0, 32)
    return `${host} token:${digest}`
  }

  private subtle(): SubtleCrypto | null {
    return this.options.subtle === undefined
      ? defaultSubtle()
      : this.options.subtle
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private log(message: string): void {
    this.options.log?.(`[device-key] ${message}`)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    ;(timer as { unref?: () => void }).unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

// never a token or a key: an error's own message, bounded
const describe = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200)
