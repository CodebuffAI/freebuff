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
  // WHATWG URL keeps the brackets on an IPv6 literal (`[::1]`).
  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')
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
