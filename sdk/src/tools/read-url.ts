import { isHttpProxyConfiguredFromEnv } from '../env'
import { pinnedFetch } from './pinned-fetch'
import { assertUrlAllowed } from './ssrf'

import type { AddressPolicy, HostLookup } from './ssrf'

import type { CodebuffToolOutput } from '../../../common/src/tools/list'

const DEFAULT_MAX_CHARS = 20_000
const MAX_RESPONSE_BYTES = 2_000_000
const FETCH_TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const USER_AGENT =
  'Mozilla/5.0 (compatible; CodebuffResearchBot/1.0; +https://codebuff.com)'

type ReadUrlOutput = CodebuffToolOutput<'read_url'>
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

function errorResult(
  url: string | undefined,
  errorMessage: string,
): ReadUrlOutput {
  return [{ type: 'json', value: { ...(url ? { url } : {}), errorMessage } }]
}

function getHeader(headers: Headers, name: string): string | undefined {
  return headers.get(name) ?? undefined
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = getHeader(response.headers, 'content-length')
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Response is too large (${contentLength} bytes)`)
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Response is too large (${buffer.byteLength} bytes)`)
    }
    return new TextDecoder().decode(buffer)
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue

    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      throw new Error(`Response exceeded ${maxBytes} bytes`)
    }
    chunks.push(value)
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(body)
}

function decodeHtmlEntities(text: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    copy: '(c)',
    hellip: '...',
    gt: '>',
    lt: '<',
    mdash: '-',
    middot: '*',
    nbsp: ' ',
    ndash: '-',
    quot: '"',
    rsquo: "'",
  }

  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, body) => {
    if (body[0] === '#') {
      const isHex = body[1]?.toLowerCase() === 'x'
      const value = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      return Number.isFinite(value) && value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : entity
    }
    return namedEntities[body] ?? entity
  })
}

function normalizeText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function extractFirstMatch(html: string, pattern: RegExp): string | undefined {
  const match = html.match(pattern)
  if (!match?.[1]) return undefined
  return normalizeText(decodeHtmlEntities(stripTags(match[1])))
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
}

function removeElement(html: string, tagName: string): string {
  return html.replace(
    new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'gi'),
    '\n',
  )
}

function extractElementContents(html: string, tagName: string): string[] {
  const matches = html.matchAll(
    new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi'),
  )
  return Array.from(matches, (match) => match[1]).filter(Boolean)
}

function selectReadableHtml(html: string): string {
  const articleCandidates = extractElementContents(html, 'article')
  if (articleCandidates.length > 0) {
    return articleCandidates.reduce((best, candidate) =>
      stripTags(candidate).length > stripTags(best).length ? candidate : best,
    )
  }

  const mainCandidates = extractElementContents(html, 'main')
  if (mainCandidates.length > 0) {
    return mainCandidates.reduce((best, candidate) =>
      stripTags(candidate).length > stripTags(best).length ? candidate : best,
    )
  }

  return html
}

function extractMetaContent(html: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(
      `<meta\\b(?=[^>]*(?:name|property)=["']${escapedName}["'])(?=[^>]*content=["']([^"']*)["'])[^>]*>`,
      'i',
    ),
    new RegExp(
      `<meta\\b(?=[^>]*content=["']([^"']*)["'])(?=[^>]*(?:name|property)=["']${escapedName}["'])[^>]*>`,
      'i',
    ),
  ]

  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return normalizeText(decodeHtmlEntities(match[1]))
  }
  return undefined
}

function extractHtml(html: string): {
  title?: string
  description?: string
  text: string
} {
  const title = extractFirstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i)
  const description =
    extractMetaContent(html, 'description') ??
    extractMetaContent(html, 'og:description')

  let readable = html
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/<!doctype[^>]*>/gi, '\n')

  for (const tagName of [
    'script',
    'style',
    'svg',
    'canvas',
    'iframe',
    'noscript',
    'nav',
    'header',
    'footer',
    'form',
    'button',
    'select',
  ]) {
    readable = removeElement(readable, tagName)
  }

  readable = selectReadableHtml(readable)

  readable = readable
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/(p|div|section|article|main|aside|li|tr|td|th|h[1-6]|blockquote|pre)>/gi,
      '\n',
    )
    .replace(/<(li|tr|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')

  const text = normalizeText(decodeHtmlEntities(readable))
  return { title, description, text }
}

function extractMarkdownFrontmatter(body: string): {
  title?: string
  description?: string
  text: string
} {
  const match = body.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/)
  if (!match) {
    return { text: normalizeText(decodeHtmlEntities(body)) }
  }

  const frontmatter = match[1]
  const getValue = (key: 'title' | 'description') => {
    const valueMatch = frontmatter.match(
      new RegExp(`^${key}:\\s*(?:"([^"]*)"|'([^']*)'|(.+))\\s*$`, 'm'),
    )
    return normalizeText(
      decodeHtmlEntities(
        valueMatch?.[1] ?? valueMatch?.[2] ?? valueMatch?.[3] ?? '',
      ),
    )
  }

  return {
    title: getValue('title') || undefined,
    description: getValue('description') || undefined,
    text: normalizeText(decodeHtmlEntities(body.slice(match[0].length))),
  }
}

function isJsonContentType(contentType: string): boolean {
  return (
    contentType.includes('application/json') || contentType.includes('+json')
  )
}

function isMarkdownContentType(contentType: string): boolean {
  return contentType.includes('text/markdown')
}

function isSupportedContentType(contentType: string): boolean {
  return /^(text\/|application\/(json|[^;\s/]+\+json|xhtml\+xml|xml|rss\+xml|atom\+xml)\b)/i.test(
    contentType,
  )
}

function extractTextByContentType(
  contentType: string,
  body: string,
): {
  title?: string
  description?: string
  text: string
} {
  const lowerContentType = contentType.toLowerCase()

  if (
    lowerContentType.includes('text/html') ||
    lowerContentType.includes('application/xhtml')
  ) {
    return extractHtml(body)
  }

  if (isJsonContentType(lowerContentType)) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 2) }
    } catch {
      return { text: normalizeText(body) }
    }
  }

  if (isMarkdownContentType(lowerContentType)) {
    return extractMarkdownFrontmatter(body)
  }

  if (
    lowerContentType.startsWith('text/') ||
    lowerContentType.includes('application/xml') ||
    lowerContentType.includes('application/rss+xml') ||
    lowerContentType.includes('application/atom+xml')
  ) {
    return { text: normalizeText(body) }
  }

  return { text: normalizeText(body) }
}

function truncateText(
  text: string,
  maxChars: number,
): {
  text: string
  truncated: boolean
} {
  if (text.length <= maxChars) {
    return { text, truncated: false }
  }
  return {
    text: `${text.slice(0, maxChars).trimEnd()}\n\n[Content truncated]`,
    truncated: true,
  }
}

/**
 * The transport used when the caller supplies no `fetch`.
 *
 * Normally {@link pinnedFetch}: the connection goes only to addresses that
 * were validated in the same resolution. Under Bun with a proxy configured,
 * Bun's own `fetch` instead, because it honours the proxy variables and
 * `node:http` there does not; the proxy, not this process, resolves the name.
 */
function defaultTransport(opts: {
  lookupHost?: HostLookup
  isBlocked?: AddressPolicy
}): FetchLike {
  const isBun = typeof process !== 'undefined' && !!process.versions?.bun
  if (isBun && isHttpProxyConfiguredFromEnv()) {
    return globalThis.fetch
  }
  return async (input, init) =>
    pinnedFetch(String(input), {
      headers: init?.headers as Record<string, string> | undefined,
      signal: init?.signal ?? undefined,
      ...opts,
    })
}

export async function readUrl({
  url,
  max_chars = DEFAULT_MAX_CHARS,
  fetch: customFetch,
  lookupHost,
  isBlocked,
  resolveDns = customFetch === undefined,
  signal,
}: {
  url: string
  max_chars?: number
  /**
   * A replacement transport (tests). Without one, every connection is pinned
   * to addresses validated at connect time (`pinned-fetch.ts`).
   */
  fetch?: FetchLike
  /** Override hostname resolution (defaults to node:dns). */
  lookupHost?: HostLookup
  /** Override which addresses are refused (defaults to `isBlockedAddress`). */
  isBlocked?: AddressPolicy
  /**
   * Whether to DNS-resolve hostnames for SSRF checks before each hop.
   * Defaults to true unless the caller supplies its own fetch (e.g. a test
   * stub); IP-literal hosts are rejected either way.
   */
  resolveDns?: boolean
  /** External abort (e.g. user interrupt); cancels the fetch mid-flight. */
  signal?: AbortSignal
}): Promise<ReadUrlOutput> {
  const fetchImpl = customFetch ?? defaultTransport({ lookupHost, isBlocked })
  if (signal?.aborted) {
    return errorResult(url, 'Cancelled: the run was aborted by the user.')
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return errorResult(url, 'Invalid URL')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const onExternalAbort = () => controller.abort()
  signal?.addEventListener('abort', onExternalAbort, { once: true })

  try {
    // Follow redirects manually so every hop is re-validated against the SSRF
    // policy — a public URL must not be able to 30x its way to an internal one.
    let currentUrl = parsedUrl
    let response: Response
    for (let redirects = 0; ; redirects++) {
      try {
        // Refuses non-http(s) schemes and private/reserved addresses, literal
        // or resolved from the hostname, before each hop. The default
        // transport validates again when it connects, against the addresses
        // it actually connects to.
        await assertUrlAllowed(currentUrl, {
          lookupHost,
          resolveDns,
          isBlocked,
        })
      } catch (error) {
        return errorResult(
          url,
          error instanceof Error ? error.message : 'Blocked URL',
        )
      }

      response = await fetchImpl(currentUrl.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept:
            'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': USER_AGENT,
        },
      })

      if (!REDIRECT_STATUSES.has(response.status)) {
        break
      }

      const location = getHeader(response.headers, 'location')
      if (!location) {
        break
      }
      // The redirect's own body is never read; release its connection.
      await response.body?.cancel().catch(() => {})
      if (redirects >= MAX_REDIRECTS) {
        return errorResult(url, `Too many redirects (>${MAX_REDIRECTS})`)
      }
      try {
        currentUrl = new URL(location, currentUrl)
      } catch {
        return errorResult(url, `Invalid redirect location: ${location}`)
      }
    }

    if (!response.ok) {
      return errorResult(
        url,
        `Failed to fetch URL: ${response.status} ${response.statusText}`,
      )
    }

    const contentType = getHeader(response.headers, 'content-type') ?? ''
    if (contentType && !isSupportedContentType(contentType)) {
      return errorResult(
        url,
        `Unsupported content type: ${contentType || 'unknown'}`,
      )
    }

    const body = await readResponseBody(response, MAX_RESPONSE_BYTES)
    const extracted = extractTextByContentType(contentType, body)
    const truncated = truncateText(extracted.text, max_chars)

    if (!truncated.text) {
      return errorResult(url, 'No readable text found at URL')
    }

    return [
      {
        type: 'json',
        value: {
          url,
          finalUrl: response.url || currentUrl.toString(),
          status: response.status,
          ...(contentType ? { contentType } : {}),
          ...(extracted.title ? { title: extracted.title } : {}),
          ...(extracted.description
            ? { description: extracted.description }
            : {}),
          text: truncated.text,
          truncated: truncated.truncated,
        },
      },
    ]
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError'
    return errorResult(
      url,
      isAbort
        ? signal?.aborted
          ? 'Cancelled: the run was aborted by the user.'
          : `Timed out after ${FETCH_TIMEOUT_MS} ms`
        : error instanceof Error
          ? error.message
          : 'Unknown error',
    )
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}
