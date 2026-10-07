import { RGBA } from '@opentui/core'
import {
  greptileBrandColors,
  type PartnerBrandCreative,
} from '@codebuff/common/ads/partner-brand'
import { supportsTruecolor } from '../utils/theme-system'

/** Keep Greptile green on Apple Terminal too, using indexed terminal colours. */
export function greptileTerminalColors(
  ad: PartnerBrandCreative,
  truecolor = supportsTruecolor(),
) {
  if (ad.partnerBrand !== 'greptile') return null
  const brand = truecolor ? greptileBrandColors(ad) : null
  return brand ?? { background: RGBA.fromIndex(48), ink: RGBA.fromIndex(16) }
}
