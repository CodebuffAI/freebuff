/**
 * Which build of which client accepted a sponsored proposal, as a closed,
 * bounded string: `desktop/<version>` or `cli/<version>`.
 *
 * Without it the funnel cannot tell whether a failure came from a build that
 * already carries a fix or from one that predates it. It is derived from the user agent each client
 * already sends -- `Freebuff-Desktop/<v>` and `Freebuff-CLI/<v>` -- rather
 * than a new body field, so nothing a client types reaches the funnel
 * verbatim.
 */

/** `dev` builds are kept on purpose: a strict semver pattern would drop them. */
export const SPONSORED_CLIENT_VERSION_PATTERN =
  /^(desktop|cli)\/[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/

const USER_AGENT_PREFIXES: ReadonlyArray<readonly [string, 'desktop' | 'cli']> =
  [
    ['Freebuff-Desktop/', 'desktop'],
    ['Freebuff-CLI/', 'cli'],
  ]

/**
 * `Freebuff-Desktop/0.0.151 (…)` -> `desktop/0.0.151`. Anything else, or a
 * version that fails the pattern, is `null`. Never throws.
 */
export function sponsoredClientVersionFromUserAgent(
  userAgent: string | null | undefined,
): string | null {
  if (typeof userAgent !== 'string') return null
  const ua = userAgent.trim()
  for (const [prefix, client] of USER_AGENT_PREFIXES) {
    if (!ua.startsWith(prefix)) continue
    const version = ua.slice(prefix.length).split(/\s/, 1)[0] ?? ''
    const value = `${client}/${version}`
    return SPONSORED_CLIENT_VERSION_PATTERN.test(value) ? value : null
  }
  return null
}
