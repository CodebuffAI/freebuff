import { canonicalPlacementId } from './placement-aliases'

/** Native inventory has its own attribution; never alias it to a web or iOS slot. */
export const ANDROID_AD_SURFACE = 'android' as const
export const ANDROID_AD_PLACEMENTS = [
  {
    id: 'Android-Chat-After-Assistant-Message',
    label: 'Chat · after an answer',
  },
  {
    id: 'Inline-After-Agent-Android',
    label: 'Coding · after an answer',
  },
  // The one-line link at the end of a coding answer; served when the
  // `inlineAdStyle` policy arm is `link`. Operator-run, not self-serve.
  {
    id: 'Inline-Link-After-Agent-Android',
    label: 'Coding · inline link after an answer',
    available: false,
  },
] as const

export function isAndroidAdPlacement(id: string | null | undefined): boolean {
  if (!id) return false
  const canonical = canonicalPlacementId(id)
  return ANDROID_AD_PLACEMENTS.some((slot) => slot.id === canonical)
}
