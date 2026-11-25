/**
 * Device-local encrypted secret vault.
 *
 * The contract this file exists to keep:
 *
 *  - A secret is added once and referenced by NAME. The model is shown the
 *    name (or the `${secret:NAME}` placeholder), never the value.
 *  - Values are encrypted at rest with AES-256-GCM. The data key lives beside
 *    the vault in a 0600 file and never leaves the machine.
 *  - Substitution happens at a boundary we control (a spawned process's
 *    environment, or an HTTP request to a loopback endpoint), after the model
 *    has finished writing. Output is redacted before it goes back to the
 *    model.
 *  - A reference is refused outright for a non-loopback destination, so a
 *    value cannot be sent to a remote server by accident.
 *  - Nothing expires. A record lives until it is removed or rotated.
 *
 * What this file does NOT do: substitute secrets inside Freebuff's cloud
 * runs. Those run on the server, which is not part of this repository, and
 * the point of the design is that the server never receives the value.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Environment-variable-shaped: the name is what the model is allowed to see. */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/

/** The one placeholder spelling the model may write. */
export const SECRET_PLACEHOLDER_PREFIX = '${secret:'

/** Smallest value that can be redacted without eating ordinary words. */
export const SECRET_VALUE_MIN = 8
export const SECRET_VALUE_MAX = 4096

const VAULT_FILE = 'secrets.vault.json'
const KEY_FILE = 'secrets.key'
const VAULT_FORMAT = 1
const KEY_BYTES = 32
const IV_BYTES = 12
const AAD_VERSION = 'freebuff-secrets-v1'

export type SecretRecord = {
  name: string
  /** Bumped by every rotation; AAD binds ciphertext to it. */
  revision: number
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
}

export type RevealedSecret = { name: string; value: string }

export class SecretNameError extends Error {
  constructor(name: string) {
    super(
      `"${name}" is not a valid secret name. Use an environment-variable name such as ACME_API_KEY.`,
    )
    this.name = 'SecretNameError'
  }
}

export class SecretValueError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'SecretValueError'
  }
}

export class SecretExistsError extends Error {
  constructor(name: string) {
    super(`A secret named ${name} already exists. Use rotate to change its value.`)
    this.name = 'SecretExistsError'
  }
}

export class SecretNotFoundError extends Error {
  constructor(name: string) {
    super(`No secret named ${name}.`)
    this.name = 'SecretNotFoundError'
  }
}

/**
 * Decryption failed: the key is wrong, the file was edited, or a record was
 * moved between names/revisions. The message deliberately carries no detail
 * from the ciphertext or the key.
 */
export class SecretDecryptError extends Error {
  constructor(name: string) {
    super(`The stored value for ${name} could not be decrypted on this device.`)
    this.name = 'SecretDecryptError'
  }
}

export class SecretVaultCorruptError extends Error {
  constructor() {
    super('The secret vault file is not readable. Move it aside and re-add the secrets.')
    this.name = 'SecretVaultCorruptError'
  }
}

export function isSecretName(name: unknown): name is string {
  return typeof name === 'string' && SECRET_NAME_PATTERN.test(name)
}

export function secretPlaceholder(name: string): string {
  return `${SECRET_PLACEHOLDER_PREFIX}${name}}`
}

export function secretValueProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'The value is empty.'
  if (value.length < SECRET_VALUE_MIN)
    return `The value is shorter than ${SECRET_VALUE_MIN} characters, which cannot be redacted safely.`
  if (value.length > SECRET_VALUE_MAX)
    return `The value is longer than ${SECRET_VALUE_MAX} characters.`
  if (/[\u0000-\u001f\u007f]/.test(value))
    return 'The value contains a control character.'
  return null
}

/** Names referenced as `${secret:NAME}` in `text`, in first-seen order. */
export function secretNamesIn(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(/\$\{secret:([A-Z][A-Z0-9_]{1,63})\}/g)) {
    if (!names.includes(match[1]!)) names.push(match[1]!)
  }
  return names
}

/**
 * Which stored secrets a command actually references, by any of the three
 * spellings a model may write: `$NAME`, `${NAME}` or `${secret:NAME}`.
 * Only names that exist in the vault are returned, so an ordinary shell
 * variable is never confused with a secret.
 */
export function referencedSecretNames(
  command: string,
  available: readonly string[],
): string[] {
  return available.filter(
    (name) =>
      command.includes(`$${name}`) ||
      command.includes('${' + name + '}') ||
      command.includes('${secret:' + name + '}'),
  )
}

type StoredRecord = SecretRecord & {
  iv: string
  tag: string
  ciphertext: string
}

type VaultFile = { format: number; records: StoredRecord[] }

export type SecretsVaultOptions = {
  /** Directory holding the vault and its key. Created 0700 when absent. */
  directory: string
  /** Test seam. Production always uses the key file. */
  key?: Buffer
  /** Test seam for stable timestamps. */
  now?: () => Date
}

function aadFor(name: string, revision: number): Buffer {
  return Buffer.from(`${AAD_VERSION}\n${name}\n${revision}`, 'utf8')
}

/**
 * Everything the model is allowed to know about a secret. The value is not
 * part of this type on purpose.
 */
function publicRecord(record: StoredRecord): SecretRecord {
  const { iv: _iv, tag: _tag, ciphertext: _ciphertext, ...rest } = record
  return rest
}

export class SecretsVault {
  private readonly directory: string
  private readonly file: string
  private readonly keyFile: string
  private readonly key: Buffer
  private readonly now: () => Date
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(options: SecretsVaultOptions, key: Buffer) {
    this.directory = options.directory
    this.file = path.join(options.directory, VAULT_FILE)
    this.keyFile = path.join(options.directory, KEY_FILE)
    this.key = key
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Open a vault, creating its directory and data key on first use. The key
   * is 32 random bytes in a 0600 file, so the ciphertext is useless without
   * this machine's user account.
   */
  static async open(options: SecretsVaultOptions): Promise<SecretsVault> {
    await fs.mkdir(options.directory, { recursive: true, mode: 0o700 })
    const keyFile = path.join(options.directory, KEY_FILE)
    let key = options.key
    if (!key) {
      try {
        const encoded = (await fs.readFile(keyFile, 'utf8')).trim()
        key = Buffer.from(encoded, 'base64')
        if (key.length !== KEY_BYTES) throw new Error('bad key length')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
        const created = randomBytes(KEY_BYTES)
        try {
          await fs.writeFile(keyFile, created.toString('base64'), {
            mode: 0o600,
            flag: 'wx',
          })
          key = created
        } catch (writeError) {
          if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError
          key = Buffer.from((await fs.readFile(keyFile, 'utf8')).trim(), 'base64')
        }
      }
    }
    if (key.length !== KEY_BYTES) throw new SecretVaultCorruptError()
    return new SecretsVault(options, key)
  }

  /** Serialize every operation so concurrent callers cannot lose a write. */
  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async read(): Promise<StoredRecord[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new SecretVaultCorruptError()
    }
    const file = parsed as VaultFile
    if (
      !file ||
      typeof file !== 'object' ||
      file.format !== VAULT_FORMAT ||
      !Array.isArray(file.records)
    ) {
      throw new SecretVaultCorruptError()
    }
    return file.records.filter(
      (record): record is StoredRecord =>
        !!record &&
        typeof record.name === 'string' &&
        typeof record.ciphertext === 'string' &&
        typeof record.iv === 'string' &&
        typeof record.tag === 'string' &&
        typeof record.revision === 'number',
    )
  }

  private async write(records: StoredRecord[]): Promise<void> {
    const body: VaultFile = { format: VAULT_FORMAT, records }
    const temporary = path.join(
      this.directory,
      `.${VAULT_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
    )
    await fs.writeFile(temporary, JSON.stringify(body), { mode: 0o600 })
    await fs.rename(temporary, this.file)
  }

  private encrypt(name: string, revision: number, value: string) {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(aadFor(name, revision))
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ])
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }
  }

  private decrypt(record: StoredRecord): string {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(record.iv, 'base64'),
      )
      decipher.setAAD(aadFor(record.name, record.revision))
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      throw new SecretDecryptError(record.name)
    }
  }

  async list(): Promise<SecretRecord[]> {
    const records = await this.runExclusive(() => this.read())
    return records
      .map(publicRecord)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async add(input: { name: string; value: string }): Promise<SecretRecord> {
    if (!isSecretName(input.name)) throw new SecretNameError(input.name)
    const problem = secretValueProblem(input.value)
    if (problem) throw new SecretValueError(problem)
    return this.runExclusive(async () => {
      const records = await this.read()
      if (records.some((record) => record.name === input.name)) {
        throw new SecretExistsError(input.name)
      }
      const timestamp = this.now().toISOString()
      const record: StoredRecord = {
        name: input.name,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...this.encrypt(input.name, 1, input.value),
      }
      records.push(record)
      await this.write(records)
      return publicRecord(record)
    })
  }

  async rotate(input: { name: string; value: string }): Promise<SecretRecord> {
    if (!isSecretName(input.name)) throw new SecretNameError(input.name)
    const problem = secretValueProblem(input.value)
    if (problem) throw new SecretValueError(problem)
    return this.runExclusive(async () => {
      const records = await this.read()
      const index = records.findIndex((record) => record.name === input.name)
      if (index === -1) throw new SecretNotFoundError(input.name)
      const existing = records[index]!
      const revision = existing.revision + 1
      const record: StoredRecord = {
        name: existing.name,
        revision,
        createdAt: existing.createdAt,
        updatedAt: this.now().toISOString(),
        ...this.encrypt(existing.name, revision, input.value),
      }
      records[index] = record
      await this.write(records)
      return publicRecord(record)
    })
  }

  async remove(name: string): Promise<boolean> {
    if (!isSecretName(name)) throw new SecretNameError(name)
    return this.runExclusive(async () => {
      const records = await this.read()
      const next = records.filter((record) => record.name !== name)
      if (next.length === records.length) return false
      await this.write(next)
      return true
    })
  }

  async has(name: string): Promise<boolean> {
    const records = await this.runExclusive(() => this.read())
    return records.some((record) => record.name === name)
  }

  /**
   * Reveal a value. Boundary code only: never call this to build a prompt, a
   * log line, or anything the model can read. Use `redactSecretText` on the
   * way back.
   */
  async reveal(name: string): Promise<string> {
    if (!isSecretName(name)) throw new SecretNameError(name)
    const records = await this.runExclusive(() => this.read())
    const record = records.find((entry) => entry.name === name)
    if (!record) throw new SecretNotFoundError(name)
    return this.decrypt(record)
  }

  /** Record that a boundary used the secret. No effect on expiry (there is none). */
  async markUsed(name: string): Promise<void> {
    if (!isSecretName(name)) return
    await this.runExclusive(async () => {
      const records = await this.read()
      const index = records.findIndex((record) => record.name === name)
      if (index === -1) return
      records[index] = { ...records[index]!, lastUsedAt: this.now().toISOString() }
      await this.write(records)
    })
  }
}

// ---------------------------------------------------------------- redaction

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!
    const b = bytes[index + 1]
    const c = bytes[index + 2]
    out += BASE64_ALPHABET[a >> 2]
    out += BASE64_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : BASE64_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : BASE64_ALPHABET[c & 63]
  }
  return out
}

/** Every spelling a value commonly takes when printed or encoded. */
function spellings(value: string): string[] {
  const encoded = base64(value)
  const unpadded = encoded.replace(/=+$/, '')
  const found = new Set<string>([
    value,
    encodeURIComponent(value),
    encoded,
    unpadded,
    unpadded.replace(/\+/g, '-').replace(/\//g, '_'),
  ])
  return [...found]
    .filter((entry) => entry.length >= SECRET_VALUE_MIN)
    .sort((a, b) => b.length - a.length)
}

function replaceAll(text: string, needle: string, replacement: string): string {
  return needle ? text.split(needle).join(replacement) : text
}

/** Replace every spelling of every value with `[secret:NAME]`. */
export function redactSecretText(
  text: string,
  secrets: readonly RevealedSecret[],
): string {
  if (secrets.length === 0 || !text) return text
  let out = text
  for (const secret of secrets) {
    const placeholder = `[secret:${secret.name}]`
    for (const spelling of spellings(secret.value)) {
      out = replaceAll(out, spelling, placeholder)
    }
  }
  return out
}

const REDACT_MAX_DEPTH = 32

/** Redact every string inside a tool result before the model reads it. */
export function redactSecretDeep<T>(
  value: T,
  secrets: readonly RevealedSecret[],
): T {
  if (secrets.length === 0) return value
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') return redactSecretText(node, secrets)
    if (node === null || typeof node !== 'object') return node
    if (depth > REDACT_MAX_DEPTH) return '[secret: nested too deeply to check]'
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1))
    const proto = Object.getPrototypeOf(node)
    if (proto !== Object.prototype && proto !== null) return node
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      out[redactSecretText(key, secrets)] = walk(item, depth + 1)
    }
    return out
  }
  return walk(value, 0) as T
}

// ----------------------------------------------------------------- boundary

export class SecretBoundaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretBoundaryError'
  }
}

/** Loopback only: the substitution boundary's one allowed destination shape. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  )
}

export function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname)
  } catch {
    return false
  }
}

/**
 * Replace `${secret:NAME}` in text with the value. Boundary use only: the
 * result must never be shown to, or stored where the model can read it.
 */
export async function resolveSecretRefs(input: {
  text: string
  vault: SecretsVault
  markUsed?: boolean
}): Promise<{ text: string; revealed: RevealedSecret[] }> {
  const names = secretNamesIn(input.text)
  if (names.length === 0) return { text: input.text, revealed: [] }
  const revealed: RevealedSecret[] = []
  let out = input.text
  for (const name of names) {
    const value = await input.vault.reveal(name)
    revealed.push({ name, value })
    out = out.split(secretPlaceholder(name)).join(value)
    if (input.markUsed !== false) await input.vault.markUsed(name)
  }
  return { text: out, revealed }
}

/**
 * The environment a tool process receives. The model writes the command; the
 * values are added here, after the model is done, and only for names the
 * command actually references. Existing variables are never overwritten.
 */
export async function injectSecretEnv(input: {
  vault: SecretsVault
  names: readonly string[]
  baseEnv: Readonly<Record<string, string | undefined>>
}): Promise<{ env: Record<string, string | undefined>; revealed: RevealedSecret[] }> {
  const env: Record<string, string | undefined> = { ...input.baseEnv }
  const revealed: RevealedSecret[] = []
  for (const name of input.names) {
    if (!isSecretName(name)) throw new SecretNameError(name)
    if (env[name] !== undefined) {
      throw new SecretBoundaryError(
        `Refusing to overwrite ${name}, which the tool environment already sets.`,
      )
    }
    const value = await input.vault.reveal(name)
    env[name] = value
    revealed.push({ name, value })
    await input.vault.markUsed(name)
  }
  return { env, revealed }
}

/**
 * Substitute references into an outbound request, but ONLY for a loopback
 * destination. A remote host is refused before any value is read, so a secret
 * cannot be sent to Freebuff's servers or any other machine by mistake. The
 * error names the variables, never their values.
 */
export async function resolveForOutbound(input: {
  url: string
  headers?: Readonly<Record<string, string>>
  body?: string
  vault: SecretsVault
  /** Extra hosts an operator explicitly trusts. Loopback is always allowed. */
  allowHosts?: readonly string[]
}): Promise<{
  url: string
  headers: Record<string, string>
  body?: string
  revealed: RevealedSecret[]
}> {
  const url = new URL(input.url)
  const allowed =
    isLoopbackHostname(url.hostname) ||
    (input.allowHosts ?? []).some(
      (host) => host.toLowerCase() === url.hostname.toLowerCase(),
    )
  const referenced = [
    ...secretNamesIn(input.url),
    ...secretNamesIn(JSON.stringify(input.headers ?? {})),
    ...secretNamesIn(input.body ?? ''),
  ]
  if (!allowed) {
    throw new SecretBoundaryError(
      referenced.length > 0
        ? `Refusing to resolve ${referenced.join(', ')} for ${url.hostname}: a secret value may only leave the device to a loopback endpoint.`
        : `Refusing an outbound secret substitution to ${url.hostname}: a secret value may only leave the device to a loopback endpoint.`,
    )
  }
  const revealed: RevealedSecret[] = []
  const substitute = async (text: string): Promise<string> => {
    if (!text.includes(SECRET_PLACEHOLDER_PREFIX)) return text
    const result = await resolveSecretRefs({ text, vault: input.vault })
    revealed.push(...result.revealed)
    return result.text
  }
  const resolvedUrl = await substitute(input.url)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name] = await substitute(value)
  }
  return {
    url: resolvedUrl,
    headers,
    ...(input.body === undefined ? {} : { body: await substitute(input.body) }),
    revealed,
  }
}
