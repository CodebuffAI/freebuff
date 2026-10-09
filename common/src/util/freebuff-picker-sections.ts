/**
 * The hosted model picker's three sections, and which section each row sits
 * in (2026-10-04, product). One long price-sorted list made it hard to tell
 * what a row was FOR; the sections answer that before the price does.
 *
 * Ids are literals on purpose, as in freebuff-freebucks.ts: this module is
 * imported by renderer code that must not pull in the full catalog.
 * `freebuff-picker-sections.test.ts` pins each one to the constant it names.
 * Catalog-only rows have no public id, so they are placed by their default
 * catalog key (`defaultCatalogKey`), which is opaque.
 *
 * SERVER-DRIVEN since 2026-10-07: the model catalog sends each row's place and
 * the sections themselves (`placement`, `sections` in freebuff-model-catalog.ts),
 * and every client draws what it is sent. What is compiled here is only the
 * server's DEFAULT (default-config.ts builds the catalog's placements from it)
 * and the fallback for a client talking to a server that sends none. Reorder by
 * editing the catalog, not this file.
 */

export type FreebuffPickerSectionId =
  | 'unlimited'
  | 'optimized'
  | 'powerful'
  // A section the server catalog defines.
  | (string & {})

export interface FreebuffPickerSection {
  id: FreebuffPickerSectionId
  label: string
  /** What the section's models are for, shown on its info icon. */
  tooltip: string
}

/** In display order. */
export const FREEBUFF_PICKER_SECTIONS: readonly FreebuffPickerSection[] =
  Object.freeze([
    {
      id: 'unlimited',
      label: 'Unlimited',
      tooltip: 'Experimental models with unlimited usage',
    },
    {
      id: 'optimized',
      label: 'Optimized',
      tooltip: 'Strongest price-to-performance models',
    },
    {
      id: 'powerful',
      label: 'Powerful',
      tooltip: 'Frontier models like GPT-6.1 Sol and more',
    },
  ])

export interface FreebuffPickerPlacement {
  section: FreebuffPickerSectionId
  /** Position within the section; lower first. */
  order: number
  /** Listed under the section's collapsed "More" until expanded, or until it
   *  is the selected row. */
  more?: boolean
  /** The section's own pick, badged Recommended. */
  recommended?: boolean
}

const PLACEMENTS: Readonly<Record<string, FreebuffPickerPlacement>> =
  Object.freeze({
    // Unlimited
    // Glyph Cluster (2026-10-07): the section's first row, never under More.
    'm-02244092cb': { section: 'unlimited', order: 5 }, // Glyph Cluster
    // Solar Pro 4 (2026-10-05): free as a promotion, moved from Optimized.
    'upstage/solar-pro4': { section: 'unlimited', order: 15 },
    // Solar Mini 4 (2026-10-08): free as a promotion, back from Optimized.
    'upstage/solar-mini4': { section: 'unlimited', order: 20 },
    'm-916b95b337': { section: 'unlimited', order: 30, more: true }, // Ling 3.1 Flash
    'm-a273b5e513': { section: 'unlimited', order: 40, more: true }, // Laguna S 2.1
    // Optimized
    'mimo/mimo-v2.5': { section: 'optimized', order: 10, recommended: true }, // MiMo 2.6 Flash
    'z-ai/glm-5.3-flash': { section: 'optimized', order: 20 },
    'deepseek/deepseek-v4-flash': { section: 'optimized', order: 30 }, // V4.1 Flash
    // Powerful
    // Claude Haiku 5.5 (2026-10-07): first; paid plans, open in the US.
    'm-79293c5b7d': { section: 'powerful', order: 1 }, // Claude Haiku 5.5
    // DeepSeek V4.1 Flash Fast: no longer badged Recommended (2026-10-07).
    'deepseek/deepseek-v4-flash-fast': { section: 'powerful', order: 5 },
    'meta/muse-spark-1.3-contributor': { section: 'powerful', order: 10 },
    'openai/gpt-6-luna': { section: 'powerful', order: 20 },
    'mimo/mimo-v2.6-pro': { section: 'powerful', order: 30 },
    'openai/gpt-6.1-sol': { section: 'powerful', order: 40 },
    'google/gemini-3.8-flash': { section: 'powerful', order: 50, more: true },
  })

/** The compiled place of one id, if it has one: the server's default. */
export function compiledFreebuffPickerPlacement(
  id: string,
): FreebuffPickerPlacement | undefined {
  return PLACEMENTS[id]
}

/**
 * A row's place: the server's, when it sent one for a section the picker
 * draws, else the compiled place (`freebuffPickerPlacement`).
 */
export function freebuffRowPlacement(
  server:
    | { section: string; order: number; more?: boolean; recommended?: boolean }
    | undefined,
  sections: readonly FreebuffPickerSection[],
  ids: readonly (string | undefined)[],
  fallback: { premium: boolean; locked: boolean; price: number | undefined },
): FreebuffPickerPlacement {
  if (server && sections.some((section) => section.id === server.section))
    return {
      section: server.section,
      order: server.order,
      ...(server.more ? { more: true } : {}),
      ...(server.recommended ? { recommended: true } : {}),
    }
  return freebuffPickerPlacement(ids, fallback)
}

/**
 * Where a row goes. `ids` are every name the row may be known by — its
 * compiled id, catalog key — and the first one placed wins. A row placed by
 * none (a model added after this build) is inferred and tucked under More,
 * so a new server-side model never lands in the prominent part of a section
 * on its own: a premium or plan-locked row is Powerful, a free one Unlimited,
 * anything else Optimized.
 */
export function freebuffPickerPlacement(
  ids: readonly (string | undefined)[],
  fallback: { premium: boolean; locked: boolean; price: number | undefined },
): FreebuffPickerPlacement {
  for (const id of ids) {
    const placed = id ? PLACEMENTS[id] : undefined
    if (placed) return placed
  }
  return {
    section:
      fallback.premium || fallback.locked
        ? 'powerful'
        : fallback.price === 0
          ? 'unlimited'
          : 'optimized',
    order: Number.POSITIVE_INFINITY,
    more: true,
  }
}

/**
 * Each section's rows, in display order, for the pickers that list every row
 * (CLI, Web). Rows go by placement order, so a section's "More" rows come last,
 * then unplaced rows in the order they arrived. Empty sections are dropped.
 */
export function freebuffPickerSections<T>(
  rows: readonly T[],
  placementOf: (row: T) => FreebuffPickerPlacement,
  /** The server catalog's sections, when it sent them. */
  sections: readonly FreebuffPickerSection[] = FREEBUFF_PICKER_SECTIONS,
): { section: FreebuffPickerSection; models: T[] }[] {
  const placed = rows.map((row) => ({ row, placement: placementOf(row) }))
  return sections.map((section) => ({
    section,
    models: placed
      .filter(({ placement }) => placement.section === section.id)
      .sort((a, b) => a.placement.order - b.placement.order || 0)
      .map(({ row }) => row),
  })).filter(({ models }) => models.length > 0)
}

/** Tests only: every placed id. */
export const FREEBUFF_PICKER_PLACED_IDS: readonly string[] = Object.freeze(
  Object.keys(PLACEMENTS),
)
