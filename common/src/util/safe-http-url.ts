const RELATIVE_BASE = 'https://relative.invalid'

/**
 * The value, if it is safe to put in an `href`: an absolute `http:`/`https:`
 * URL, or with `allowRelative` a reference with no scheme of its own, which
 * resolves against the page and inherits its scheme. Anything else returns
 * `undefined`, and the caller renders no link.
 *
 * Ad click URLs are the reason this exists: a network's `clickUrl` is
 * third-party JSON, and an anchor would follow a `javascript:`, `data:`,
 * `vbscript:` or custom-scheme URL as readily as an https one. Parsing is the
 * WHATWG parser the browser itself uses, so mixed case, leading whitespace and
 * control characters, and embedded tabs or newlines are judged exactly as the
 * browser would read them. The value is returned unchanged, not re-serialized.
 */
export function safeHttpUrl(
  value: unknown,
  options: { allowRelative?: boolean } = {},
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    // No parseable scheme of its own. Against a base it can only resolve to
    // that base's scheme, or fail.
    if (!options.allowRelative) return undefined
    try {
      parsed = new URL(value, RELATIVE_BASE)
    } catch {
      return undefined
    }
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:'
    ? value
    : undefined
}
