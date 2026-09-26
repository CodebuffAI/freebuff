/**
 * Credentials a local sponsored run may be handed by the user (COD-665).
 *
 * A campaign's reviewed procedure may DECLARE the account credential it needs:
 *
 *     requires-credential: env=SIEVE_API_KEY label="Sieve API key" get_url=https://sieve.example/keys
 *
 * After Accept and before the run's turn starts, Desktop asks the user for it
 * in a masked field ("Connect your <advertiser> account"), with a link to
 * `get_url` and a Skip. The value is held in memory for that one run, injected
 * ONLY as the declared environment variable into the run's terminal commands,
 * and redacted from anything the model reads. The model is told the variable
 * exists, never its value.
 *
 * The declaration rides INSIDE the procedure text, beside `outcomes:` and
 * `reviewed-cli:`, for the same reason they do: the text is what the
 * advertiser writes, what we review, and what the SHA-256 the user consents to
 * covers. A declaration outside it could change without the campaign going
 * back to review; this one cannot.
 *
 * Strict by design. A malformed line declares NOTHING (a typo in advertiser
 * text must neither fail a run nor widen what it receives). Pure and
 * dependency-free, so every surface can call it.
 */

export type SponsoredRunCredential = {
  /** The environment variable the value is injected as. */
  env: string
  /** What the field is called, e.g. "Sieve API key". */
  label: string
  /** Where the user gets one (signup, device login or the key page). https only. */
  getUrl?: string
}

export const SPONSORED_RUN_CREDENTIAL_DIRECTIVE = 'requires-credential:'

/** More than this is not "the account the procedure needs". */
export const SPONSORED_RUN_CREDENTIAL_MAX = 2

const DIRECTIVE_LINE = /^\s*requires-credential\s*:\s*(.*?)\s*$/i
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/
const ENV_NAME_MAX = 64
const LABEL_MAX = 60
const URL_MAX = 2048
const KNOWN_KEYS = new Set(['env', 'label', 'get_url'])

/**
 * An ALLOWLIST of shapes, never a denylist of dangerous names: a declared
 * variable must end like a credential. That alone makes it impossible to
 * declare `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `BASH_ENV` or anything else a
 * loader or interpreter reads, because none of those end this way.
 */
const CREDENTIAL_SUFFIX = /_(KEY|TOKEN|SECRET|PASSWORD)$/

/**
 * Prefixes that name the USER's platform credentials or our own machinery,
 * not an advertiser account. "Connect your Sieve account" must never become a
 * field asking for a GitHub token or an AWS key.
 */
const RESERVED_PREFIXES: readonly string[] = Object.freeze([
  'AWS_',
  'GH_',
  'GITHUB_',
  'NPM_',
  'OPENAI_',
  'ANTHROPIC_',
  'GEMINI_',
  'GIT_',
  'SSH_',
  'GCM_',
  'CODEBUFF_',
  'FREEBUFF_',
])

/** Whether `name` may be declared, injected and redacted as a run credential. */
export function isSponsoredCredentialEnvName(name: unknown): name is string {
  if (typeof name !== 'string') return false
  if (name.length > ENV_NAME_MAX || !ENV_NAME.test(name)) return false
  const match = CREDENTIAL_SUFFIX.exec(name)
  // Something before the suffix: `_KEY` alone names no account.
  if (!match || match.index < 2) return false
  return !RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))
}

function validLabel(label: string): boolean {
  return (
    label.length > 0 &&
    label.length <= LABEL_MAX &&
    label.trim() === label &&
    // Printable only: no control characters, no quotes that would end the
    // token, no angle brackets for a surface that forgets to escape.
    /^[^\u0000-\u001f\u007f"<>\\]+$/.test(label)
  )
}

/** An https URL with no userinfo, or null. */
export function sponsoredCredentialGetUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > URL_MAX)
    return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (!url.hostname) return null
  return url.toString()
}

/**
 * `key=value` pairs, a value double-quoted when it has spaces. Anything else
 * on the line (a stray word, an unterminated quote) is null.
 */
function tokenize(value: string): Map<string, string> | null {
  const pairs = new Map<string, string>()
  const pair = /\s*([a-z_]+)=(?:"([^"]*)"|([^\s"]+))/y
  let index = 0
  while (index < value.length) {
    if (/^\s*$/.test(value.slice(index))) break
    pair.lastIndex = index
    const match = pair.exec(value)
    if (!match) return null
    const key = match[1]!
    if (!KNOWN_KEYS.has(key) || pairs.has(key)) return null
    pairs.set(key, match[2] ?? match[3] ?? '')
    index = pair.lastIndex
    // Pairs are separated by whitespace, never glued together.
    if (index < value.length && !/\s/.test(value[index]!)) return null
  }
  return pairs
}

/** `env=<NAME> label=<label> [get_url=https://…]`, or null for anything else. */
export function parseRunCredentialDeclaration(
  value: string,
): SponsoredRunCredential | null {
  const pairs = tokenize(value)
  if (!pairs) return null
  const env = pairs.get('env')
  const label = pairs.get('label')
  if (!isSponsoredCredentialEnvName(env)) return null
  if (label === undefined || !validLabel(label)) return null
  const rawUrl = pairs.get('get_url')
  let getUrl: string | undefined
  if (rawUrl !== undefined) {
    const checked = sponsoredCredentialGetUrl(rawUrl)
    if (!checked) return null
    getUrl = checked
  }
  return { env, label, ...(getUrl ? { getUrl } : {}) }
}

/**
 * What a procedure declares, in declaration order, at most
 * {@link SPONSORED_RUN_CREDENTIAL_MAX}. A name declared twice with different
 * fields is AMBIGUOUS and declares nothing, rather than whichever came first.
 */
export function declaredRunCredentials(
  procedure: string | null | undefined,
): SponsoredRunCredential[] {
  if (typeof procedure !== 'string') return []
  const parsed: SponsoredRunCredential[] = []
  for (const line of procedure.split(/\r?\n/)) {
    const match = DIRECTIVE_LINE.exec(line)
    if (!match) continue
    const credential = parseRunCredentialDeclaration(match[1]!)
    if (credential) parsed.push(credential)
  }
  return canonicalRunCredentials(parsed)
}

/**
 * The list off a stored run record, re-validated. The record is local JSON, so
 * every entry goes back through the same rules the procedure did.
 */
export function normalizeRunCredentials(
  value: unknown,
): SponsoredRunCredential[] {
  if (!Array.isArray(value)) return []
  const parsed: SponsoredRunCredential[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const { env, label, getUrl } = entry as Record<string, unknown>
    if (!isSponsoredCredentialEnvName(env)) continue
    if (typeof label !== 'string' || !validLabel(label)) continue
    if (getUrl !== undefined) {
      const checked = sponsoredCredentialGetUrl(getUrl)
      if (!checked) continue
      parsed.push({ env, label, getUrl: checked })
    } else {
      parsed.push({ env, label })
    }
  }
  return canonicalRunCredentials(parsed)
}

function canonicalRunCredentials(
  parsed: readonly SponsoredRunCredential[],
): SponsoredRunCredential[] {
  const byName = new Map<string, SponsoredRunCredential | null>()
  for (const credential of parsed) {
    const seen = byName.get(credential.env)
    if (seen === undefined) byName.set(credential.env, credential)
    else if (
      seen &&
      (seen.label !== credential.label || seen.getUrl !== credential.getUrl)
    )
      byName.set(credential.env, null)
  }
  return [...byName.values()]
    .filter((credential): credential is SponsoredRunCredential =>
      Boolean(credential),
    )
    .slice(0, SPONSORED_RUN_CREDENTIAL_MAX)
}

// ------------------------------------------------------------------ values

export const SPONSORED_CREDENTIAL_VALUE_MIN = 8
export const SPONSORED_CREDENTIAL_VALUE_MAX = 4096

/**
 * Why a value the user typed cannot be used, or null when it can. Keys and
 * tokens are one printable word; anything with whitespace or a control
 * character is a paste gone wrong, and a very short one could not be redacted
 * from output without redacting ordinary text too.
 */
export function sponsoredCredentialValueProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'empty'
  if (value.length < SPONSORED_CREDENTIAL_VALUE_MIN) return 'too_short'
  if (value.length > SPONSORED_CREDENTIAL_VALUE_MAX) return 'too_long'
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return 'invalid_characters'
  return null
}

// ------------------------------------------------------------- environment

/**
 * The run's environment with its credentials added, AFTER the sponsored scrub
 * has built it and asserted it credential-free.
 *
 * `scrubbed` is the scrub's output and is not mutated, and the scrub's own
 * credential-shape assertion has already run over it. The one exception to
 * that assertion is made here, and made exactly:
 *
 *  - every injected name must pass {@link isSponsoredCredentialEnvName};
 *  - an injected name may not overwrite (in any letter case) a variable the
 *    scrub set: `HOME`, `GIT_CONFIG_*`, `PATH`, ...;
 *  - every value must pass {@link sponsoredCredentialValueProblem};
 *  - afterwards, the keys the result has beyond the scrub's are exactly the
 *    injected names, and nothing else rode along.
 *
 * With no credentials the result is the scrub's output, key for key.
 */
export function withSponsoredRunCredentialEnv(
  scrubbed: Readonly<Record<string, string>>,
  credentials: Readonly<Record<string, string>> | null | undefined,
): Record<string, string> {
  const env: Record<string, string> = { ...scrubbed }
  const entries = Object.entries(credentials ?? {})
  if (entries.length === 0) return env
  const existing = new Map(
    Object.keys(scrubbed).map((key) => [key.toUpperCase(), key]),
  )
  const injected = new Set<string>()
  for (const [name, value] of entries) {
    if (!isSponsoredCredentialEnvName(name)) {
      throw new Error(
        `Refusing to inject \`${name}\` into a sponsored run: it is not a declarable credential name.`,
      )
    }
    const clash = existing.get(name.toUpperCase())
    if (clash !== undefined) {
      throw new Error(
        `Refusing to inject \`${name}\` into a sponsored run: the run's environment already sets \`${clash}\`.`,
      )
    }
    if (sponsoredCredentialValueProblem(value) !== null) {
      throw new Error(
        `Refusing to inject \`${name}\` into a sponsored run: its value is not usable.`,
      )
    }
    env[name] = value
    injected.add(name)
  }
  const added = Object.keys(env).filter((key) => !(key in scrubbed))
  if (
    added.length !== injected.size ||
    added.some((key) => !injected.has(key))
  ) {
    throw new Error(
      'Sponsored run env gained a variable that was not declared for this run.',
    )
  }
  return env
}

// --------------------------------------------------------------- redaction

export type SponsoredRedactableSecret = { name: string; value: string }

/** What a redacted value reads as, in every surface the model can see. */
export function sponsoredCredentialPlaceholder(name: string): string {
  return `[redacted:${name}]`
}

/**
 * The truncation marker `runTerminalCommand` puts between the head and tail of
 * long output. The cut can split a value, leaving a prefix of it before the
 * marker and a suffix after, so fragments beside it are redacted too.
 */
export const SPONSORED_OUTPUT_TRUNCATION_TEXT = '[...TRUNCATED DUE TO LENGTH...]'

/**
 * Every place a sponsored tool cuts its output, so a value can be split:
 * the terminal's head/tail marker, `code_search`'s stdout and stderr caps,
 * and the `read_files` limiter's `[FILE_TOO_LARGE]` notice. A fragment of any
 * spelling beside one of these is redacted, and so is one at the very start
 * or end of a string (a cap that cuts without a marker).
 */
export const SPONSORED_OUTPUT_CUT_MARKERS: readonly string[] = Object.freeze([
  SPONSORED_OUTPUT_TRUNCATION_TEXT,
  '[Output truncated]',
  '[Error output truncated]',
  '[FILE_TOO_LARGE]',
])

/** The shortest fragment beside a truncation marker that is still redacted. */
const FRAGMENT_MIN = 4
/**
 * The shortest fragment at a bare string edge that is redacted. Longer than
 * beside a marker because there is no marker to say a cut happened there.
 */
const EDGE_FRAGMENT_MIN = SPONSORED_CREDENTIAL_VALUE_MIN

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64Bytes(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += BASE64_ALPHABET[a >> 2]
    out += BASE64_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out +=
      b === undefined ? '=' : BASE64_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : BASE64_ALPHABET[c & 63]
  }
  return out
}

/**
 * The base64 characters that depend ONLY on the value's bytes when the value
 * sits `offset` bytes into a larger encoded string -- which is how a key
 * usually appears in base64: `Authorization: Basic base64("user:" + key)`.
 * Base64 works in 3-byte groups, so the encoding of the value alone
 * (`offset` 0) matches only when the value starts on a group boundary and
 * ends the string; these three cores cover every alignment. The few
 * characters at either end that mix in neighbouring bytes are left, and
 * carry at most a couple of bits of the value.
 */
function alignedBase64Cores(bytes: Uint8Array): string[] {
  const cores: string[] = []
  for (let offset = 0; offset < 3; offset++) {
    const padded = new Uint8Array(offset + bytes.length)
    padded.set(bytes, offset)
    const encoded = base64Bytes(padded)
    const firstGroup = Math.ceil(offset / 3)
    const endGroup = Math.floor((offset + bytes.length) / 3)
    if (endGroup > firstGroup) {
      cores.push(encoded.slice(firstGroup * 4, endGroup * 4))
    }
  }
  return cores
}

const toBase64Url = (value: string) =>
  value.replace(/\+/g, '-').replace(/\//g, '_')

/**
 * Every spelling of a value that a command commonly prints: the raw value,
 * URL-encoded (query strings, `curl -v`), and base64 / base64url at every
 * byte alignment (Basic auth, JWT-style tooling). Longest first, so a longer
 * spelling is replaced before a shorter one that it contains.
 */
function spellings(value: string): string[] {
  const bytes = new TextEncoder().encode(value)
  const b64 = base64Bytes(bytes)
  const unpadded = b64.replace(/=+$/, '')
  const found = new Set<string>([
    value,
    encodeURIComponent(value),
    b64,
    unpadded,
    toBase64Url(unpadded),
  ])
  for (const core of alignedBase64Cores(bytes)) {
    found.add(core)
    found.add(toBase64Url(core))
  }
  return [...found]
    .filter((spelling) => spelling.length >= SPONSORED_CREDENTIAL_VALUE_MIN)
    .sort((a, b) => b.length - a.length)
}

type PreparedSecret = { placeholder: string; spellings: string[] }

function prepare(
  secrets: readonly SponsoredRedactableSecret[],
): PreparedSecret[] {
  return secrets.map((secret) => ({
    placeholder: sponsoredCredentialPlaceholder(secret.name),
    spellings: spellings(secret.value),
  }))
}

function replaceAll(text: string, needle: string, replacement: string): string {
  return needle ? text.split(needle).join(replacement) : text
}

/** `text` with every declared secret's spellings replaced by its placeholder. */
function redactWhole(text: string, secrets: readonly PreparedSecret[]): string {
  let out = text
  for (const secret of secrets) {
    for (const spelling of secret.spellings) {
      out = replaceAll(out, spelling, secret.placeholder)
    }
  }
  return out
}

/**
 * A trailing prefix of any spelling of a secret at the end of `text` (before
 * the whitespace a marker is framed by), redacted. The longest match wins.
 */
function redactTrailingFragment(
  text: string,
  secrets: readonly PreparedSecret[],
  min: number,
): string {
  const body = text.replace(/\s+$/, '')
  const space = text.slice(body.length)
  let best: { length: number; placeholder: string } | null = null
  for (const secret of secrets) {
    for (const spelling of secret.spellings) {
      const top = Math.min(spelling.length - 1, body.length)
      for (let length = top; length >= min; length--) {
        if (best && length <= best.length) break
        if (body.endsWith(spelling.slice(0, length))) {
          best = { length, placeholder: secret.placeholder }
          break
        }
      }
    }
  }
  if (!best) return text
  return `${body.slice(0, body.length - best.length)}${best.placeholder}${space}`
}

/** A leading suffix of any spelling of a secret at the start of `text`, redacted. */
function redactLeadingFragment(
  text: string,
  secrets: readonly PreparedSecret[],
  min: number,
): string {
  const body = text.replace(/^\s+/, '')
  const space = text.slice(0, text.length - body.length)
  let best: { length: number; placeholder: string } | null = null
  for (const secret of secrets) {
    for (const spelling of secret.spellings) {
      const top = Math.min(spelling.length - 1, body.length)
      for (let length = top; length >= min; length--) {
        if (best && length <= best.length) break
        if (body.startsWith(spelling.slice(spelling.length - length))) {
          best = { length, placeholder: secret.placeholder }
          break
        }
      }
    }
  }
  if (!best) return text
  return `${space}${best.placeholder}${body.slice(best.length)}`
}

const CUT_MARKER_PATTERN = new RegExp(
  `(${SPONSORED_OUTPUT_CUT_MARKERS.map((marker) =>
    marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('|')})`,
)

/**
 * `text` with every secret redacted, including the pieces of any spelling of
 * one that an output cut split in two.
 */
export function redactSponsoredCredentialText(
  text: string,
  secrets: readonly SponsoredRedactableSecret[],
): string {
  const usable = secrets.filter(
    (secret) => sponsoredCredentialValueProblem(secret.value) === null,
  )
  if (usable.length === 0 || text.length === 0) return text
  const prepared = prepare(usable)
  // Odd indexes are the markers themselves (the split pattern captures).
  const parts = text.split(CUT_MARKER_PATTERN)
  const last = parts.length - 1
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part
      let out = redactWhole(part, prepared)
      out = redactTrailingFragment(
        out,
        prepared,
        index < last ? FRAGMENT_MIN : EDGE_FRAGMENT_MIN,
      )
      out = redactLeadingFragment(
        out,
        prepared,
        index > 0 ? FRAGMENT_MIN : EDGE_FRAGMENT_MIN,
      )
      return out
    })
    .join('')
}

/**
 * Every string inside a tool result (arrays, plain objects, nested) redacted.
 * Object KEYS are redacted too: a JSON map keyed by an output line is still
 * output. Anything that is not a string, array or plain object is returned as
 * it is.
 */
export function redactSponsoredCredentialDeep<T>(
  value: T,
  secrets: readonly SponsoredRedactableSecret[],
): T {
  if (secrets.length === 0) return value
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') return redactSponsoredCredentialText(node, secrets)
    if (depth > 32 || node === null || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1))
    const proto = Object.getPrototypeOf(node)
    if (proto !== Object.prototype && proto !== null) return node
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      out[redactSponsoredCredentialText(key, secrets)] = walk(item, depth + 1)
    }
    return out
  }
  return walk(value, 0) as T
}
