/**
 * Converts a credit amount to USD cents.
 * @param credits The number of credits to convert
 * @param centsPerCredit The cost per credit in cents
 * @returns The amount in USD cents
 * @throws Error if centsPerCredit is not positive or credits is not finite
 */
export function convertCreditsToUsdCents(
  credits: number,
  centsPerCredit: number,
): number {
  if (!(centsPerCredit > 0)) {
    throw new Error(
      `convertCreditsToUsdCents: centsPerCredit must be positive, got ${centsPerCredit}`,
    )
  }
  if (!Number.isFinite(credits)) {
    throw new Error(
      `convertCreditsToUsdCents: credits must be finite, got ${credits}`,
    )
  }
  return Math.ceil(credits * centsPerCredit)
}

/**
 * Converts a Stripe grant amount in cents to credits.
 * @param amountInCents The amount in USD cents
 * @param centsPerCredit The cost per credit in cents
 * @returns The number of credits
 * @throws Error if centsPerCredit is not positive or amountInCents is not finite
 */
export function convertStripeGrantAmountToCredits(
  amountInCents: number,
  centsPerCredit: number,
): number {
  if (!(centsPerCredit > 0)) {
    throw new Error(
      `convertStripeGrantAmountToCredits: centsPerCredit must be positive, got ${centsPerCredit}`,
    )
  }
  if (!Number.isFinite(amountInCents)) {
    throw new Error(
      `convertStripeGrantAmountToCredits: amountInCents must be finite, got ${amountInCents}`,
    )
  }
  return Math.floor(amountInCents / centsPerCredit)
}
