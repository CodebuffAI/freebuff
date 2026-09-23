export type FreebuffAccessTier = 'full' | 'limited'

export type FreebuffDesktopConcurrency = 'slot-bound' | 'multi-tab'

export const FREEBUFF_SOLAR_PRO_4_ENTITLEMENT = {
  modelId: 'upstage/solar-pro4',
  fullAccess: {
    premium: false,
  },
  limitedAccess: true,
} as const

export const FREEBUFF_SOLAR_PRO_4_MODEL_ID =
  FREEBUFF_SOLAR_PRO_4_ENTITLEMENT.modelId

/** Solar Mini 4 (Upstage) replaced Solar Pro 4 in every picker on 2026-09-23,
 *  on the same Upstage lane and with the same entitlement shape: unmetered by
 *  the premium pool at full access, and offered at limited access. */
export const FREEBUFF_SOLAR_MINI_4_ENTITLEMENT = {
  modelId: 'upstage/solar-mini4',
  fullAccess: {
    premium: false,
  },
  limitedAccess: true,
} as const

export const FREEBUFF_SOLAR_MINI_4_MODEL_ID =
  FREEBUFF_SOLAR_MINI_4_ENTITLEMENT.modelId
