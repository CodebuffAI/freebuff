import { z } from 'zod/v4'

/**
 * Starter templates: the published catalogue and how to fetch it.
 *
 * `templates/` in this repository holds the sources. `scripts/templates/publish.ts`
 * packs each one, screenshots it, and writes `catalog.json`, the previews and the
 * content-addressed archives to a public bucket. Desktop, the web workspace and
 * the agent tools only ever read that published catalogue: adding or updating a
 * template is a publish, not a release of either app.
 */

/** Public and read-only; a checked-in constant, not a secret. */
export const TEMPLATE_CATALOG_URL =
  'https://pub-0cfed6727a1844b7b9405419b66ad607.r2.dev/catalog.json'

/** Archives are small source trees; anything near this is a packaging mistake. */
export const TEMPLATE_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024
export const TEMPLATE_ARCHIVE_MAX_FILES = 20_000
export const TEMPLATE_ARCHIVE_MAX_EXPANDED_BYTES = 512 * 1024 * 1024

export const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export const templateIntegrationSchema = z.enum(['auth', 'database', 'storage'])
export type TemplateIntegration = z.infer<typeof templateIntegrationSchema>

const httpsUrl = z.string().url().refine((url) => url.startsWith('https://'), 'Template assets must be https URLs')

export const templateCatalogEntrySchema = z
  .object({
    id: z.string().regex(TEMPLATE_ID),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(300),
    kind: z.enum(['site', 'app']),
    integrations: z.array(templateIntegrationSchema).max(3),
    tags: z.array(z.string().min(1).max(40)).max(12),
    /** A 16:10 screenshot of the template's most representative view. */
    preview: httpsUrl,
    archive: z
      .object({
        /** gzip tar with the project's files at its root (no leading directory). */
        url: httpsUrl,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().int().positive().max(TEMPLATE_ARCHIVE_MAX_BYTES),
        files: z.number().int().positive().max(TEMPLATE_ARCHIVE_MAX_FILES),
      })
      .strict(),
    /** Short content hash of the archive; changes whenever the template does. */
    version: z.string().min(1).max(40),
  })
  .strict()
export type TemplateCatalogEntry = z.infer<typeof templateCatalogEntrySchema>

export const templateCatalogSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string(),
    templates: z.array(templateCatalogEntrySchema),
  })
  .strict()
  .refine(
    (catalog) => new Set(catalog.templates.map((t) => t.id)).size === catalog.templates.length,
    'Template ids must be unique',
  )
export type TemplateCatalog = z.infer<typeof templateCatalogSchema>

export class TemplateCatalogError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** Every asset must live beside the catalogue: a catalogue cannot point a client elsewhere. */
export function assertTemplateAssetOrigin(url: string, catalogUrl = TEMPLATE_CATALOG_URL): void {
  if (new URL(url).origin !== new URL(catalogUrl).origin)
    throw new TemplateCatalogError('Template catalogue references an asset on another origin')
}

export async function fetchTemplateCatalog(options: {
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>
  url?: string
  signal?: AbortSignal
} = {}): Promise<TemplateCatalog> {
  const url = options.url ?? TEMPLATE_CATALOG_URL
  let response: Response
  try {
    response = await (options.fetcher ?? fetch)(url, {
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: options.signal ?? AbortSignal.timeout(15_000),
      cache: 'no-store',
    })
  } catch (error) {
    throw new TemplateCatalogError('Could not reach the template catalogue', 503, { cause: error })
  }
  if (!response.ok) throw new TemplateCatalogError(`Template catalogue returned ${response.status}`)
  const parsed = templateCatalogSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new TemplateCatalogError('Template catalogue is invalid')
  for (const template of parsed.data.templates) {
    assertTemplateAssetOrigin(template.preview, url)
    assertTemplateAssetOrigin(template.archive.url, url)
  }
  return parsed.data
}

export function findTemplate(catalog: TemplateCatalog, id: string): TemplateCatalogEntry {
  const template = catalog.templates.find((t) => t.id === id)
  if (!template) throw new TemplateCatalogError(`Unknown template "${id}"`, 404)
  return template
}

/** The catalogue, memoised for a short while so a dialog and an agent turn share one fetch. */
export function cachedTemplateCatalog(options: {
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>
  url?: string
  ttlMs?: number
  now?: () => number
} = {}): (signal?: AbortSignal) => Promise<TemplateCatalog> {
  const ttl = options.ttlMs ?? 5 * 60_000
  const now = options.now ?? Date.now
  let cached: { at: number; catalog: TemplateCatalog } | undefined
  let inflight: Promise<TemplateCatalog> | undefined
  return async (signal) => {
    if (cached && now() - cached.at < ttl) return cached.catalog
    inflight ??= fetchTemplateCatalog({ fetcher: options.fetcher, url: options.url, signal })
      .then((catalog) => {
        cached = { at: now(), catalog }
        return catalog
      })
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }
}

/** Downloads one archive and verifies its size and digest before anything is unpacked. */
export async function fetchTemplateArchive(
  template: TemplateCatalogEntry,
  options: {
    fetcher?: (url: string, init?: RequestInit) => Promise<Response>
    signal?: AbortSignal
    digest?: (bytes: Uint8Array) => Promise<string> | string
  } = {},
): Promise<Uint8Array> {
  let response: Response
  try {
    response = await (options.fetcher ?? fetch)(template.archive.url, {
      redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(60_000),
    })
  } catch (error) {
    throw new TemplateCatalogError('Could not download the template', 503, { cause: error })
  }
  if (!response.ok) throw new TemplateCatalogError(`Template download returned ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== template.archive.bytes)
    throw new TemplateCatalogError('Template download is not the size the catalogue lists')
  const digest = options.digest ? await options.digest(bytes) : await sha256Hex(bytes)
  if (digest !== template.archive.sha256) throw new TemplateCatalogError('Template download failed its checksum')
  return bytes
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
