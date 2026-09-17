/**
 * Converts a credit amount to USD cents.
 * @param credits The number of credits to convert
 * @param centsPerCredit The cost per credit in cents
 * @returns The amount in USD cents
 */
export function convertCreditsToUsdCents(
  credits: number,
  centsPerCredit: number,
): number {
  if (centsPerCredit <= 0) return 0
  if (!Number.isFinite(credits)) return 0
  return Math.ceil(credits * centsPerCredit)
}

/**
 * Converts a Stripe grant amount in cents to credits.
 * @param amountInCents The amount in USD cents
 * @param centsPerCredit The cost per credit in cents
 * @returns The number of credits
 */
export function convertStripeGrantAmountToCredits(
  amountInCents: number,
  centsPerCredit: number,
): number {
  if (centsPerCredit <= 0) return 0
  if (!Number.isFinite(amountInCents)) return 0
  return Math.floor(amountInCents / centsPerCredit)
}
