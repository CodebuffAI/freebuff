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
  | 'standard'
  | 'premium'
  | 'powerful'
  // A section the server catalog defines.
  | (string & {})

export interface FreebuffPickerSection {
  id: FreebuffPickerSectionId
  label: string
  /** What the section's models are for, shown on its info icon. */
  tooltip: string
}

/**
 * In display order, at full access: Premium, Powerful, then Standard last
 * (product, 2026-11-02, Victor). The same three sections as the limited
 * layout (default-config.ts's `LIMITED_SECTIONS`), which lists Standard first
 * (`freebuffPickerSectionsFor`). Standard was "Unlimited" and Premium
 * "Optimized" until then, and from 2026-10-28 to 11-02 full access in
 * country tiers 1 and 2 was sent no Unlimited section at all.
 */
export const FREEBUFF_PICKER_SECTIONS: readonly FreebuffPickerSection[] =
  Object.freeze([
    {
      id: 'premium',
      label: 'Premium',
      tooltip: 'Strongest price-to-performance models',
    },
    {
      id: 'powerful',
      label: 'Powerful',
      tooltip: 'Frontier models like GPT-6.1 Sol and more',
    },
    {
      id: 'standard',
      label: 'Standard',
      tooltip: 'Free and low-cost models',
    },
  ])

/** The sections in one tier's display order: the limited tier lists Standard
 *  first. */
export function freebuffPickerSectionsFor(
  tier: 'full' | 'limited' | 'blocked' | undefined,
  sections: readonly FreebuffPickerSection[] = FREEBUFF_PICKER_SECTIONS,
): readonly FreebuffPickerSection[] {
  if (tier !== 'limited') return sections
  return [
    ...sections.filter((section) => section.id === 'standard'),
    ...sections.filter((section) => section.id !== 'standard'),
  ]
}

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
    // Standard (product, 2026-11-02, Victor): the free rows and MiMo v2.6
    // Flash Slow (one hour a session), last in the picker. Only Solar Pro 4 is
    // in view; the rest wait under Show more.
    'upstage/solar-pro4': { section: 'standard', order: 1 },
    'm-ddc687c50f': { section: 'standard', order: 10, more: true }, // Nemotron 3.5 Lightning
    'm-02244092cb': { section: 'standard', order: 15, more: true }, // Glyph Cluster
    'upstage/solar-mini4': { section: 'standard', order: 20, more: true },
    'm-61c26317cc': { section: 'standard', order: 30, more: true }, // MiMo v2.6 Flash Slow, 5
    // (MiniMax M3.1 Flash, 'm-b2a427415d', retired 2026-10-24, has no place.)
    'm-916b95b337': { section: 'standard', order: 40, more: true }, // Ling 3.1 Flash
    'm-a273b5e513': { section: 'standard', order: 50, more: true }, // Laguna S 2.1
    // Premium: DeepSeek V4.1 Flash pinned first as the section's pick and the
    // full-access recommendation, then cheapest to dearest (product,
    // 2026-10-15). DeepSeek leads because on the Luminal lane it is our
    // cheapest Flash-class model ($0.91 per 1k messages over 10-07..13,
    // against MiMo 2.6 Flash's $1.35 on OpenRouter). In view: DeepSeek V4.1
    // Flash, Muse Spark 1.3, GLM 5.3 Flash; Flash Slow, MiMo v2.6 Flash Fast
    // and GPT-6 Luna under More (product, 2026-10-30).
    'deepseek/deepseek-v4-flash': { section: 'premium', order: 5, recommended: true }, // V4.1 Flash, 15
    // Muse Spark 1.3 and GPT-6 Luna moved here from Powerful (2026-10-13).
    // Placement only: both are plan-only at limited access.
    'meta/muse-spark-1.3-contributor': { section: 'premium', order: 20 }, // 15
    'z-ai/glm-5.3-flash': { section: 'premium', order: 40 }, // 20
    'm-8db1ccbba6': { section: 'premium', order: 62, more: true }, // DeepSeek V4.1 Flash Slow, 10
    'mimo/mimo-v2.5': { section: 'premium', order: 64, more: true }, // MiMo v2.6 Flash Fast, 10
    'openai/gpt-6-luna': { section: 'premium', order: 66, more: true }, // 20
    // Powerful: cheapest to dearest (product, 2026-10-28; Claude Haiku 5.5's
    // 100k-context row was pinned first before). The dearest rows wait under
    // More, cheapest first (product, 2026-10-22, so the expensive models are
    // less visible): Claude Haiku 5.5 full context, Gemini 3.8 Flash, Gemini 4
    // Argon, GPT-6.1 Terra, GPT-6.1 Sol.
    'mimo/mimo-v2.6-pro': { section: 'powerful', order: 10 }, // 25
    // 25, or 50 in DeepSeek's peak window, so after MiMo 2.6 Pro's flat 25.
    'deepseek/deepseek-v4-flash-fast': { section: 'powerful', order: 20 },
    'm-5b6a604eb6': { section: 'powerful', order: 30 }, // Claude Haiku 5.5, 100k context, 30
    'm-79293c5b7d': { section: 'powerful', order: 35, more: true }, // Claude Haiku 5.5, 75
    'google/gemini-3.8-flash': { section: 'powerful', order: 40, more: true }, // 80
    'google/gemini-4-argon': { section: 'powerful', order: 45, more: true }, // 100
    'openai/gpt-6.1-terra': { section: 'powerful', order: 48, more: true }, // 100, promotional
    'openai/gpt-6.1-sol': { section: 'powerful', order: 50, more: true }, // 250
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
 * on its own: a premium or plan-locked row is Powerful, a free one Standard,
 * anything else Premium.
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
          ? 'standard'
          : 'premium',
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
