/**
 * Instant setup, and pre-filled sign-up links (COD-830).
 *
 * The biggest single drop-off in a sponsored run is the account step: the run
 * reaches a command that needs the advertiser's API key and the user has no
 * account yet. Two ways to shorten it, both OPTIONAL for the advertiser:
 *
 * 1. INSTANT SETUP. The reviewed procedure declares an endpoint the advertiser
 *    hosts:
 *
 *        requires-credential: env=SIEVE_API_KEY label="Sieve API key" get_url=https://sieve.example/signup?bfcid={bfcid}
 *        instant-setup: env=SIEVE_API_KEY endpoint=https://api.sieve.example/freebuff/instant-setup
 *
 *    When the run reaches the account step and the user agrees, freebuff.com
 *    signs a short-lived identity assertion for that exact endpoint, Desktop
 *    POSTs it there, and the advertiser answers with an API key. The key takes
 *    the same path a pasted one does (held in memory for the run, injected
 *    only as the declared variable, redacted from model output). Anything
 *    other than a valid key falls back to the ordinary sign-up step. The
 *    public spec is `docs/ads/agentic/instant-setup.md`.
 *
 * 2. PRE-FILLED SIGN-UP. The tracked sign-up link may carry an `{email}` slot
 *    as a whole query value (`?email={email}&bfcid={bfcid}`). With the user's
 *    explicit yes for that run it is filled with their email; otherwise the
 *    parameter is REMOVED, so the email never reaches a URL we do not control
 *    without consent.
 *
 * Both declarations ride inside the procedure text for the reason
 * `requires-credential:` does: the text is what we review and what the user's
 * SHA-256 consent covers. Pure and dependency-free.
 */

import {
  declaredRunCredentials,
  isSponsoredCredentialEnvName,
  sponsoredCredentialGetUrl,
  sponsoredCredentialValueProblem,
  tokenizeSponsoredDirective,
} from './sponsored-run-credentials'

export type SponsoredInstantSetup = {
  /** The declared credential the minted key is injected as. */
  env: string
  /** The advertiser's endpoint. https, no userinfo, no fragment. */
  endpoint: string
}

const DIRECTIVE_LINE = /^\s*instant-setup\s*:\s*(.*?)\s*$/i
const KNOWN_KEYS: ReadonlySet<string> = new Set(['env', 'endpoint'])

/** The JWT `typ` header of the assertion, so it can never pass as an id token. */
export const INSTANT_SETUP_ASSERTION_TYPE = 'freebuff-instant-setup+jwt'
/** The assertion's lifetime. Long enough for one POST, short enough to be useless later. */
export const INSTANT_SETUP_ASSERTION_TTL_SECONDS = 300
/** How long Desktop waits for the advertiser's answer before falling back. */
export const INSTANT_SETUP_REQUEST_TIMEOUT_MS = 15_000
/** The largest response body Desktop reads from the advertiser. */
export const INSTANT_SETUP_RESPONSE_MAX_BYTES = 16 * 1024

/** `env=<NAME> endpoint=https://…`, or null for anything else. */
export function parseInstantSetupDeclaration(
  value: string,
): SponsoredInstantSetup | null {
  const pairs = tokenizeSponsoredDirective(value, KNOWN_KEYS)
  if (!pairs) return null
  const env = pairs.get('env')
  const rawEndpoint = pairs.get('endpoint')
  if (!isSponsoredCredentialEnvName(env) || rawEndpoint === undefined)
    return null
  const endpoint = sponsoredCredentialGetUrl(rawEndpoint)
  if (!endpoint || new URL(endpoint).hash) return null
  // A template slot in the endpoint would make the URL we sign for differ
  // from the URL that was reviewed.
  if (/[{}]|%7B|%7D/i.test(rawEndpoint)) return null
  return { env, endpoint }
}

/**
 * The procedure's instant setup, or null.
 *
 * Null unless there is exactly ONE `instant-setup:` line and the procedure
 * declares exactly one credential, of the same name: the endpoint mints one
 * key, and the vault only starts a run with every declared value present. A
 * second line, even an identical one, is ambiguous and declares nothing.
 */
export function declaredInstantSetup(
  procedure: string | null | undefined,
): SponsoredInstantSetup | null {
  if (typeof procedure !== 'string') return null
  const lines = procedure
    .split(/\r?\n/)
    .map((line) => DIRECTIVE_LINE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
  if (lines.length !== 1) return null
  const setup = parseInstantSetupDeclaration(lines[0]![1]!)
  if (!setup) return null
  const credentials = declaredRunCredentials(procedure)
  if (credentials.length !== 1 || credentials[0]!.env !== setup.env) return null
  return setup
}

// ------------------------------------------------------------------ response

export type InstantSetupKey = {
  apiKey: string
  /** What the advertiser says the key may do, for the run's log. */
  scope?: string
  /** Seconds until the key stops working, when the advertiser said. */
  expiresInSeconds?: number
  /** Whether the advertiser created an account or found one for this email. */
  account?: 'created' | 'existing'
}

const SCOPE_MAX = 200
const EXPIRES_MAX_SECONDS = 365 * 24 * 60 * 60

/**
 * The advertiser's `200` body, validated, or null. Unknown fields are
 * ignored; a missing or unusable `api_key` is null, and so is a malformed
 * optional field (an endpoint that cannot say what it means is not trusted
 * with the rest).
 */
export function parseInstantSetupResponse(
  body: unknown,
): InstantSetupKey | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  const apiKey =
    typeof record.api_key === 'string' ? record.api_key.trim() : undefined
  if (apiKey === undefined || sponsoredCredentialValueProblem(apiKey) !== null)
    return null
  const key: InstantSetupKey = { apiKey }
  if (record.scope !== undefined && record.scope !== null) {
    if (
      typeof record.scope !== 'string' ||
      record.scope.length > SCOPE_MAX ||
      /[\u0000-\u001f\u007f]/.test(record.scope)
    )
      return null
    key.scope = record.scope
  }
  if (record.expires_in !== undefined && record.expires_in !== null) {
    if (
      typeof record.expires_in !== 'number' ||
      !Number.isInteger(record.expires_in) ||
      record.expires_in <= 0 ||
      record.expires_in > EXPIRES_MAX_SECONDS
    )
      return null
    key.expiresInSeconds = record.expires_in
  }
  if (record.account !== undefined && record.account !== null) {
    if (record.account !== 'created' && record.account !== 'existing')
      return null
    key.account = record.account
  }
  return key
}

// ------------------------------------------------------------ email pre-fill

export const SIGNUP_EMAIL_PLACEHOLDER = '{email}'
const EMAIL_SLOT = /^(?:\{email\}|%7Bemail%7D)$/i
const EMAIL_SHAPE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}$/

/** Whether a sign-up URL offers an `{email}` query slot we can fill or remove. */
export function signupUrlHasEmailSlot(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    return [...new URL(url).searchParams.values()].some((value) =>
      EMAIL_SLOT.test(value),
    )
  } catch {
    return false
  }
}

/**
 * The sign-up URL with its `{email}` slot filled, or with that parameter
 * removed when `email` is null (no consent, or no usable address). Returns
 * null when the URL cannot be parsed, or when `{email}` appears anywhere
 * except as a whole query value: a slot we cannot remove cleanly must not be
 * opened at all.
 */
export function signupUrlWithEmail(
  url: string,
  email: string | null,
): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const slotted = [...parsed.searchParams.entries()].filter(([, value]) =>
    EMAIL_SLOT.test(value),
  )
  const outside = new URL(parsed.toString())
  for (const [name] of slotted) outside.searchParams.delete(name)
  if (/\{email\}|%7Bemail%7D/i.test(outside.toString())) return null
  if (slotted.length === 0) return parsed.toString()
  const usable = email !== null && EMAIL_SHAPE.test(email) ? email : null
  if (usable === null) return outside.toString()
  for (const [name] of slotted) parsed.searchParams.set(name, usable)
  return parsed.toString()
}
