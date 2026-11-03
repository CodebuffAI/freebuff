/**
 * Report redaction. By default a report names no full path, no user name and no email: a path
 * keeps only its last folder (`~/…/my-repo`), which is what support needs to follow along. The
 * user can opt in to full paths for their own debugging. Secrets are removed either way.
 */

export type DoctorRedactor = {
  readonly includePaths: boolean
  /** One path, shortened unless the user opted in. */
  path(value: string): string
  /** Free text (an error message): paths, the user name, emails and secrets taken out. */
  text(value: string): string
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// Bearer tokens, `token=`/`key=` pairs and long opaque keys. Applied whatever the opt-in says.
const SECRETS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <secret>'],
  [/\b((?:api[_-]?key|token|secret|password|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, '$1<secret>'],
  [/\b(?:sk|pk|rk|fb|cb|ghp|gho|ghu|github_pat|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/g, '<secret>'],
]
// An absolute path: `C:\…`, `\\server\…` or `/…`, not the `//` of a URL or a relative `a/b`.
const ABSOLUTE_PATH = /(?<![\w:/.\\-])(?:[A-Za-z]:[\\/]|\\\\|\/)(?:[^\s"'`<>|*?:\\/]+[\\/])*[^\s"'`<>|*?:\\/]*/g

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function createRedactor(options: {
  home: string
  username?: string
  includePaths?: boolean
}): DoctorRedactor {
  const includePaths = options.includePaths === true
  const home = options.home.replace(/[\\/]+$/, '')
  const homePattern = home
    ? new RegExp(escape(home).replace(/\\\\|\//g, '[\\\\/]'), 'gi')
    : null
  const user = options.username && options.username.length >= 2 ? options.username : undefined

  function shorten(value: string) {
    const parts = value.split(/[\\/]+/).filter(Boolean)
    const last = parts.at(-1) ?? ''
    const underHome = home !== '' && value.toLowerCase().startsWith(home.toLowerCase())
    const prefix = underHome ? '~' : ''
    if (!last || (underHome && value.length <= home.length + 1)) return underHome ? '~' : '…'
    const name = user ? last.replace(new RegExp(escape(user), 'gi'), '<user>') : last
    return `${prefix}/…/${name}`
  }

  function secrets(value: string) {
    return SECRETS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
  }

  return {
    includePaths,
    path(value) {
      return includePaths ? value : shorten(value)
    },
    text(value) {
      let text = secrets(value)
      if (includePaths) return text
      text = text.replace(ABSOLUTE_PATH, match => (match.length > 1 ? shorten(match) : match))
      if (homePattern) text = text.replace(homePattern, '~')
      text = text.replace(EMAIL, '<email>')
      if (user) text = text.replace(new RegExp(`\\b${escape(user)}\\b`, 'gi'), '<user>')
      return text
    },
  }
}
