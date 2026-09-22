/** Ads acquisition is a separate dataset and enrollment from the coding product. */
import { validMetaBrowserId } from './meta-conversions'

export const META_CONSUMER_CLICK_COOKIE = 'freebuff_meta_consumer_fbc'
export const META_ADS_PERMISSION_COOKIE = 'freebuff_meta_ads_allowed'
export const META_ADS_CLICK_COOKIE = 'freebuff_meta_ads_fbc'
export const META_ADS_FUNNEL_COOKIE = 'freebuff_meta_ads_funnel'
export type MetaAdsEventName =
  | 'CompleteRegistration'
  | 'CampaignSubmitted'
  | 'AddPaymentInfo'

/** Preserve legacy consumer attribution until this browser enters Ads. From
 * then on the scoped cookie (including the `none` sentinel) is authoritative:
 * the Ads SDK may replace Meta's shared _fbc at any time. */
export function readConsumerMetaClickCookie(
  readCookie: (name: string) => string | undefined,
): string | undefined {
  const scoped = readCookie(META_CONSUMER_CLICK_COOKIE)
  return validMetaBrowserId(scoped === undefined ? readCookie('_fbc') : scoped)
}

export function isAdsLogin(search: string): boolean {
  const query = new URLSearchParams(search)
  if (query.has('auth_code')) return false
  return ['callbackUrl', 'next'].some((key) => {
    const target = query.get(key)
    if (!target) return false
    try {
      const url = new URL(target, 'https://freebuff.com')
      return (
        url.origin === 'https://freebuff.com' &&
        (url.pathname === '/ads' || url.pathname.startsWith('/ads/'))
      )
    } catch {
      return false
    }
  })
}

export function isAdsAcquisitionPage(pathname: string, search = '') {
  const path = pathname.replace(/\/$/, '')
  return path === '/advertisers' || (path === '/login' && isAdsLogin(search))
}
