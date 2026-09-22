/** Ongoing offer; only the advertiser's individual qualification window ends. */
export const AD_SIGNUP_OFFER_PROGRAM = 'signup_spend_500_2026'
export const AD_SIGNUP_OFFER_START = '2026-09-21T07:00:00.000Z'
export const AD_SIGNUP_OFFER_WINDOW_DAYS = 30
export const AD_SIGNUP_OFFER_SPEND_CENTS = 50_000
export const AD_SIGNUP_OFFER_CREDIT_CENTS = 50_000

export const AD_SIGNUP_OFFER_HEADLINE = 'Spend $500. Get $500 in ad credit.'
export const AD_SIGNUP_OFFER_DESCRIPTION =
  'Spend $500 on placements in your first 30 days after creating your ads account to unlock a one-time $500 promotional credit.'
export const AD_SIGNUP_OFFER_TERMS =
  'Credit is awarded once qualifying spend is paid. Deposits alone and spend covered by promotional credit do not qualify. No partial rewards. Credit expires 60 days after it is awarded, has no cash value, and may be reversed after refunds or chargebacks.'

export function advertiserSignupOfferDeadline(signupAt: Date): Date {
  return new Date(signupAt.getTime() + AD_SIGNUP_OFFER_WINDOW_DAYS * 86_400_000)
}
