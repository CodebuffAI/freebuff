/**
 * Descriptive placement ids (COD-1043): `<App>-<Screen>-<Position>-<Format>`.
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
  { id: 'Chat-AboveComposer-Rotating-Desktop', legacy: 'Desktop-Below-Chat' },
  { id: 'Chat-AboveInput-Rotating-CLI', legacy: 'Single-Ad-Unit-1' },
  { id: 'Chat-Transcript-Inline-CLI', legacy: 'CLI-Chat-Inline' },
  { id: 'Chat-Transcript-Inline-Desktop', legacy: 'Desktop-Inline-Chat' },
  {
    id: 'Workspace-AboveComposer-Rotating-Web',
    legacy: 'Desktop-Below-Chat:web',
  },
  {
    id: 'Workspace-Transcript-Inline-Web',
    legacy: 'Desktop-Inline-Chat:web',
  },
  {
    id: 'AgentChat-AfterUserMsg-Inline-Web',
    legacy: 'Web-Chat-After-User-Message',
  },
  {
    id: 'AgentChat-AfterAnswer-Inline-Web',
    legacy: 'Web-Chat-After-Assistant-Message',
  },
  {
    id: 'Coding-AfterAnswer-Inline-Android',
    legacy: 'Android-Coding-After-Assistant-Message',
  },
  {
    id: 'Coding-AfterAnswer-Inline-iOS',
    legacy: 'iOS-Coding-After-Assistant-Message',
  },
  { id: 'Project-AbovePreview-Banner-Web', legacy: 'Above-iFrame' },
  { id: 'Chat-AboveInput-Mobile-Web', legacy: 'Chat-Assistant-Above-Input' },
  { id: 'WaitingRoom-Slot1-CLI', legacy: 'waiting-room-1' },
  { id: 'WaitingRoom-Slot2-CLI', legacy: 'waiting-room-2' },
  { id: 'WaitingRoom-Slot3-CLI', legacy: 'waiting-room-3' },
  { id: 'WaitingRoom-Slot4-CLI', legacy: 'waiting-room-4' },
] as const

export type RenamedPlacementId = (typeof PLACEMENT_RENAMES)[number]['id']
export type LegacyPlacementId = (typeof PLACEMENT_RENAMES)[number]['legacy']

const toCanonical = new Map<string, string>(
  PLACEMENT_RENAMES.map(({ id, legacy }) => [legacy, id]),
)
const toLegacy = new Map<string, string>(
  PLACEMENT_RENAMES.map(({ id, legacy }) => [id, legacy]),
)

/** The canonical id for any id: a legacy id maps to its new name, anything else is itself. */
export function canonicalPlacementId(id: string): string {
  return toCanonical.get(id) ?? id
}

/** The legacy id a renamed placement replaced, or `undefined` for one never renamed. */
export function legacyPlacementId(id: string): string | undefined {
  return toLegacy.get(canonicalPlacementId(id))
}

/** Whether `id` is a legacy name for a renamed placement. */
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
  return legacy ? [canonical, legacy] : [canonical]
}

/** Whether two ids name the same placement. */
export function samePlacement(a: string, b: string): boolean {
  return canonicalPlacementId(a) === canonicalPlacementId(b)
}
