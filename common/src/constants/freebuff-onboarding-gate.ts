/**
 * Who gets shown the onboarding form.
 *
 * Nothing here is a permission check. Onboarding never refuses a request on any
 * surface — the entire mechanism is one redirect, to a form with a Skip button,
 * fired at most once per browser. What this decides is who is interrupted.
 *
 * The answer is: **anyone who has not answered, once.** New signups get it on
 * their way in; a long-standing account gets it the next time they sign in
 * through the web portal. There is deliberately no cutover date any more. One
 * existed when the form was a blocking gate, to keep existing users from being
 * locked out of a product they already used — with nothing to lock them out of,
 * a cutover only means never learning anything about the accounts we already
 * have. The Skip button and the seen-cookie are what protect them now,
 * and they cost a single dismissible screen instead of an exemption.
 *
 * The polarity is deliberate: **an unset or `off` switch shows it to NOBODY.**
 * Absence of config disables the feature rather than enabling it universally.
 * This repo has already paid for the opposite convention once — a deleted env
 * var silently activating a default is documented in
 * db-capacity-and-scaling.md §10.6 — and here that mistake would present as
 * every user meeting a form nobody decided to launch.
 */

export type OnboardingRequirementInput = {
  /** Parsed `FREEBUFF_ONBOARDING_ENABLED`. */
  enabled: boolean
  /** Whether the user has answered every question. */
  complete: boolean
}

export type OnboardingRequirement =
  | { required: false; reason: 'gate_disabled' | 'already_complete' }
  | { required: true }

export function evaluateOnboardingRequirement(
  input: OnboardingRequirementInput,
): OnboardingRequirement {
  // Not switched on — nobody is asked. See the polarity note above.
  if (!input.enabled) return { required: false, reason: 'gate_disabled' }
  if (input.complete) return { required: false, reason: 'already_complete' }
  return { required: true }
}

/**
 * Read the on/off switch.
 *
 * Anything other than an explicit affirmative is off, so a typo, an empty
 * string or a deleted variable all fail the same safe way.
 */
export function parseOnboardingEnabled(raw: string | null | undefined): boolean {
  const trimmed = raw?.trim().toLowerCase()
  return trimmed === 'on' || trimmed === 'true' || trimmed === '1'
}

