/**
 * The rule for a RUNTIME override of the Codebuff app URL (`CODEBUFF_APP_URL`
 * / `NEXT_PUBLIC_CODEBUFF_APP_URL` read from `process.env` after the build).
 *
 * Every SDK call that carries the user's bearer token — model completions,
 * `/me`, agent runs, the registry, composio — is addressed to this URL, so a
 * process that can set one env var for the CLI (a directory's `.envrc`, a
 * shared machine, CI) could point the whole credential-bearing plane, over
 * plain `http:`, at a host of its choosing. The override exists for remote
 * hosts that bundle the SDK with a dev URL inlined; those are https. The only
 * legitimate http case is a developer's own stack on the loopback interface.
 *
 * Pure and dependency-free so the SDK and Freebuff Desktop (whose `hosts.ts`
 * reads the same variable at module load on a repo launch) apply one rule.
 */

/**
 * The variables, in precedence order, through which a runtime may override the
 * app URL. Shared so the SDK resolver and the release smoke test agree.
 */
export const RUNTIME_APP_URL_ENV_VARS = [
  'NEXT_PUBLIC_CODEBUFF_APP_URL',
  'CODEBUFF_APP_URL',
] as const

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Registrable domains that serve the Codebuff API. A runtime override to one
 * of these, or to a subdomain of one, needs no opt-in.
 */
export const FIRST_PARTY_APP_DOMAINS = ['codebuff.com', 'freebuff.com'] as const

/**
 * Explicit opt-in for a runtime app URL on a host that is neither first-party
 * nor loopback (a self-hosted backend, a staging box on another domain). It is
 * deliberately a separate variable from the URL itself: whatever can inject
 * the URL into the environment of a process — a repository's `.envrc` through
 * the CLI's direnv import, which drops every `CODEBUFF_*` name — should not be
 * able to vouch for it in the same breath.
 */
export const ALLOW_CUSTOM_APP_URL_ENV_VAR = 'CODEBUFF_ALLOW_CUSTOM_APP_URL'

/** `true` for the values of {@link ALLOW_CUSTOM_APP_URL_ENV_VAR} that opt in. */
export function isCustomAppUrlOptIn(value: string | undefined): boolean {
  if (value === undefined) return false
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase())
}

function normalizeHostname(url: URL): string {
  // WHATWG URL keeps the brackets on an IPv6 literal (`[::1]`).
  return url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')
}

/**
 * `true` for `https:` on any host, and for `http:` only on `localhost`,
 * `127.0.0.1`, `[::1]` or a `*.localhost` name. Anything else — plain http to
 * a remote host, another scheme, or a value that does not parse — is refused
 * and the caller keeps its bundled URL.
 */
export function isAllowedRuntimeAppUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return isLoopbackHostname(normalizeHostname(url))
}

/**
 * `true` when an override that already passes {@link isAllowedRuntimeAppUrl}
 * also points at a host that may receive the user's credential without an
 * opt-in: a first-party domain (or subdomain) over https, or loopback.
 *
 * {@link isAllowedRuntimeAppUrl} stops a plain-http downgrade but still let any
 * `https://attacker.example` through, and an attacker can get a certificate for
 * their own host as easily as anyone. Callers that attach the user's bearer
 * token pair this check with {@link ALLOW_CUSTOM_APP_URL_ENV_VAR}.
 */
export function isFirstPartyRuntimeAppUrl(value: string): boolean {
  if (!isAllowedRuntimeAppUrl(value)) return false
  const url = new URL(value)
  const hostname = normalizeHostname(url)
  if (isLoopbackHostname(hostname)) return true
  if (url.protocol !== 'https:') return false
  return FIRST_PARTY_APP_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  )
}

/**
 * `protocol//host` of a rejected value for a warning line — never the full
 * URL, which may carry a path or query the operator did not mean to log.
 */
export function describeRuntimeAppUrlOrigin(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`
  } catch {
    return 'unparseable value'
  }
}
