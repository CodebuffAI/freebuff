import { canonicalPlacementId, placementIdAliases } from './placement-aliases'

/** Desktop inventory mirrored in the computer-sized Cloud workspace.
 * Identity stays distinct in delivery; matching inherits only toward web.
 * An explicit list prevents arbitrary suffixes from opening campaign targets.
 */
export const WEB_DESKTOP_SOURCE_PLACEMENTS = [
  'Inline-After-Agent-Desktop',
  'Above-Input-Desktop',
  'Desktop-Spotlight',
  'Desktop-Showcase',
  'Desktop-Intermission',
  'Desktop-Partner-Skill-Picker',
  'Desktop-Partner-Composer-PR',
  'Desktop-Partner-Composer-Launch',
  'Desktop-Billboard-Sidebar',
  'Desktop-Billboard-Panel',
  // Display-ad (branded) units; each `:web` copy is gated on its own id in
  // `DISPLAY_AD_SERVING_LIVE` (`display-ads/serving.ts`).
  'Desktop-Top-Banner',
  'Desktop-Home-Takeover',
  'Desktop-MCP-Featured',
] as const
export type DesktopPlacementId = (typeof WEB_DESKTOP_SOURCE_PLACEMENTS)[number]

/**
 * The two chat slots renamed in COD-1043 got their own Web ids; every other
 * source keeps `<id>:web`. Explicit, so the pairing is one table rather than a
 * suffix rule plus exceptions.
 */
const WEB_COPY_BY_SOURCE = {
  'Inline-After-Agent-Desktop': 'Inline-After-Agent-Web',
  'Above-Input-Desktop': 'Above-Input-Web',
  'Desktop-Spotlight': 'Desktop-Spotlight:web',
  'Desktop-Showcase': 'Desktop-Showcase:web',
  'Desktop-Intermission': 'Desktop-Intermission:web',
  'Desktop-Partner-Skill-Picker': 'Desktop-Partner-Skill-Picker:web',
  'Desktop-Partner-Composer-PR': 'Desktop-Partner-Composer-PR:web',
  'Desktop-Partner-Composer-Launch': 'Desktop-Partner-Composer-Launch:web',
  'Desktop-Billboard-Sidebar': 'Desktop-Billboard-Sidebar:web',
  'Desktop-Billboard-Panel': 'Desktop-Billboard-Panel:web',
  'Desktop-Top-Banner': 'Desktop-Top-Banner:web',
  'Desktop-Home-Takeover': 'Desktop-Home-Takeover:web',
  'Desktop-MCP-Featured': 'Desktop-MCP-Featured:web',
} as const satisfies Record<DesktopPlacementId, string>

export type WebDesktopPlacementId =
  (typeof WEB_COPY_BY_SOURCE)[DesktopPlacementId]

const webCopyBySource = new Map<string, WebDesktopPlacementId>(
  Object.entries(WEB_COPY_BY_SOURCE),
)
const sourceByWebCopy = new Map<string, DesktopPlacementId>(
  Object.entries(WEB_COPY_BY_SOURCE).map(([source, web]) => [
    web,
    source as DesktopPlacementId,
  ]),
)

/** The Web copy of a Desktop source (legacy or canonical id), if it has one. */
export function webDesktopPlacement(
  id: string,
): WebDesktopPlacementId | undefined {
  return webCopyBySource.get(canonicalPlacementId(id))
}

/**
 * The canonical Desktop source a Web copy inherits from (legacy or canonical
 * Web id); any other id comes back unchanged.
 */
export function desktopPlacementSource(id: string): string {
  return sourceByWebCopy.get(canonicalPlacementId(id)) ?? id
}

export function isWebDesktopPlacement(id: string): id is WebDesktopPlacementId {
  return sourceByWebCopy.has(canonicalPlacementId(id))
}

/**
 * Every stored target id that can serve these placements: each id, the
 * Desktop source a Web copy inherits from, and every name either has gone by
 * (`ad_placement_target` still holds pre-COD-1043 ids).
 */
export function inheritedPlacementTargets(ids: readonly string[]): string[] {
  return [
    ...new Set(
      ids.flatMap((id) => [
        id,
        ...placementIdAliases(id),
        ...placementIdAliases(desktopPlacementSource(id)),
      ]),
    ),
  ]
}

export function campaignTargetsPlacement(
  targets: readonly string[],
  placement: string,
): boolean {
  const own = canonicalPlacementId(placement)
  const source = canonicalPlacementId(desktopPlacementSource(placement))
  return targets.some((target) => {
    const canonical = canonicalPlacementId(target)
    return canonical === own || canonical === source
  })
}
