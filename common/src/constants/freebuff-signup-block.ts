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
  // A new account on a privacy, alias or disposable mail provider
  // (`isPrivacyEmailDomain` in @codebuff/auth/link-guard).
  | 'email_provider_not_allowed'
  // Email/password sign-ups only (docs/freebuff-email-password.md): the
  // signup gate could not run, and that path fails closed where OAuth fails
  // open.
  | 'privacy_unverified'
  // Email/password sign-ups only: 3 new accounts on one custom email domain
  // today (`EMAIL_DOMAIN_DAILY_ACCOUNTS`).
  | 'email_domain_velocity'
  // The sign-up email policy (docs/freebuff-email-password.md → "Email domain
  // policy"), email/password and GitHub sign-ups: a domain whose mail servers
  // only forward (catch-all routing, alias relays) ...
  | 'email_forwarding_not_allowed'
  // ... a domain with no mail server ...
  | 'email_domain_no_mail'
  // ... a custom domain in a full-access country, before the person confirms
  // it (the login pages offer a confirmation, not only this copy) ...
  | 'email_domain_unlisted_confirm'
  // ... and a custom domain anywhere else.
  | 'email_domain_not_mainstream'
  // Another account on this browser or Fingerprint visitor is banned for what
  // it did (`deviceLinkedToEvidenceBan` in @codebuff/auth/signup-gate-server).
  | 'device_linked_to_banned_account'

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
  email_provider_not_allowed:
    "New accounts can't use a temporary, disposable, privacy or alias email address (such as a temp-mail inbox, Proton Mail, Tutanota, DuckDuckGo or Firefox Relay). Please sign up with Gmail, Outlook, iCloud, or your work or school email. If you use GitHub, make one of those your primary email in GitHub's settings (Settings → Emails) first.",
  privacy_unverified:
    "We couldn't check your connection just now. Please try again in a few minutes, or continue with another sign-in method.",
  email_domain_velocity:
    'Too many accounts have been created with this email domain today. Please try again tomorrow, or continue with Google, Apple or GitHub.',
  email_forwarding_not_allowed:
    "This address forwards mail through a routing service (such as Cloudflare Email Routing or ImprovMX), so it can't open a new account. Please sign up with the mailbox it forwards to, like your Gmail, Outlook or iCloud address. If you use GitHub, make that address your primary email in GitHub's settings (Settings → Emails) first.",
  email_domain_no_mail:
    "This email domain has no mail server, so it can't receive mail. Check the address, or sign up with Gmail, Outlook or iCloud.",
  email_domain_unlisted_confirm:
    "This email isn't from a mainstream provider. You can still use it, but the account gets tighter limits and may need to verify a phone number by SMS (or have a paid plan). For the smoothest start, use Gmail, Outlook, iCloud or Yahoo, or continue with Google.",
  email_domain_not_mainstream:
    "In your region, new accounts need an email from a mainstream provider: Gmail, Outlook, iCloud or Yahoo, or a work or school address hosted by Google or Microsoft. Please use one of those, or continue with Google. If you use GitHub, make one of those your primary email in GitHub's settings (Settings → Emails) first.",
  device_linked_to_banned_account:
    "An account that was suspended has used this browser, so new accounts can't be created from it. If that account was yours, you can appeal from its Standing tab after signing in to it. If you think this is a mistake, contact support.",
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
