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
 */

export type FreebuffPickerSectionId = 'unlimited' | 'optimized' | 'powerful'

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
    'stealth/space-bunny-alpha': {
      section: 'unlimited',
      order: 10,
      recommended: true,
    },
    'upstage/solar-mini4': { section: 'unlimited', order: 20 },
    'm-916b95b337': { section: 'unlimited', order: 30, more: true }, // Ling 3.1 Flash
    'm-a273b5e513': { section: 'unlimited', order: 40, more: true }, // Laguna S 2.1
    // Optimized
    'mimo/mimo-v2.5': { section: 'optimized', order: 10, recommended: true }, // MiMo 2.6 Flash
    'z-ai/glm-5.3-flash': { section: 'optimized', order: 20 },
    'deepseek/deepseek-v4-flash': { section: 'optimized', order: 30 }, // V4.1 Flash
    'upstage/solar-pro4': { section: 'optimized', order: 40, more: true },
    // Powerful
    // DeepSeek V4.1 Flash Fast (2026-10-04): the section's pick, first.
    'deepseek/deepseek-v4-flash-fast': {
      section: 'powerful',
      order: 5,
      recommended: true,
    },
    'meta/muse-spark-1.3-contributor': { section: 'powerful', order: 10 },
    'openai/gpt-6-luna': { section: 'powerful', order: 20 },
    'mimo/mimo-v2.6-pro': { section: 'powerful', order: 30 },
    'openai/gpt-6.1-sol': { section: 'powerful', order: 40 },
    'google/gemini-3.8-flash': { section: 'powerful', order: 50, more: true },
  })

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
): { section: FreebuffPickerSection; models: T[] }[] {
  const placed = rows.map((row) => ({ row, placement: placementOf(row) }))
  return FREEBUFF_PICKER_SECTIONS.map((section) => ({
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
