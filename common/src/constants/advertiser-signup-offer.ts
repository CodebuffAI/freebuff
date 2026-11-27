/** Ongoing offer; only the advertiser's individual qualification window ends. */
export const AD_SIGNUP_OFFER_PROGRAM = 'signup_spend_500_2026'
export const AD_SIGNUP_OFFER_START = '2026-09-21T07:00:00.000Z'
export const AD_SIGNUP_OFFER_WINDOW_DAYS = 30
export const AD_SIGNUP_OFFER_SPEND_CENTS = 50_000
export const AD_SIGNUP_OFFER_CREDIT_CENTS = 50_000
/** Accounts created before this instant retain the original offer terms. */
export const AD_SIGNUP_OFFER_TRACKING_START = '2026-11-27T08:00:00.000Z'

export const AD_SIGNUP_OFFER_HEADLINE = 'Spend $500. Get $500 in ad credit.'
export const AD_SIGNUP_OFFER_TERMS =
  'Credit is awarded once qualifying spend is paid. Deposits alone and spend covered by promotional credit do not qualify. No partial rewards. Credit expires 60 days after it is awarded, has no cash value, and may be reversed after refunds or chargebacks.'
export const AD_SIGNUP_OFFER_TRACKING_TERMS =
  'For accounts created from November 27, 2026 (Pacific), conversion tracking must also be verified on a campaign contributing qualifying spend. Receiving that campaign’s goal event, from a test event or a real attributed click, verifies setup. A page view or an API key alone does not. Existing accounts retain their original offer terms.'

export function advertiserSignupOfferRequiresTracking(signupAt: Date): boolean {
  return signupAt.getTime() >= new Date(AD_SIGNUP_OFFER_TRACKING_START).getTime()
}

export function advertiserSignupOfferDeadline(signupAt: Date): Date {
  return new Date(signupAt.getTime() + AD_SIGNUP_OFFER_WINDOW_DAYS * 86_400_000)
}

