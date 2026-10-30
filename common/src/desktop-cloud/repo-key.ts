/**
 * The repository a local folder is a checkout of, as `host/owner/name[:subfolder]`, so two
 * computers that open the same folder of the same remote join one Cloud project
 * (docs/desktop/device-execution.md, "One project across computers").
 *
 * SSH and HTTPS spellings of one remote agree: credentials, ports, a `.git` suffix and case are
 * dropped. The host stays, so `github.com/a/b` and `gitlab.com/a/b` are different repositories,
 * and so does every path segment (GitLab subgroups). A path or `file://` remote is not a hosted
 * repository and has no key.
 */
export function repoKeyFromRemote(remoteUrl: string | null | undefined): string | null {
  const trimmed = remoteUrl?.trim()
  if (!trimmed) return null
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(trimmed)
  let host: string
  let path: string
  if (scheme) {
    if (!['ssh', 'git', 'http', 'https', 'git+ssh', 'ssh+git'].includes(scheme[1]!.toLowerCase())) return null
    const rest = trimmed.slice(scheme[0].length).replace(/^[^/@]*@/, '')
    const match = /^([^/:]+)(?::\d+)?\/(.*)$/.exec(rest)
    if (!match) return null
    host = match[1]!
    path = match[2]!
  } else {
    // scp-like `user@host:owner/name`; a bare `host:path` is ambiguous with a local path on Windows
    const match = /^[^/@]+@([^/:]+):(.*)$/.exec(trimmed)
    if (!match) return null
    host = match[1]!
    path = match[2]!
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) return null
  const parts = path
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean)
  if (parts.length < 2 || parts.some((part) => part === '.' || part === '..')) return null
  return `${host}/${parts.join('/')}`.toLowerCase()
}

/** A folder inside the repository (`apps/web`) keys separately from its root. */
export function repoKey(remoteKey: string, subfolder: string): string {
  const relative = subfolder.split(/[\\/]+/).filter((part) => part && part !== '.').join('/')
  return relative ? `${remoteKey}:${relative}` : remoteKey
}

export const REPO_KEY_MAX = 600
