/**
 * Signup-refusal reasons and their user-facing copy.
 *
 * Lives in `common`, not in `packages/auth`, because the login pages are client
 * components: importing this from the auth barrel would drag `db`, `stripe` and
 * the server env schema into the browser bundle. The decision logic stays in
 * `@codebuff/auth/signup-gate`; only the vocabulary is shared.
 */

/** Why a signup was refused. Also the `?error=` code on the login redirect. */
export type SignupBlockReason =
  | 'captcha_missing'
  | 'captcha_invalid'
  // Deliberately distinct from the two above rather than folded into them.
  // The providers fail for different populations — a filter that blocks
  // challenges.cloudflare.com usually does not block www.google.com, and vice
  // versa — so a shared reason code would make the one question worth asking
  // after a refusal spike ("which provider is failing?") unanswerable from the
  // logs. That is exactly the ambiguity that cost four attempts on 2026-08-12.
  | 'recaptcha_missing'
  | 'recaptcha_invalid'
  | 'mailbox_already_registered'
  | 'privacy_egress'
  | 'untrusted_client_ip'
  | 'ip_signup_velocity'
  | 'prefix_signup_velocity'
  // Not a signup decision: the GitHub sign-in gate (`isVerifiedGitHubEmail`)
  // refuses an address GitHub does not list as verified, signup or not. It
  // shares this vocabulary so the login pages explain it like the others.
  | 'github_email_unverified'

/**
 * Deliberately actionable and non-accusatory.
 *
 * Someone hitting `privacy_egress` is far more likely to be a privacy-conscious
 * developer on a VPN than a reseller, and the message they get should name the
 * one thing that fixes it rather than implying they did something wrong. A
 * refused signup with no explanation is indistinguishable from the product
 * being broken, and generates a support ticket instead of a retry.
 */
export const SIGNUP_BLOCK_MESSAGES: Record<SignupBlockReason, string> = {
  captcha_missing:
    'Please complete the verification check on the sign-in page and try again.',
  captcha_invalid:
    'That verification check could not be confirmed. Please try again.',
  // Names the host, because the overwhelmingly likely cause is an extension or
  // DNS filter blocking it — a cause the user can fix in ten seconds if they
  // know it and cannot fix at all if they do not. Retrying does not help here,
  // so "please try again" alone would be actively misleading.
  recaptcha_missing:
    'Please complete the verification check on the sign-in page and try again. If it never appeared, an ad blocker or network filter may be blocking www.google.com/recaptcha.',
  recaptcha_invalid:
    'That verification check could not be confirmed. Please try again.',
  mailbox_already_registered:
    'An account already exists for this email address. Try signing in instead.',
  privacy_egress:
    'Accounts cannot be created over a VPN, proxy, or hosting provider. Please turn it off and try again — you can turn it back on afterwards.',
  untrusted_client_ip:
    'We could not verify where this request came from. Please try again, or contact support if it keeps happening.',
  ip_signup_velocity:
    'Too many accounts have been created from this network today. Please try again tomorrow, or contact support if you are on a shared connection.',
  prefix_signup_velocity:
    'Too many accounts have been created from this network today. Please try again tomorrow, or contact support if you are on a shared connection.',
  // Also shown when GitHub's API could not be reached: the gate fails closed,
  // and the same two remedies apply.
  github_email_unverified:
    "GitHub sign-in needs a verified email. Verify your email in GitHub's settings (Settings → Emails) and try again, or sign in with Google instead. If your email is already verified, GitHub may be temporarily unreachable; please try again in a few minutes.",
}

/** True when `code` is a reason this module has copy for. Narrows an untrusted
 *  query-string value without a cast at every call site. */
export function isSignupBlockReason(
  code: string | null | undefined,
): code is SignupBlockReason {
  return Boolean(code) && code! in SIGNUP_BLOCK_MESSAGES
}
