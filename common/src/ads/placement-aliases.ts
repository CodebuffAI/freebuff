/**
 * Descriptive placement ids (COD-1043): `[<Screen>-]<Position>-<App>`, e.g.
 * `Above-Input-Desktop`, `Inline-After-Agent-CLI`. `Legacy-` marks the old
 * project agent chat on freebuff.com. The app is one of Desktop, CLI, Web,
 * Mobile (the phone layout of freebuff.com), Android or iOS.
 *
 * The new id is canonical. The legacy id is what shipped clients, stored rows,
 * campaign targets, the live click model and Gravity's registered slugs still
 * know, so every boundary that meets one of those goes through this table
 * instead of re-deriving the pairing.
 *
 * `Desktop-Below-Chat` was always the rotating slot ABOVE the composer; the
 * old name is kept only as an alias.
 */
export const PLACEMENT_RENAMES = [
  { id: 'Above-Input-Desktop', legacy: 'Desktop-Below-Chat' },
  { id: 'Above-Input-CLI', legacy: 'Single-Ad-Unit-1' },
  { id: 'Inline-After-Agent-CLI', legacy: 'CLI-Chat-Inline' },
  { id: 'Inline-After-Agent-Desktop', legacy: 'Desktop-Inline-Chat' },
  {
    id: 'Above-Input-Web',
    legacy: 'Desktop-Below-Chat:web',
  },
  {
    id: 'Inline-After-Agent-Web',
    legacy: 'Desktop-Inline-Chat:web',
  },
  {
    id: 'Legacy-Inline-After-User-Web',
    legacy: 'Web-Chat-After-User-Message',
  },
  {
    id: 'Legacy-Inline-After-Agent-Web',
    legacy: 'Web-Chat-After-Assistant-Message',
  },
  {
    id: 'Inline-After-Agent-Android',
    legacy: 'Android-Coding-After-Assistant-Message',
  },
  {
    id: 'Inline-After-Agent-iOS',
    legacy: 'iOS-Coding-After-Assistant-Message',
  },
  { id: 'Legacy-Above-Preview-Web', legacy: 'Above-iFrame' },
  { id: 'Above-Input-Mobile', legacy: 'Chat-Assistant-Above-Input' },
  { id: 'Waiting-Room-1-CLI', legacy: 'waiting-room-1' },
  { id: 'Waiting-Room-2-CLI', legacy: 'waiting-room-2' },
  { id: 'Waiting-Room-3-CLI', legacy: 'waiting-room-3' },
  { id: 'Waiting-Room-4-CLI', legacy: 'waiting-room-4' },
] as const

export type RenamedPlacementId = (typeof PLACEMENT_RENAMES)[number]['id']
export type LegacyPlacementId = (typeof PLACEMENT_RENAMES)[number]['legacy']

/**
 * The first canonical names (PR 9213), live 2026-11-01 for a few hours before
 * the names above replaced them. Rows written in that window and the Gravity
 * placements registered under them carry these, so they stay aliases.
 */
export const RETIRED_PLACEMENT_IDS = [
  { retired: 'Chat-AboveComposer-Rotating-Desktop', id: 'Above-Input-Desktop' },
  { retired: 'Chat-AboveInput-Rotating-CLI', id: 'Above-Input-CLI' },
  { retired: 'Chat-Transcript-Inline-CLI', id: 'Inline-After-Agent-CLI' },
  {
    retired: 'Chat-Transcript-Inline-Desktop',
    id: 'Inline-After-Agent-Desktop',
  },
  { retired: 'Workspace-AboveComposer-Rotating-Web', id: 'Above-Input-Web' },
  { retired: 'Workspace-Transcript-Inline-Web', id: 'Inline-After-Agent-Web' },
  {
    retired: 'AgentChat-AfterUserMsg-Inline-Web',
    id: 'Legacy-Inline-After-User-Web',
  },
  {
    retired: 'AgentChat-AfterAnswer-Inline-Web',
    id: 'Legacy-Inline-After-Agent-Web',
  },
  {
    retired: 'Coding-AfterAnswer-Inline-Android',
    id: 'Inline-After-Agent-Android',
  },
  { retired: 'Coding-AfterAnswer-Inline-iOS', id: 'Inline-After-Agent-iOS' },
  {
    retired: 'Project-AbovePreview-Banner-Web',
    id: 'Legacy-Above-Preview-Web',
  },
  { retired: 'Chat-AboveInput-Mobile-Web', id: 'Above-Input-Mobile' },
  { retired: 'WaitingRoom-Slot1-CLI', id: 'Waiting-Room-1-CLI' },
  { retired: 'WaitingRoom-Slot2-CLI', id: 'Waiting-Room-2-CLI' },
  { retired: 'WaitingRoom-Slot3-CLI', id: 'Waiting-Room-3-CLI' },
  { retired: 'WaitingRoom-Slot4-CLI', id: 'Waiting-Room-4-CLI' },
] as const satisfies ReadonlyArray<{ retired: string; id: RenamedPlacementId }>

const toCanonical = new Map<string, string>([
  ...PLACEMENT_RENAMES.map(({ id, legacy }) => [legacy, id] as const),
  ...RETIRED_PLACEMENT_IDS.map(({ retired, id }) => [retired, id] as const),
])
const retiredOf = new Map<string, string>(
  RETIRED_PLACEMENT_IDS.map(({ retired, id }) => [id, retired]),
)
const toLegacy = new Map<string, string>(
  PLACEMENT_RENAMES.map(({ id, legacy }) => [id, legacy]),
)

/** The canonical id for any id: a legacy or retired id maps to its new name, anything else is itself. */
export function canonicalPlacementId(id: string): string {
  return toCanonical.get(id) ?? id
}

/** The legacy id a renamed placement replaced, or `undefined` for one never renamed. */
export function legacyPlacementId(id: string): string | undefined {
  return toLegacy.get(canonicalPlacementId(id))
}

/** Whether `id` is an old name (legacy or retired) for a renamed placement. */
export function isLegacyPlacementId(id: string): id is LegacyPlacementId {
  return toCanonical.has(id)
}

/**
 * Every id one placement has gone by, canonical first. For exact-match
 * lookups against stored data written before the rename (campaign targets,
 * history), which must match either name.
 */
export function placementIdAliases(id: string): string[] {
  const canonical = canonicalPlacementId(id)
  const legacy = toLegacy.get(canonical)
  const retired = retiredOf.get(canonical)
  return [canonical, ...(legacy ? [legacy] : []), ...(retired ? [retired] : [])]
}

/** Whether two ids name the same placement. */
export function samePlacement(a: string, b: string): boolean {
  return canonicalPlacementId(a) === canonicalPlacementId(b)
}
