/**
 * Which image addresses an artifact may hold, shared by the kinds' validators
 * (artifact-kinds/slides.ts, whiteboard.ts, design.ts) and the renderers'
 * load decision (freebuff/web …/artifacts/remote-images.ts).
 *
 * Validation stays permissive on purpose (save and restore re-validate whole
 * stored bodies, so tightening would strand existing artifacts): an https URL,
 * or a same-origin path. Only the forms a browser would resolve OFF this
 * origin are refused: `//host`, `/\host`, a backslash anywhere, and an encoded
 * slash or backslash (`/%2F…`, `/%5C…`), plus markup characters in a path. Loading is the renderers' stricter
 * call: an uploaded asset (`/_asset/<uuid>`) always, a third-party https image
 * only after the reader opts in, anything else never.
 *
 * What an AGENT may add is stricter still (`unstoredImageSrcsAdded`, enforced by the store's write
 * pipeline for agent writes): only this artifact's stored assets, or the built-in placeholder. A
 * src the stored body already holds is kept, so existing bodies and people's own https images
 * still save; the agent imports a picture (import_artifact_image) instead of hotlinking it.
 */

import { ARTIFACT_ASSET_REF_GLOBAL_PATTERN, ARTIFACT_ASSET_REF_PATTERN } from './artifacts'

const CONTROL_OR_SPACE = /[\u0000- \u007f-\u009f]/
const ENCODED_SEPARATOR = /%(?:2f|5c)/i
/** Never part of a real path (a browser percent-encodes them); refused so no export can be broken out of. */
const MARKUP = /[<>"'`]/

/** A path on this origin: one leading `/`, then a letter, digit, `_` or `.`; nothing that leaves the origin. */
export function isSameOriginImagePath(src: string): boolean {
  return (
    /^\/[A-Za-z0-9_.]/.test(src) &&
    !src.includes('\\') &&
    !CONTROL_OR_SPACE.test(src) &&
    !ENCODED_SEPARATOR.test(src) &&
    !MARKUP.test(src)
  )
}

/** An absolute `https:` URL with a host and no credentials, as the browser will read it. */
export function isRemoteImageUrl(src: string): boolean {
  if (!/^https:\/\//i.test(src) || src.includes('\\') || CONTROL_OR_SPACE.test(src)) return false
  try {
    const url = new URL(src)
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

/** Image srcs that are ours to serve without a remote fetch: the placeholder new slides use. */
export const BUILT_IN_IMAGE_SRCS: ReadonlySet<string> = new Set(['/Placeholder.svg'])

/** An uploaded asset ref (`/_asset/<uuid>`) or a built-in image: what an agent write may add. */
export function isStoredImageSrc(src: string): boolean {
  return ARTIFACT_ASSET_REF_PATTERN.test(src) || BUILT_IN_IMAGE_SRCS.has(src)
}

const MARKDOWN_IMAGE = /!\[(?:\\.|[^\]\\])*\]\(\s*<?([^\s)>]+)/g
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi

/**
 * Every image src in a body, in order, distinct: a Markdown body's Markdown and HTML images, and
 * every `src` in a JSON kind (slide images and elements, design nodes and fills, whiteboard
 * images), except inside free-form records (`FREE_FORM_KEYS`: a chart's `data`, a design data
 * list's `rows`), whose columns are named by the author and may well be called "src". Empty for
 * an unreadable JSON body.
 */
export function bodyImageSrcs(format: 'markdown' | 'json', body: string): string[] {
  const found = new Set<string>()
  const note = (src: unknown) => {
    if (typeof src === 'string' && src) found.add(src)
  }
  if (format !== 'json') {
    for (const match of body.matchAll(MARKDOWN_IMAGE)) note(match[1])
    for (const match of body.matchAll(HTML_IMAGE)) note(match[1])
    return [...found]
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  visitJsonImageSrcs(parsed, (src) => {
    note(src)
    return src
  })
  return [...found]
}

/** Swap only matched image references, leaving other fields of structured artifacts intact. */
export function remapArtifactImageSrcs(format: 'markdown' | 'json', body: string, refs: ReadonlyMap<string, string>): string {
  const remap = (src: string) => refs.get(src) ?? src
  if (!refs.size) return body
  if (format === 'markdown') return body.replace(ARTIFACT_ASSET_REF_GLOBAL_PATTERN, remap)
  const parsed: unknown = JSON.parse(body)
  visitJsonImageSrcs(parsed, remap)
  return JSON.stringify(parsed)
}

function visitJsonImageSrcs(value: unknown, visit: (src: string) => string, depth = 0) {
  if (depth > 64 || !value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) visitJsonImageSrcs(item, visit, depth + 1)
    return
  }
  const object = value as Record<string, unknown>
  for (const [key, field] of Object.entries(object)) {
    if (key === 'src' && typeof field === 'string') object[key] = visit(field)
    else if (key !== 'src' && !FREE_FORM_KEYS.has(key)) visitJsonImageSrcs(field, visit, depth + 1)
  }
}

/** Keys whose value is author-named data rows (chart.ts `data`, design.ts data lists' `rows`), never image holders. */
const FREE_FORM_KEYS: ReadonlySet<string> = new Set(['data', 'rows'])

/**
 * The image srcs `next` adds that are not stored images (`isStoredImageSrc`) and that `stored`
 * did not already hold: what an agent write may not introduce. `stored` is null for a new body.
 */
export function unstoredImageSrcsAdded(format: 'markdown' | 'json', stored: string | null, next: string): string[] {
  const had = new Set(stored === null ? [] : bodyImageSrcs(format, stored))
  return bodyImageSrcs(format, next).filter((src) => !isStoredImageSrc(src) && !had.has(src))
}
