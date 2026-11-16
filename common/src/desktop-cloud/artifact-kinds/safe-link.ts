/**
 * The one link allow-list. Links built from artifact content (a doc or data-page link, a comment,
 * a slide link, a whiteboard link card, a sheet hyperlink cell, a pasted or exported link) come
 * from agents, link editors and other people, so they are data. Only web and mail links survive;
 * `javascript:`, `data:`, `vbscript:`, `file:`, protocol-relative `//host` and the rest render as
 * plain text. Every rendered link to another page also opens in a new tab with `SAFE_LINK_ATTRS`
 * (no opener, no referrer).
 */
export const SAFE_LINK_SCHEMES = ['http:', 'https:', 'mailto:'] as const

export type SafeLinkOptions = {
  /** Also keep an in-page anchor (`#heading`, `#tab=…`) as typed. */
  anchor?: boolean
  /** Also keep a same-origin path (`/#artifact=…`) as typed; never `//host` or `/\host`. */
  path?: boolean
}

/** C0 and C1 control characters: browsers drop some of them mid-scheme (`java\tscript:`). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const ANCHOR = /^#[^\s]*$/
const SAME_ORIGIN_PATH = /^\/(?![/\\])[^\s\\]*$/

/**
 * The normalised href when `url` is an absolute http(s) or mailto URL, else null. With
 * `anchor` / `path`, an in-page anchor or a same-origin path is kept as typed.
 */
export function safeLinkHref(url: string | null | undefined, options: SafeLinkOptions = {}): string | null {
  if (typeof url !== 'string') return null
  const value = url.trim()
  if (!value || CONTROL.test(value)) return null
  if (value.startsWith('#')) return options.anchor && ANCHOR.test(value) ? value : null
  if (value.startsWith('/') || value.startsWith('\\'))
    return options.path && SAME_ORIGIN_PATH.test(value) ? value : null
  try {
    const parsed = new URL(value)
    return (SAFE_LINK_SCHEMES as readonly string[]).includes(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}

/** Spread onto every `<a>` whose href came from content. */
export const SAFE_LINK_ATTRS = {
  target: '_blank',
  rel: 'noopener noreferrer',
  referrerPolicy: 'no-referrer',
} as const
