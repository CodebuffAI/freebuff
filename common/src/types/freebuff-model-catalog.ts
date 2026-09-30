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
