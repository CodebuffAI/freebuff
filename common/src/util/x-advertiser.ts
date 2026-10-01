/** Advertiser acquisition never reads the coding-product click cookie. */
export const X_ADVERTISER_CLICK_COOKIE = 'freebuff_x_advertiser_click'
export const X_ADVERTISER_PERMISSION_COOKIE = 'freebuff_x_advertiser_allowed'
export type XAdvertiserEvent =
  | 'AccountCreated'
  | 'Login'
  | 'CompleteRegistration'
  | 'CampaignSubmitted'
  | 'AddPaymentInfo'

// X Ads account 18ce55rlpn6 / pixel rfga1. Public identifiers, not secrets.
export const X_ADVERTISER_PIXEL_ID = 'rfga1'
export const X_ADVERTISER_START_EVENT_ID = 'tw-rfga1-rg7df'
export const X_ADVERTISER_EVENTS: Record<XAdvertiserEvent, string> = {
  AccountCreated: 'tw-rfga1-rg7dx',
  Login: 'tw-rfga1-rg7dy',
  CompleteRegistration: 'tw-rfga1-rg7d8',
  CampaignSubmitted: 'tw-rfga1-rg7db',
  AddPaymentInfo: 'tw-rfga1-rg7dc',
}
