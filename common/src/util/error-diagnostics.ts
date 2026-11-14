/**
 * What a client diagnostic row may say about an error: its message with whatever is specific to
 * one person replaced by a placeholder, and the class chain of an error that wraps another.
 * Desktop's `desktop.workspace_native` rows and the hosted page's `desktop.workspace_ipc` rows both
 * use it, so one failure groups the same way on either side (docs/logging.md, "Freebuff Desktop
 * runtime failures").
 *
 * Placeholders: `<url>`, `<email>`, `<q>` (a quoted name, branch or value), `<path>` (quoted or
 * not: absolute, home, Windows, UNC, or any token with a path separator), `<ip>`, `<n>` (numbers
 * of five or more digits: ports, sizes, times) and `<id>` (UUIDs, hex, and id- or token-shaped
 * runs). Short numbers and constant-style codes (`404`, `ENOENT`, `SQLITE_FULL`) stay: they are
 * what tells one failure from another.
 */

export const ERROR_MESSAGE_MAX_CHARS = 200
export const ERROR_CHAIN_MAX_DEPTH = 4

const PLACEHOLDER = /^<[a-z]+>$/
const CONSTANT_CODE = /^[A-Z0-9_]+$/

function quoted(inner: string) {
  const value = inner.trim()
  return PLACEHOLDER.test(value) ? value : /[\\/]/.test(value) ? '<path>' : '<q>'
}

function idLike(token: string) {
  if (CONSTANT_CODE.test(token)) return token
  return (/\d/.test(token) && /[A-Za-z]/.test(token)) || token.length >= 24 ? '<id>' : token
}

/**
 * The first line of an error message with URLs, emails, quoted spans, paths, addresses, long
 * numbers and ids replaced, capped at `max` characters. Undefined when no text is left.
 */
export function normalizeErrorMessage(
  raw: unknown,
  max = ERROR_MESSAGE_MAX_CHARS,
): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = (raw.split(/\r?\n/, 1)[0] ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]+/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    // A straight single quote opens and closes on a word boundary, so "can't" is not one.
    .replace(/(^|[^\w])'([^'\n]*)'(?!\w)/g, (_, before: string, inner: string) => before + quoted(inner))
    .replace(/"([^"\n]*)"|`([^`\n]*)`|‘([^’\n]*)’|“([^”\n]*)”/g,
      (_, ...inner: unknown[]) => quoted(inner.slice(0, 4).find(part => typeof part === 'string') as string))
    .replace(/\b[A-Za-z]:[\\/][^\s'"`,;)]*/g, '<path>')
    .replace(/\\\\[^\s'"`,;)]+/g, '<path>')
    // A sentence's closing full stop is not part of the path.
    .replace(/(^|[\s(=:[])~?\/[^\s'"`,;)]*[^\s'"`,;.)]/g, '$1<path>')
    .replace(/(^|[\s(=:[])[\w.@~+-]+(?:[\\/][\w.@~+-]*)+/g, '$1<path>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b\d{5,}\b/g, '<n>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b[A-Za-z0-9_-]{12,}\b/g, idLike)
    .replace(/\b(?=[a-f]*\d)[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const ERROR_NAME = /^[A-Za-z0-9_]{1,64}$/
const ERROR_CODE = /^[A-Z_0-9-]{1,64}$/

/**
 * `Error>TypeError[ECONNRESET]`: the error's class, then each `cause` it wraps, outermost first,
 * with a constant-style `code` where one is set. At most {@link ERROR_CHAIN_MAX_DEPTH} links; a
 * name that is not an identifier is `?`. Undefined for a value that is not an object.
 */
export function errorClassChain(
  error: unknown,
  depth = ERROR_CHAIN_MAX_DEPTH,
): string | undefined {
  const links: string[] = []
  const seen = new Set<unknown>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current) && links.length < depth) {
    seen.add(current)
    const { name, code, cause } = current as { name?: unknown; code?: unknown; cause?: unknown }
    const label = typeof name === 'string' && ERROR_NAME.test(name) ? name : '?'
    links.push(typeof code === 'string' && ERROR_CODE.test(code) ? `${label}[${code}]` : label)
    current = cause
  }
  return links.length ? links.join('>') : undefined
}
