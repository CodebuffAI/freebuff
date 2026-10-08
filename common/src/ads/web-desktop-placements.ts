/** Desktop inventory mirrored in the computer-sized Cloud workspace.
 * Identity stays distinct in delivery; matching inherits only toward web.
 * An explicit list prevents arbitrary suffixes from opening campaign targets.
 */
export const WEB_DESKTOP_SOURCE_PLACEMENTS = [
  'Desktop-Inline-Chat',
  'Desktop-Below-Chat',
  'Desktop-Spotlight',
  'Desktop-Showcase',
  'Desktop-Intermission',
  'Desktop-Partner-Skill-Picker',
  'Desktop-Partner-Composer-PR',
  'Desktop-Partner-Composer-Launch',
  'Desktop-Billboard-Sidebar',
  'Desktop-Billboard-Panel',
] as const
export type DesktopPlacementId = (typeof WEB_DESKTOP_SOURCE_PLACEMENTS)[number]
export type WebDesktopPlacementId = `${DesktopPlacementId}:web`
const sources = new Set<string>(WEB_DESKTOP_SOURCE_PLACEMENTS)
export function webDesktopPlacement(
  id: string,
): WebDesktopPlacementId | undefined {
  return sources.has(id) ? (`${id}:web` as WebDesktopPlacementId) : undefined
}
export function desktopPlacementSource(id: string): string {
  const source = id.endsWith(':web') ? id.slice(0, -4) : id
  return id.endsWith(':web') && sources.has(source) ? source : id
}
export function isWebDesktopPlacement(id: string): id is WebDesktopPlacementId {
  return desktopPlacementSource(id) !== id
}
export function inheritedPlacementTargets(ids: readonly string[]): string[] {
  return [...new Set(ids.flatMap((id) => [id, desktopPlacementSource(id)]))]
}
export function campaignTargetsPlacement(
  targets: readonly string[],
  placement: string,
): boolean {
  return (
    targets.includes(placement) ||
    targets.includes(desktopPlacementSource(placement))
  )
}
