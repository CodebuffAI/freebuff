/**
 * The display-ad placements (UI only, mock sponsors) and their feature flags.
 *
 * Every placement is OFF unless a local override turns it on. There is no
 * server flag yet: these units draw hardcoded sponsors from `sponsors.ts` and
 * nothing serves or bills them; they send analytics-only events (`telemetry.ts`).
 * Each surface reads its own override and
 * hands the raw value to `parseDisplayAdOverride`:
 *
 * - Desktop and the Cloud/web workspace: `localStorage['freebuff:display-ads']`,
 *   or `?displayAds=` on a loopback URL, which stores it
 *   (`freebuff-desktop/src/ui/display-ads/flags.ts`).
 * - CLI: `"displayAds"` in the CLI's `settings.json` (`cli/src/utils/settings.ts`).
 *
 * The override is `all`, or a comma-separated list of placement ids
 * (`cliSplash,cliStatusline`). Unknown ids are ignored.
 */

export const DISPLAY_AD_PLACEMENTS = [
  /** CLI launch splash: sponsor block under the CliSplash header box. */
  'cliSplash',
  /** Desktop/web new-chat empty state: sponsor-of-the-day takeover. */
  'homeTakeover',
  /** Desktop/web app-wide sponsor bar on the announcement banner. */
  'topBanner',
  /** Desktop/web Settings › MCP: one row of featured sponsor servers. */
  'mcpFeatured',
  /** CLI footer statusline row plus the `/deals` command. */
  'cliStatusline',
] as const

export type DisplayAdPlacement = (typeof DISPLAY_AD_PLACEMENTS)[number]

/** A placement, or `deals` — the list `/deals` prints (flagged with `cliStatusline`). */
export type DisplayAdSlot = DisplayAdPlacement | 'deals'

export type DisplayAdSurface = 'desktop' | 'web' | 'cli'

/**
 * Each slot's placement id per surface, following `web-desktop-placements.ts`
 * (Desktop ids, the Cloud/web mirror as `<id>:web`) and the CLI's `CLI-*`
 * ids. Every rendered unit carries its id (`data-placement-id` on
 * Desktop/web, a prop in the CLI), and every analytics event in `telemetry.ts`
 * is tagged with it.
 *
 * Registered in `PLACEMENT_SLOTS` (format `branded`) and, for the Desktop
 * three, `WEB_DESKTOP_SOURCE_PLACEMENTS`, so the billed endpoints and
 * reporting know them, but held DARK by `DISPLAY_AD_SERVING_LIVE` in
 * `serving.ts`: no campaign can target or be delivered to an id until it is
 * added there. The served creative contract is `served.ts`.
 */
export const DISPLAY_AD_PLACEMENT_IDS = {
  cliSplash: { cli: 'CLI-Splash' },
  homeTakeover: {
    desktop: 'Desktop-Home-Takeover',
    web: 'Desktop-Home-Takeover:web',
  },
  topBanner: { desktop: 'Desktop-Top-Banner', web: 'Desktop-Top-Banner:web' },
  mcpFeatured: {
    desktop: 'Desktop-MCP-Featured',
    web: 'Desktop-MCP-Featured:web',
  },
  cliStatusline: { cli: 'CLI-Statusline' },
  deals: { cli: 'CLI-Deals' },
} as const satisfies Record<
  DisplayAdSlot,
  Partial<Record<DisplayAdSurface, string>>
>

type PlacementIdMap = typeof DISPLAY_AD_PLACEMENT_IDS

/** Every display-ad placement id, on every surface. */
export type DisplayAdPlacementId = {
  [S in DisplayAdSlot]: PlacementIdMap[S][keyof PlacementIdMap[S]]
}[DisplayAdSlot]

/** The surfaces a slot draws on (a compile error to ask for another). */
export type DisplayAdSurfaceOf<S extends DisplayAdSlot> = keyof PlacementIdMap[S] &
  DisplayAdSurface

/** A slot's placement id on one surface: `displayAdPlacementId('topBanner', 'web')`. */
export function displayAdPlacementId<
  S extends DisplayAdSlot,
  F extends DisplayAdSurfaceOf<S>,
>(slot: S, surface: F): PlacementIdMap[S][F] {
  return DISPLAY_AD_PLACEMENT_IDS[slot][surface]
}

/** Every id a flagged placement owns (`cliStatusline` also owns `CLI-Deals`). */
export function displayAdPlacementIds(
  placement: DisplayAdPlacement,
): DisplayAdPlacementId[] {
  const slots: DisplayAdSlot[] =
    placement === 'cliStatusline' ? ['cliStatusline', 'deals'] : [placement]
  return slots.flatMap(
    (slot) =>
      Object.values(DISPLAY_AD_PLACEMENT_IDS[slot]) as DisplayAdPlacementId[],
  )
}

/** Checked-in defaults. All OFF; flipping one here turns it on for everyone. */
export const DISPLAY_AD_FLAG_DEFAULTS: Readonly<
  Record<DisplayAdPlacement, boolean>
> = {
  cliSplash: false,
  homeTakeover: false,
  topBanner: false,
  mcpFeatured: false,
  cliStatusline: false,
}

export function isDisplayAdPlacement(value: unknown): value is DisplayAdPlacement {
  return (
    typeof value === 'string' &&
    (DISPLAY_AD_PLACEMENTS as readonly string[]).includes(value)
  )
}

/** The placements a local override names: `all`, or a comma list of ids. */
export function parseDisplayAdOverride(
  raw: string | readonly string[] | null | undefined,
): ReadonlySet<DisplayAdPlacement> {
  if (raw == null) return new Set()
  const parts = (typeof raw === 'string' ? raw.split(',') : raw).map((p) =>
    p.trim(),
  )
  if (parts.includes('all')) return new Set(DISPLAY_AD_PLACEMENTS)
  return new Set(parts.filter(isDisplayAdPlacement))
}

/** Whether a placement is on: its checked-in default, or named by the override. */
export function displayAdEnabled(
  placement: DisplayAdPlacement,
  override?: string | readonly string[] | null,
): boolean {
  return (
    DISPLAY_AD_FLAG_DEFAULTS[placement] ||
    parseDisplayAdOverride(override).has(placement)
  )
}
