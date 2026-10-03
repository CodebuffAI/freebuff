import type { PluginReport } from './report'

/**
 * Where a plugin install fetches from: the GitHub repo coordinates and
 * the plugin's subpath inside it, derived from the install URL.
 * `ref` defaults to `HEAD`, which codeload resolves to the default
 * branch; no commit sha is available without the REST API (rate limits),
 * so sha pinning stays future work.
 */
export interface PluginSource {
  owner: string
  repo: string
  ref: string
  /** Path segments of the plugin directory inside the repo, or null. */
  subpath: string | null
}

export type ParsePluginSourceResult =
  | { ok: true; source: PluginSource }
  | { ok: false; reason: string; reports: PluginReport[] }

/**
 * Parses a plugin install URL into fetch coordinates, purely — no
 * network, no git. Accepts the https GitHub forms: repo root, trailing
 * `.git`, `tree/<ref>` with or without a subpath, and a plain subpath.
 * Anything that is not an https github.com repo URL is rejected with the
 * reason, so the install aborts before fetching.
 */
export function parsePluginSourceUrl(url: string): ParsePluginSourceResult {
  // The ssh scp-like form (git@host:owner/repo) is not a URL at all —
  // construct it inside the guard so it is answered as a rejection.
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return rejected(`unsupported plugin source: ${url} is not a URL`)
  }

  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    return rejected(
      `unsupported plugin source: only https://github.com URLs are supported (got ${parsed.protocol}//${parsed.hostname})`,
    )
  }

  const segments = parsed.pathname.split('/').filter((s) => s.length > 0)
  if (segments.length < 2) {
    return rejected('the URL does not name a repository (owner/repo required)')
  }

  return parseRepoPath(segments)
}

/**
 * Splits the path after the host into fetch coordinates: `tree/<ref>` is
 * GitHub's ref-qualified browse form and needs a ref; every other segment
 * sequence is a plain subpath under the default branch. The trailing
 * `.git` is a remote convention, not part of the name.
 */
function parseRepoPath(segments: string[]): ParsePluginSourceResult {
  const [owner, repoRaw, ...rest] = segments
  const repo = repoRaw.replace(/\.git$/, '')

  if (rest[0] === 'tree') {
    if (rest.length < 2) {
      return rejected(
        'the URL names a branch but not which one (tree/<ref> required)',
      )
    }
    return {
      ok: true,
      source: {
        owner,
        repo,
        ref: rest[1] ?? '',
        subpath: rest.length > 2 ? rest.slice(2).join('/') : null,
      },
    }
  }

  return {
    ok: true,
    source: {
      owner,
      repo,
      ref: 'HEAD',
      subpath: rest.length > 0 ? rest.join('/') : null,
    },
  }
}

function rejected(reason: string): ParsePluginSourceResult {
  return { ok: false, reason, reports: [] }
}
