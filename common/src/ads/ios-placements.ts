/** Native inventory has its own attribution; never alias it to a web slot. */
export const IOS_AD_SURFACE = 'ios' as const
export const IOS_AD_PLACEMENTS = [
  { id: 'iOS-Chat-After-Assistant-Message', label: 'Chat · after an answer' },
  { id: 'iOS-Coding-After-User-Message', label: 'Coding · after your message' },
  {
    id: 'iOS-Coding-After-Assistant-Message',
    label: 'Coding · after an answer',
  },
] as const

export function isIOSAdPlacement(id: string | null | undefined): boolean {
  return IOS_AD_PLACEMENTS.some((slot) => slot.id === id)
}
