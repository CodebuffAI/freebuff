/**
 * The server-driven Freebuff model catalog: the wire contract between
 * `GET /api/v1/freebuff/models` and the CLI / Desktop pickers.
 *
 * Why it exists: every row, badge, tooltip, effort ladder and model id used to
 * be compiled into each client, so adding, re-pricing or rotating a model
 * meant cutting a CLI and a Desktop release. A client that speaks this
 * protocol renders what the server sends and needs no release for any of it.
 *
 * Three identifiers, and only one of them selects a model:
 *
 * - `key`: stable and opaque. What a client PERSISTS (a saved pick, a thread's
 *   model). It never selects anything on the wire, so learning it buys nothing.
 * - `handle`: what a client SENDS wherever it used to send a model id — the
 *   agent definition's `model`, and the `x-freebuff-model` admission header.
 *   Minted per account, and it expires as the server rotates it, so a client
 *   must replace it from a fresh catalog rather than store it.
 * - The upstream model id never appears on this wire.
 *
 * A client that cannot fetch the catalog (an older server, the network)
 * falls back to its compiled catalog and plain model ids, exactly as it did
 * before this protocol existed. Models that exist only in the server catalog
 * are unreachable in that mode, by design.
 *
 * Everything here is public (common/ is exported). Nothing in it may reveal
 * how a handle is built or verified; that lives server-side only.
 */
import { z } from 'zod/v4'

import { REASONING_EFFORTS } from '../constants/reasoning-effort'

/** Sent on every catalog-aware request (`GET /api/v1/freebuff/models`, the
 *  session endpoints). Its presence is what tells the session endpoints to
 *  answer with catalog keys instead of model ids. */
export const FREEBUFF_CATALOG_PROTOCOL_HEADER = 'x-freebuff-catalog-protocol'
export const FREEBUFF_CATALOG_PROTOCOL_VERSION = '1'
export const FREEBUFF_MODEL_CATALOG_PATH = '/api/v1/freebuff/models'

/** Prefix every handle carries, so a client (and a log reader) can tell a
 *  handle from a legacy model id without parsing it. */
export const FREEBUFF_MODEL_HANDLE_PREFIX = 'fbm1.'

export function isFreebuffModelHandle(value: string | null | undefined) {
  return !!value && value.startsWith(FREEBUFF_MODEL_HANDLE_PREFIX)
}

/**
 * Sent on every session and completions request a catalog client makes: the
 * `fetchId` of the catalog response its handles came from. It ties each
 * request to the fetch (account, install, time) that produced its handle.
 */
export const FREEBUFF_CATALOG_FETCH_HEADER = 'x-freebuff-catalog-fetch'

/**
 * Device-bound request signing. A client generates one Ed25519 key pair per
 * install, registers the public key once per account
 * (`POST FREEBUFF_DEVICE_KEYS_PATH`), and signs every catalog, session and
 * completions request with the private key, which never leaves the install.
 */
export const FREEBUFF_DEVICE_KEYS_PATH = '/api/v1/freebuff/device-keys'
export const FREEBUFF_DEVICE_KEY_HEADER = 'x-freebuff-device-key'
export const FREEBUFF_DEVICE_TIMESTAMP_HEADER = 'x-freebuff-device-ts'
export const FREEBUFF_DEVICE_SIGNATURE_HEADER = 'x-freebuff-device-sig'

/**
 * The exact string a device signs (UTF-8), and the server verifies. Fields are
 * newline-joined in this order; `bodySha256` is the lowercase hex SHA-256 of
 * the request body bytes as sent (of the empty string for a body-less
 * request); `path` is the URL path without query. The signature is base64url.
 */
export function freebuffDeviceSignaturePayload(params: {
  method: string
  path: string
  timestampMs: number
  bodySha256: string
  fetchId: string | null | undefined
}): string {
  return [
    'freebuff-device-v1',
    params.method.toUpperCase(),
    params.path,
    String(params.timestampMs),
    params.bodySha256,
    params.fetchId ?? '',
  ].join('\n')
}

/** The error code the server answers a stale, expired or unknown handle with.
 *  A client that sees it refetches the catalog once and retries with the new
 *  handle for the same `key`. */
export const FREEBUFF_CATALOG_STALE_ERROR = 'freebuff_catalog_stale'

const effortSchema = z.enum(REASONING_EFFORTS)

export const freebuffCatalogBadgeSchema = z.object({
  /** Semantic kind, for clients that style kinds differently. Unknown kinds
   *  must render as `custom`, never be dropped: a new kind is a server change. */
  kind: z.string(),
  /** Short text on the pill, e.g. "New", "Promotional". */
  label: z.string(),
  /** Hover / detail text. The CLI shows it on the focused row. */
  tooltip: z.string().optional(),
  /** Visual emphasis. Unknown tones render as `neutral`. */
  tone: z.string().optional(),
})
export type FreebuffCatalogBadge = z.infer<typeof freebuffCatalogBadgeSchema>

/**
 * Where a row sits in the picker: which section, its position there, whether
 * it waits under the section's collapsed "More", and whether it is the
 * section's own pick (the Recommended pill). Server-decided, so a reorder is a
 * catalog edit, never a client release. Absent: the client's compiled place.
 */
export const freebuffCatalogPlacementSchema = z.object({
  /** A section id from the catalog's `sections` (or a compiled one). */
  section: z.string().min(1),
  /** Lower first, within the section. */
  order: z.number(),
  more: z.boolean().optional(),
  recommended: z.boolean().optional(),
})
export type FreebuffCatalogPlacement = z.infer<
  typeof freebuffCatalogPlacementSchema
>

/** One picker section, as the server names and orders them. */
export const freebuffCatalogSectionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** What the section's models are for, on its info icon. */
  tooltip: z.string(),
})
export type FreebuffCatalogSection = z.infer<typeof freebuffCatalogSectionSchema>

/**
 * Which time-of-day price pills a row with a peak / off-peak schedule shows:
 * `both` (Peak in the dearer window, Off-peak in the cheaper one), `peak` (only
 * Peak), or `none`. Absent: the client's compiled rule.
 */
export const freebuffCatalogPeakPillsSchema = z.enum(['both', 'peak', 'none'])
export type FreebuffCatalogPeakPills = z.infer<
  typeof freebuffCatalogPeakPillsSchema
>

export const freebuffCatalogRowSchema = z.object({
  key: z.string().min(1),
  handle: z.string().min(1),
  displayName: z.string().min(1),
  tagline: z.string(),
  taglineTooltip: z.string().optional(),
  /** A warning line (e.g. AI-training data use). Rendered, never hidden. */
  warning: z.string().optional(),
  badges: z.array(freebuffCatalogBadgeSchema),
  multimodal: z.boolean(),
  premium: z.boolean(),
  dataUse: z.enum(['service', 'training']),
  /**
   * `open`: selectable, priced in Freebucks.
   * `locked`: listed but needs a paid plan; a press opens `plansUrl`, it never
   * starts a session, and no Freebucks price is drawn.
   */
  access: z.enum(['open', 'locked']),
  lockedLabel: z.string().optional(),
  lockedTooltip: z.string().optional(),
  /** Reasoning ladder, ascending. Absent or empty: no effort picker. */
  efforts: z.array(effortSchema).optional(),
  defaultEffort: effortSchema.optional(),
  /** Fixed effort shown when there is no ladder (display only). */
  reasoningEffort: effortSchema.optional(),
  contextWindow: z.number().int().positive().optional(),
  /** `compactContext` policy for the agent definition built on this row.
   *  `maxContextLength` is the compaction budget the runtime would otherwise
   *  look up by model id (`contextPrunerBudgetForModel`), which a handle
   *  cannot key. */
  compaction: z
    .object({
      cacheExpiryMs: z.number().int().positive(),
      cacheExpiryMinTokens: z.number().int().nonnegative(),
      maxContextLength: z.number().int().positive().optional(),
    })
    .optional(),
  /** Sort position; ascending. Clients that sort by price may ignore it. */
  sortOrder: z.number(),
  /** The row's picker section and place in it (see the schema). */
  placement: freebuffCatalogPlacementSchema.optional(),
  /** Which peak / off-peak price pills the row shows (see the schema). */
  peakPills: freebuffCatalogPeakPillsSchema.optional(),
  /**
   * A row that opens in the future (ms epoch). Clients do NOT list, select or
   * send such a row until `opensAt` has passed.
   */
  opensAt: z.number().optional(),
  /**
   * Opaque digests of the legacy model ids this row replaces, so a client can
   * move a pick saved before the catalog existed onto its row without the
   * catalog naming the id: `freebuffLegacyModelDigest(savedId)`.
   */
  legacyDigests: z.array(z.string()).optional(),
})
export type FreebuffCatalogRow = z.infer<typeof freebuffCatalogRowSchema>

export const freebuffModelCatalogSchema = z.object({
  protocol: z.literal(1),
  /** Changes whenever anything a client renders changes. */
  version: z.string(),
  /** Server time the handles were minted (ms epoch). */
  issuedAt: z.number(),
  /** Refetch no later than this (ms epoch); handles stay valid for a grace
   *  period after it, so a refetch is never a race. */
  refreshAt: z.number(),
  rows: z.array(freebuffCatalogRowSchema),
  /** The row a new or unpicked selection lands on, for this viewer. */
  recommendedKey: z.string().optional(),
  /** Always-joinable row a client steps down to (spent pool, closed row). */
  fallbackKey: z.string().optional(),
  /** Where a locked row's press goes. */
  plansUrl: z.string(),
  /** The picker's sections, in display order. Absent: the client's compiled
   *  sections. A row naming a section not listed here takes the client's
   *  inferred place. */
  sections: z.array(freebuffCatalogSectionSchema).optional(),
  /** This fetch's id; sent back as FREEBUFF_CATALOG_FETCH_HEADER on every
   *  session and completions request made with these handles. */
  fetchId: z.string().optional(),
})
export type FreebuffModelCatalog = z.infer<typeof freebuffModelCatalogSchema>

/**
 * Digest of a legacy (pre-catalog) model id, matched against a row's
 * `legacyDigests`. It exists so the catalog need not list model ids; the
 * legacy ids themselves are already public.
 * FNV-1a over a namespaced string: cheap, synchronous, identical in every
 * runtime (Bun, Node, the browser) with no crypto import.
 */
export function freebuffLegacyModelDigest(modelId: string): string {
  const input = `freebuff-legacy-model:${modelId}`
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/**
 * Rows a client may list: everything already open when the catalog was issued.
 * Judged against the catalog's own `issuedAt` (server time) whenever it has
 * one, never the device clock, so a clock set weeks ahead cannot open a row
 * early; `now` only covers a catalog without it.
 */
export function listableFreebuffCatalogRows(
  catalog: Pick<FreebuffModelCatalog, 'rows'> & { issuedAt?: number },
  now: number = Date.now(),
): FreebuffCatalogRow[] {
  const at = catalog.issuedAt ?? now
  return catalog.rows.filter(
    (row) => row.opensAt === undefined || row.opensAt <= at,
  )
}

/** The row a legacy saved model id maps to, if the catalog carries one. */
export function findFreebuffCatalogRowForLegacyId(
  catalog: Pick<FreebuffModelCatalog, 'rows'>,
  legacyModelId: string,
): FreebuffCatalogRow | undefined {
  const digest = freebuffLegacyModelDigest(legacyModelId)
  return catalog.rows.find((row) => row.legacyDigests?.includes(digest))
}

/** Parse a catalog response; `null` when it is not one this client speaks. */
export function parseFreebuffModelCatalog(
  body: unknown,
): FreebuffModelCatalog | null {
  const parsed = freebuffModelCatalogSchema.safeParse(body)
  return parsed.success ? parsed.data : null
}
