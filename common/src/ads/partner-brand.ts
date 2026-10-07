import { isValidBrandHex } from './inline-ad-layout'

/** Assigned by the server to an approved Freebuff partner, never inferred from copy. */
export type PartnerBrand = 'greptile'

export interface PartnerBrandCreative {
  partnerBrand?: PartnerBrand
  brandColor?: string | null
  brandInk?: string | null
}

/** Ordinary placements only wear Greptile's branding. Custom slots have their own policy. */
export function greptileBrandColors(ad: PartnerBrandCreative) {
  return ad.partnerBrand === 'greptile' &&
    isValidBrandHex(ad.brandColor) &&
    isValidBrandHex(ad.brandInk)
    ? { background: ad.brandColor!, ink: ad.brandInk! }
    : null
}
