/**
 * Freebuff referral program constants.
 *
 * The referral REWARD is consolidated (2026-07-30) to exactly two things,
 * both session-shaped and both defined next to the pools they feed:
 *
 *   - FULL access tier: +1 daily GLM 5.2 session per qualified referral,
 *     the whole earned pool capped at FREEBUFF_REWARD_MAX_DAILY_SESSIONS
 *     since 2026-08-25 (glmWeeklySessionsFromStats in packages/billing). On
 *     the Freebucks meter each one is also a once-ever, uncapped cash-out
 *     (FREEBUCKS_PER_EARNED_SESSION).
 *   - LIMITED access tier: +1 daily free session per qualified referral,
 *     capped at REFERRAL_CLI_DAILY_SESSION_BONUS_CAP (GLM is geo-gated).
 *
 * The old web tier ladder (tiered daily message limits + deploy-watermark
 * removal) is GONE: the limits were never enforced anywhere — real limits are
 * the session pools in freebuff-models.ts — and the "Powered by Freebuff"
 * deploy watermark is globally disabled (prod_branding_injection_enabled =
 * false), so both perks were marketing for things users didn't get. What
 * remains in this file is the qualification machinery: GitHub account-age
 * bars and attribution windows.
 *
 * There is NO per-referrer cap on how many referrals are recorded or counted.
 * The legacy per-program ceilings (the web program's 20 and the CLI program's
 * `user.referral_limit`) went with the 2026-07-16 referral_v2 cutover, and
 * referral_v2's own 100-row signup limit was removed on 2026-09-23 (#3800).
 * Refusals under that limit are replayed by scripts/referral-cap-backfill.ts.
 */

/** Referred users must have a GitHub account at least this old for the
 *  referral to count. Younger accounts can still sign up normally — the
 *  referrer just gets no credit. */
export const MIN_GITHUB_ACCOUNT_AGE_MONTHS = 4

/** GLM 5.2 referral program uses a stricter account-age bar than the web
 *  program (no public-repo requirement, but the account must be a full year
 *  old). */
export const MIN_GITHUB_ACCOUNT_AGE_MONTHS_GLM = 12

/**
 * Unified referral system (docs/referrals.md): a single 4-month GitHub
 * account-age bar for ALL products (no public-repo requirement), consolidating
 * the old per-program bars (cli/glm = 12mo, web = 4mo).
 */
export const MIN_GITHUB_ACCOUNT_AGE_MONTHS_REFERRAL = 4

/**
 * Freebuff CLI limited-tier perk: each qualified referral whose referred user
 * activated at the *limited* access tier grants +1 daily free-mode session,
 * capped here (e.g. 6 base + 3 = 9/day). Full-access referrals instead grant
 * GLM sessions, which are uncapped.
 */
export const REFERRAL_CLI_DAILY_SESSION_BONUS_CAP = 3

/**
 * A referral can only be attributed within this many days of the referred
 * user's signup — stops a referrer from claiming long-pre-existing accounts.
 * Shared by the unified referral_v2 redemption path and its clients.
 */
export const REFERRAL_SIGNUP_WINDOW_DAYS = 30

/** Whether a GitHub account created at `githubCreatedAtMs` satisfies the
 *  referral age requirement at time `nowMs`. Months are computed on the
 *  calendar (e.g. created Jan 15 qualifies on/after May 15). `minMonths`
 *  defaults to the web bar; the GLM program passes
 *  MIN_GITHUB_ACCOUNT_AGE_MONTHS_GLM. */
export function isGithubAccountOldEnoughForReferral(
  githubCreatedAtMs: number | null | undefined,
  nowMs: number = Date.now(),
  minMonths: number = MIN_GITHUB_ACCOUNT_AGE_MONTHS,
): boolean {
  if (githubCreatedAtMs == null || !Number.isFinite(githubCreatedAtMs)) {
    return false
  }
  const threshold = new Date(githubCreatedAtMs)
  threshold.setUTCMonth(threshold.getUTCMonth() + minMonths)
  return nowMs >= threshold.getTime()
}
