import { canonicalPlacementId } from './placement-aliases'

/** Native inventory has its own attribution; never alias it to a web slot. */
export const IOS_AD_SURFACE = 'ios' as const
export const IOS_AD_PLACEMENTS = [
  { id: 'iOS-Chat-After-Assistant-Message', label: 'Chat · after an answer' },
  { id: 'iOS-Coding-After-User-Message', label: 'Coding · after your message' },
  {
    id: 'Inline-After-Agent-iOS',
    label: 'Coding · after an answer',
  },
] as const

export function isIOSAdPlacement(id: string | null | undefined): boolean {
  if (!id) return false
  const canonical = canonicalPlacementId(id)
  return IOS_AD_PLACEMENTS.some((slot) => slot.id === canonical)
}
