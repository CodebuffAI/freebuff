/**
 * The advertiser marketplace: what an engagement costs, what a campaign may
 * buy, and what a promoted post is allowed to be.
 *
 * ## The economics in one paragraph
 *
 * An advertiser funds a campaign at a whole-dollar DAILY rate, charged as a
 * daily subscription for as long as the campaign runs. That one number is both
 * the PRICE and the DELIVERY CAP: `AD_ENGAGEMENT_PRICE_CENTS` divides it into
 * engagements, so $10/day is $10 a day and up to 20 engagements a day, and the
 * dashboard says exactly that.
 *
 * `AD_ENGAGEMENT_PRICE_CENTS` is therefore a DIVISOR, not a line item. Nothing
 * is billed per engagement — see `server/advertisers/billing.ts` for why the
 * metered version was replaced.
 *
 * ## Why flat pricing, and why $0.50
 *
 * Auctions are the right answer when supply is scarce and buyers differ in
 * willingness to pay. Neither is true here at launch: the supply is our own
 * users' attention, and it is elastic in the only direction that matters
 * (more posts to engage with makes the Earn page *better*, not worse). A flat
 * price means an advertiser can compute their reach before they sign up, which
 * is the single thing every self-serve ad product gets wrong.
 *
 * $0.50 is anchored on what the alternative costs. A LinkedIn or X promoted
 * post is billed per impression or per click and routinely lands in the
 * $8-15 CPM / $2-5 CPC range for a developer audience — and buys *impressions*,
 * which the platforms then use as a reason to suppress the post's organic
 * reach. Here the unit is an engagement, engagements are the input to every
 * social ranking function there is, and the post's organic distribution goes
 * UP rather than down.
 */

// ---------------------------------------------------------------------------
// The day boundary
// ---------------------------------------------------------------------------

/**
 * Every daily boundary in the ads system — spend caps, per-user engagement
 * ceilings, delivery reporting, the placements spend ledger's `day` column —
 * is a PACIFIC calendar day.
 *
 * Not UTC, and this is worth one line of explanation: every other daily budget
 * in the product already resets Pacific (session pools, spend ceilings,
 * `freebuff_daily_usage`), and an advertiser whose "day" ended at a different
 * hour than the user quota that feeds it would see delivery that appears to
 * arrive before it was funded.
 *
 * It lives in `common` rather than beside the console because the Stripe
 * webhook — in `web/`, which cannot import `freebuff/web` — has to compute the
 * same day the console does.
 */
export const AD_RESET_TIMEZONE = 'America/Los_Angeles'

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * What one approved engagement draws against the daily budget.
 *
 * The rate that turns a daily rate into a delivery cap, not a price the
 * advertiser is ever invoiced at — they pay `daily_budget_cents` per day
 * whatever the day delivers.
 */
export const AD_ENGAGEMENT_PRICE_CENTS = 50

/** Floor for a campaign's daily rate, and the smallest daily charge. Twenty
 *  engagements a day is the least delivery that produces a legible result
 *  rather than noise. */
export const AD_MIN_DAILY_BUDGET_CENTS = 1_000

/** Daily rates are chosen in $5 steps. Increments smaller than the price of
 *  ten engagements make the slider precise about a number that is inherently
 *  approximate — delivery is capped by supply, not by the cent. */
export const AD_DAILY_BUDGET_STEP_CENTS = 500

/** Slider ceiling. Not a hard limit on what we will take — an advertiser who
 *  wants more talks to us — but past this the self-serve flow stops being the
 *  right shape. */
export const AD_MAX_DAILY_BUDGET_CENTS = 100_000

export function engagementsForDailyBudget(cents: number): number {
  return Math.floor(cents / AD_ENGAGEMENT_PRICE_CENTS)
}

/**
 * A scheduled taper of a campaign's delivery cap.
 *
 * ## Why a campaign would want to go DOWN
 *
 * A campaign that works can outrun what the advertiser wanted from it. Weave's
 * GitHub-star campaign went 21 -> 288 -> 531 approved engagements in three
 * days and they asked us to hold it near 300/day for a few weeks — not to stop
 * it, and not to cliff-edge it either. Editing the budget straight to the
 * target does that in the crudest way available: the cap binds mid-afternoon,
 * the feed empties for the rest of the day, and the delivery curve gets a step
 * in it that nobody reading the numbers later can explain.
 *
 * ## Why the cap is randomized
 *
 * A ceiling that steps down on a published schedule is a ceiling anyone can
 * predict — including accounts that watch this feed for supply and time their
 * claims to the start of a Pacific day. Jitter costs the advertiser nothing
 * (the curve still lands on the target) and stops the day's ceiling from being
 * a number anyone can read off a calendar.
 *
 * ## Why it is computed, never written
 *
 * No job walks campaigns lowering budgets. Deployed web route timers do not
 * fire here (see the repo's ops notes), and a daily writer is one more thing
 * that can stop silently — leaving a campaign pinned at whatever cap it
 * happened to reach, which is exactly the failure a taper must not have. The
 * glide is a pure function of the campaign row and today's Pacific date, so
 * every read is correct whether or not anything ran, and a missed day heals
 * itself.
 */
export interface BudgetGlide {
  /** Cap the taper starts from, in cents/day. */
  startCents: number
  /** Cap it lands on and stays at, in cents/day. */
  targetCents: number
  /** Days from `startedOn` to reach `targetCents`. */
  days: number
  /** Randomization around the curve, in basis points (1_000 = 10%). */
  jitterBps: number
  /**
   * Shape of the descent.
   *
   * `linear` walks down in equal steps. `exponential` takes the same ratio off
   * every day, so most of the reduction happens immediately and the tail is
   * long and shallow — which is what "make it drop off" actually looks like on
   * a cumulative chart, and what a linear taper cannot produce: halfway
   * through a linear taper the campaign is still delivering half its original
   * volume, and the curve people are looking at is still visibly climbing.
   */
  curve: 'linear' | 'exponential'
  /**
   * Pacific calendar day the taper starts, `YYYY-MM-DD`.
   *
   * A plain date, not a timestamp: every cap in this system is keyed to a
   * Pacific DAY, and a timestamp here would invite exactly the offset bugs
   * that keep finding this repo.
   */
  startedOn: string
}

/**
 * Deterministic 32-bit hash. Same campaign, same day, same cap — a jitter that
 * moved between two reads inside one day would let a caller reroll the ceiling
 * by retrying.
 *
 * FNV-1a, then an avalanche finalizer, and the finalizer is not optional here.
 * Every key this is called with is a long shared prefix plus a couple of
 * changing characters at the end (`<campaign id>:2026-08-28T09`), and raw
 * FNV-1a leaves those last characters in the LOW bits. Scaling the raw value
 * by 0xffffffff reads mostly the high bits, so twenty-four consecutive hours
 * came out with two distinct values between them — a "randomized" ceiling that
 * was, in practice, a constant.
 */
function glideHash(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  // lowbias32 finalizer: spreads the low bits across the whole word.
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d) >>> 0
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x846ca68b) >>> 0
  hash ^= hash >>> 16
  return hash >>> 0
}

/** Whole days between two `YYYY-MM-DD` Pacific dates. */
function daysBetweenPacificDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return 0
  return Math.round((end - start) / 86_400_000)
}

/**
 * Today's cap for a glide, in cents.
 *
 * Linear from `startCents` to `targetCents`, with jitter applied only WHILE
 * descending: the taper wobbles, the floor does not. An advertiser told "it
 * settles around 300 a day" should get 300, not 270 on an unlucky Tuesday six
 * weeks later.
 *
 * Clamped to the two endpoints in both directions, so jitter can never lift
 * the cap above where it started nor push it under the target — the only two
 * numbers anyone actually agreed to.
 */
export function glidedDailyBudgetCents(params: {
  glide: BudgetGlide
  /** Stable per-campaign seed; the campaign id. */
  seed: string
  /** Today, as a Pacific `YYYY-MM-DD`. */
  today: string
}): number {
  const { glide, seed, today } = params
  const low = Math.min(glide.startCents, glide.targetCents)
  const high = Math.max(glide.startCents, glide.targetCents)

  const elapsed = daysBetweenPacificDays(glide.startedOn, today)
  if (elapsed <= 0) return normalizeDailyBudgetCents(glide.startCents)
  if (glide.days <= 0 || elapsed >= glide.days) {
    return normalizeDailyBudgetCents(glide.targetCents)
  }

  const progress = elapsed / glide.days
  // Geometric for `exponential`: the same PROPORTION comes off each day, so
  // day one takes the biggest absolute cut and the approach to the target is
  // asymptotic. Falls back to linear if either end is zero, where a ratio is
  // undefined.
  const straight =
    glide.curve === 'exponential' && glide.startCents > 0 && glide.targetCents > 0
      ? glide.startCents *
        Math.pow(glide.targetCents / glide.startCents, progress)
      : glide.startCents + (glide.targetCents - glide.startCents) * progress

  // Hash to [-1, 1], then scaled by the jitter width.
  const unit = (glideHash(`${seed}:${today}`) / 0xffffffff) * 2 - 1
  const jittered = straight * (1 + (unit * glide.jitterBps) / 10_000)

  return normalizeDailyBudgetCents(Math.min(high, Math.max(low, jittered)))
}

/**
 * The daily budget the DELIVERY rules should use for a campaign.
 *
 * The fence is the point: a glide is ignored on a campaign with a live
 * subscription. There, `daily_budget_cents` is the PRICE as well as the cap,
 * and quietly delivering less than the advertiser is charged for is the bug
 * fixed on 2026-08-27 wearing a different hat. Tapering a paying campaign
 * means moving its price too — an explicit budget edit, which syncs Stripe —
 * never a schedule the invoice knows nothing about.
 */
export function effectiveDailyBudgetCents(params: {
  dailyBudgetCents: number
  glide: BudgetGlide | null
  /** Whether Stripe is charging for this campaign. */
  billedBySubscription: boolean
  seed: string
  today: string
}): number {
  if (!params.glide || params.billedBySubscription) {
    return params.dailyBudgetCents
  }
  return glidedDailyBudgetCents({
    glide: params.glide,
    seed: params.seed,
    today: params.today,
  })
}

/** Length of the rolling window a tapering campaign is rate-limited over. */
export const DELIVERY_PACE_WINDOW_MINUTES = 60

/**
 * The most a tapering campaign may deliver in any TRAILING hour.
 *
 * ## Why a rolling window, and not a share of the day
 *
 * The first version of pacing compared today's delivery against the fraction
 * of the Pacific day that had elapsed. That stops a campaign spending its
 * whole day before lunch, and nothing else — because unspent allowance
 * accumulates, which is the same as saying a burst is always available if you
 * wait for one. A quiet morning makes 150 engagements claimable in a single
 * minute at 6pm, and the moment of the daily reset is the worst case of all:
 * the cumulative rule is satisfied instantly at midnight, so a queue of people
 * waiting for the reset empties the opening allowance the second it lands.
 *
 * A trailing window has no stockpile. The ceiling is the same at 00:01 as at
 * 18:00, so the reset stops being an event worth waiting for, and a wind-down
 * is spread over the hours it is supposed to be spread over.
 *
 * The trade, stated plainly: a day whose demand is lumpy under-delivers
 * against its daily cap, because the capacity a quiet hour did not use is
 * gone. For a campaign being deliberately wound down that is the point. It is
 * also why only tapering campaigns are paced — an advertiser paying a daily
 * rate bought a day of delivery, not a delivery schedule.
 *
 * The per-window jitter is seeded on the hour, so the cadence is not a clock
 * anyone can set a timer to, for the same reason the daily cap is jittered.
 */
export function deliveryWindowLimit(params: {
  /** Today's cap, in engagements. */
  capEngagements: number
  /** Stable per-campaign seed; the campaign id. */
  seed: string
  /** The Pacific hour, `YYYY-MM-DDTHH`. */
  windowKey: string
  jitterBps: number
}): number {
  const cap = Math.max(0, Math.floor(params.capEngagements))
  if (cap === 0) return 0
  const windows = 1_440 / DELIVERY_PACE_WINDOW_MINUTES
  const base = cap / windows
  const unit = (glideHash(`${params.seed}:${params.windowKey}`) / 0xffffffff) * 2 - 1
  const jittered = base * (1 + (unit * params.jitterBps) / 10_000)
  // At least one an hour: a campaign tapered to 50/day still has to be able to
  // deliver, and a floor of zero would strand the last stretch of every taper
  // at no delivery rather than a slow one.
  return Math.max(1, Math.min(cap, Math.round(jittered)))
}

/**
 * The smallest gap between two deliveries on a tapering campaign, in seconds.
 *
 * The window limit above bounds an HOUR; it does nothing inside one. Thirteen
 * engagements are allowed in the first minute of the window and then nothing
 * for fifty-nine — and because the window is trailing, the next batch becomes
 * available exactly as the last one ages out, so the campaign settles into a
 * pulse. That is the reset problem again at a smaller scale: bursty, and
 * something a user can learn the rhythm of.
 *
 * Spacing turns the hour's allowance into a drip: a day's cap divided into the
 * day, jittered per hour so it is a rhythm rather than a metronome.
 *
 * This gates OFFERING only. It is deliberately not applied when a submission
 * arrives: someone who was shown a post and did the work must not be refused
 * because another user's engagement landed forty seconds earlier. The daily
 * cap and the window are what enforce totals; this shapes when the feed hands
 * work out.
 */
export function deliverySpacingSeconds(params: {
  capEngagements: number
  seed: string
  /** The Pacific hour, `YYYY-MM-DDTHH`. */
  windowKey: string
  jitterBps: number
}): number {
  const cap = Math.max(0, Math.floor(params.capEngagements))
  if (cap <= 0) return 0
  const even = 86_400 / cap
  const unit =
    (glideHash(`gap:${params.seed}:${params.windowKey}`) / 0xffffffff) * 2 - 1
  const jittered = even * (1 + (unit * params.jitterBps) / 10_000)
  // A floor, so a campaign still on a large cap is spaced rather than
  // instantaneous, and a ceiling of an hour, so the tail of a taper does not
  // spend the day waiting on a gap longer than the window it lives in.
  return Math.min(3_600, Math.max(15, Math.round(jittered)))
}

/** Snap an arbitrary cent amount onto the ladder the slider offers. Applied
 *  server-side as well as in the UI: the API is public and a hand-rolled
 *  request must not be able to buy $10.37/day. */
export function normalizeDailyBudgetCents(cents: number): number {
  const stepped =
    Math.round(cents / AD_DAILY_BUDGET_STEP_CENTS) * AD_DAILY_BUDGET_STEP_CENTS
  return Math.min(
    AD_MAX_DAILY_BUDGET_CENTS,
    Math.max(AD_MIN_DAILY_BUDGET_CENTS, stepped),
  )
}

export function isValidDailyBudgetCents(cents: number): boolean {
  return (
    Number.isInteger(cents) &&
    cents >= AD_MIN_DAILY_BUDGET_CENTS &&
    cents <= AD_MAX_DAILY_BUDGET_CENTS &&
    cents % AD_DAILY_BUDGET_STEP_CENTS === 0
  )
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

export const AD_PLATFORMS = ['twitter', 'linkedin', 'reddit', 'github'] as const
export type AdPlatform = (typeof AD_PLATFORMS)[number]

export const AD_PLATFORM_LABELS: Record<AdPlatform, string> = {
  twitter: 'X / Twitter',
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
  github: 'GitHub',
}

/**
 * What "engaged" means on each platform, in the user's own words.
 *
 * Reddit is deliberately different. It has no repost, its culture punishes
 * anything that reads as astroturf harder than either other platform, and a
 * brigaded thread gets the *advertiser* banned rather than us. So Reddit buys
 * an upvote and a genuine comment, and the copy everywhere says "genuine".
 *
 * GitHub is a single action: star the repository. There is no comment to
 * write, so everything comment-shaped (suggestions, comment URLs, the comment
 * paste-back) is skipped for it — see `platformRequiresComment`.
 */
export const AD_PLATFORM_ACTIONS: Record<AdPlatform, readonly string[]> = {
  twitter: ['Like the post', 'Reply with a real comment', 'Repost it'],
  linkedin: ['React to the post', 'Comment something real', 'Repost it'],
  reddit: ['Upvote the post', 'Leave a genuine comment'],
  github: ['Star the repository'],
}

/**
 * Whether an engagement on this platform involves writing a comment.
 *
 * Everything comment-shaped hangs off this one predicate — the suggestion
 * generator, the comment-URL evidence field, the paste-back box — so a new
 * actions-only platform (GitHub stars) needs one entry here rather than an
 * `if platform === 'github'` in five files.
 */
export function platformRequiresComment(platform: AdPlatform): boolean {
  return platform !== 'github'
}

/** Host allowlist per platform, used to validate a submitted post URL. Hosts
 *  are matched exactly or as a subdomain suffix. */
export const AD_PLATFORM_HOSTS: Record<AdPlatform, readonly string[]> = {
  twitter: ['twitter.com', 'x.com'],
  // `lnkd.in` is LinkedIn's own shortener — advertisers paste share links in
  // that shape and rejecting them reads as "LinkedIn is not supported".
  linkedin: ['linkedin.com', 'lnkd.in'],
  reddit: ['reddit.com', 'redd.it'],
  github: ['github.com'],
}

/**
 * What someone typed, turned into something `new URL` can parse.
 *
 * People paste `x.com/you/status/123`. The scheme is not a part of the address
 * that most people think about — it is a thing browsers hide — and every URL
 * field in this product was rejecting input without it. The post form disabled
 * its own submit button and said nothing at all; the advertiser application
 * answered a scheme-less website with "Check the company name and website
 * URL.", which names the field and not the problem. An advertiser signing up
 * hit that and reported it as a silent failure, which is exactly what it was.
 *
 * Requiring the scheme protected nothing: `https://` is what we would have
 * prepended anyway. So prepend it.
 *
 * Input that already NAMES a scheme comes back untouched — including schemes
 * we want nothing to do with (`javascript:`, `mailto:`, and the `localhost:3000/x`
 * that parses as one). Those still fail every check downstream, which is the
 * point of doing it this way: a MISSING scheme becomes forgivable, a WRONG one
 * does not become invisible.
 */
export function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

/**
 * Whether a landing URL is safe to hand to the terminal card renderer as a
 * destination.
 *
 * `normalizeUrlInput` forgives a missing scheme but leaves a wrong one
 * (`javascript:`, `mailto:`, `data:`, `file:`) or a scheme-less string that
 * still fails to parse untouched — those are exactly the inputs that make
 * `extractDomain` fall back to echoing its argument and `getAdDisplayLabel`
 * claim `variant: 'domain'` regardless. This does not change either of
 * those functions (both are pinned by CLI-facing tests); it gives a caller a
 * way to refuse to render a destination that was never a real one, before it
 * gets that far.
 *
 * Only `http:`/`https:` count as servable. The explicit two-way comparison
 * matters — `u.protocol === 'https:' || 'http:'` is a truthy string literal
 * and would accept everything.
 */
export const isServableLandingUrl = (raw: string): boolean => {
  const normalized = normalizeUrlInput(raw)
  if (!normalized) return false
  try {
    const u = new URL(normalized)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

export function platformForUrl(rawUrl: string): AdPlatform | null {
  let host: string
  try {
    // Normalized, so a pasted `x.com/...` resolves to X rather than to null.
    const url = new URL(normalizeUrlInput(rawUrl))
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    host = url.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
  for (const platform of AD_PLATFORMS) {
    for (const allowed of AD_PLATFORM_HOSTS[platform]) {
      if (host === allowed || host.endsWith(`.${allowed}`)) return platform
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Campaigns are billed again.
 *
 * Was `false` for the free-campaign window. Flip to `false` to stop charging. Everything Stripe-side is intact —
 * the price lookup, the checkout, the webhook that mirrors subscription state —
 * so turning this on restores charging with no other change.
 *
 * A checked-in constant rather than an env var deliberately: this is a decision
 * about what the product costs, and it should be visible in a diff and a
 * changelog rather than living in a dashboard where nobody can see it was
 * changed or when.
 *
 * While this is false, `skipsCampaignFunding` marks every campaign paid at
 * submit. The feed keeps its single `billing_active` rule — no serving bypass
 * is added anywhere, so re-enabling pricing cannot leave a hole behind.
 */
export const AD_PRICING_ENABLED = true

/**
 * TEMPORARY: campaigns go live without an operator looking at them.
 *
 * Flip back to `true` to restore the review queue. Everything behind it is
 * intact — the queue, the admin dashboard, the submission email, the approve
 * and reject actions — so turning it on resumes reviewing with no other
 * change, and campaigns submitted while it was off stay exactly as they are.
 *
 * ## What still gates this
 *
 * The ADVERTISER is still reviewed. Nobody can create a campaign until their
 * account has been approved by hand, so this removes the second gate and not
 * the first: an unknown company still cannot put anything in front of our
 * users. What it drops is the per-campaign check on advertisers we have
 * already decided to trust.
 *
 * That is the thing to weigh before leaving it off for long. The campaign
 * review is what catches an approved advertiser promoting something different
 * from what they were approved for, and there is no automated substitute for
 * it — `/web/admin/ads/advertisers-legacy` lists every campaign, and while this is false
 * that list is a place to spot-check rather than a queue that blocks.
 */
export const AD_CAMPAIGN_REVIEW_ENABLED = false

/**
 * The end date a campaign should carry, given what the advertiser asked for.
 *
 * `null` means "runs until cancelled", and that is the default. Campaigns are
 * billed as daily subscriptions now, so an open-ended campaign has a natural
 * stopping point — the advertiser cancelling it — and the 7-day clamp that
 * existed for the free-campaign window is gone. An end date is still available
 * from the campaign's own menu for anyone with a launch window.
 */
export function resolveCampaignEndDate(
  requested: Date | null | undefined,
): Date | null {
  return requested ?? null
}

/**
 * A campaign is ONE post.
 *
 * It was 20, with the daily budget spread across the posts — and that made
 * every number on the dashboard an average over things the advertiser thinks
 * of separately. One post per campaign means the campaign's budget, delivery
 * and status describe exactly one thing, and promoting three posts is three
 * campaigns with three plainly-readable rows. Existing multi-post campaigns
 * were split by migration 0134.
 */
export const AD_MAX_POSTS_PER_CAMPAIGN = 1
export const AD_MAX_CAMPAIGNS_PER_ADVERTISER = 25
export const AD_MAX_COMMENT_EXAMPLES = 12
export const AD_MAX_COMMENT_URL_CHARS = 2_000

/**
 * The attestation a user ticks before submitting evidence.
 *
 * One sentence, in the first person, naming the consequence. It is not there
 * to be a legal instrument — it is there so that when a sweep finds a forged
 * link, the enforcement points at something the person affirmatively did
 * rather than at a policy nobody read. Same role
 * `freebuff_bounty_submission.agreed_to_terms_at` plays.
 */
export const AD_EVIDENCE_ATTESTATION =
  'I confirm I liked, reposted and commented on this post myself, and that this is genuine proof of it. I understand it will be verified, and that falsified evidence will result in my account being banned.'

/** The GitHub engagement is a star, not a comment — the attestation has to
 *  name the action the person actually took or it attests to nothing. */
export const AD_EVIDENCE_ATTESTATION_GITHUB =
  'I confirm I starred this repository myself, and that this is genuine proof of it. I understand it will be verified, and that falsified evidence will result in my account being banned.'

export function adEvidenceAttestation(platform: AdPlatform): string {
  return platform === 'github'
    ? AD_EVIDENCE_ATTESTATION_GITHUB
    : AD_EVIDENCE_ATTESTATION
}
export const AD_MAX_DESCRIPTION_CHARS = 2_000
export const AD_MAX_COMMENT_GUIDANCE_CHARS = 2_000

/**
 * What every commenter is told, on every post, in their own words.
 *
 * The feed used to hand out four ready-made comments to copy. That is exactly
 * how a thread ends up full of the same three sentences in different fonts:
 * generated options converge, everybody takes the first one, and the result
 * reads as bot output to the only audience that matters — the advertiser's
 * followers. A comment nobody wrote is worth less than no comment.
 *
 * So the card asks for a real one instead, and says plainly what that means.
 * These are the rules the user sees; the advertiser's own brief sits next to
 * them and says what the post is about.
 */
export const AD_COMMENT_WRITING_RULES = [
  'Write it yourself — do not use AI to generate it.',
  'Make it original: something nobody else would have written.',
  'Say something specific about this post, not a generic compliment.',
  'Clear, correct English. One or two sentences is plenty.',
] as const

/**
 * The default answer to "what would you like people to comment?".
 *
 * Prefilled on the campaign form so an advertiser who has no strong opinion
 * still ships something useful, and so the guidance shown in the feed is
 * never empty.
 */
export const AD_DEFAULT_COMMENT_GUIDANCE =
  'Something genuine and specific about the post, in your own words. Original and non-repetitive, in clear English — please do not use AI to write it.'

/**
 * Per-user daily ceiling on approved engagements.
 *
 * Not an anti-fraud control (the screenshot review is), but a supply one: a
 * campaign that funds 20 engagements a day should reach 20 people rather than
 * one person twenty times, or the advertiser is buying a single account's
 * opinion at scale. It is also what stops the Earn page becoming a job.
 */
export const AD_MAX_ENGAGEMENTS_PER_USER_PER_DAY = 12

/** Minimum seconds between a post being opened and its evidence being
 *  accepted. Someone who "engaged" with a LinkedIn post four seconds after
 *  seeing it did not read it. Small enough to be invisible to anyone acting in
 *  good faith. */
export const AD_MIN_ENGAGEMENT_DWELL_SECONDS = 20

/**
 * How long a FLAGGED submission blocks the user from submitting again.
 *
 * Derived rather than stored: the block is "does this account have a flagged
 * row newer than this window", which needs no column, no cron and no cleanup,
 * and expires on its own if nobody ever looks at the queue. A stored
 * `blocked_until` would outlive the operator's attention, which is the failure
 * mode that turns a cooling-off period into a silent ban.
 *
 * A day, because that is long enough to stop somebody iterating against the
 * verifier and short enough that a false positive costs a real user one
 * evening rather than their account.
 */
export const AD_FLAG_BLOCK_HOURS = 24

export const AD_MAX_EVIDENCE_IMAGES = 4
export const AD_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const AD_ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const

// ---------------------------------------------------------------------------
// Campaign lifecycle
// ---------------------------------------------------------------------------

/**
 * The campaign lifecycle. The order is the order a campaign moves through it.
 *
 *   draft → pending_review → paused (approved, unfunded) → active → paused …
 *                          ↘ rejected → (edit) → pending_review
 *
 * An approved campaign lands in `paused` rather than `active` on purpose: it
 * has no subscription yet, and a campaign that started serving before anyone
 * had paid is the one failure the whole review flow exists to prevent.
 */
export const AD_CAMPAIGN_STATUSES = [
  'draft',
  'pending_review',
  'rejected',
  'active',
  'paused',
  'ended',
] as const
export type AdCampaignStatus = (typeof AD_CAMPAIGN_STATUSES)[number]

/** User-facing label per status. `pending_review` and `rejected` are the two
 *  that need to say something an advertiser can act on. */
export const AD_CAMPAIGN_STATUS_LABELS: Record<AdCampaignStatus, string> = {
  draft: 'Draft',
  pending_review: 'In review',
  rejected: 'Changes needed',
  active: 'Live',
  paused: 'Paused',
  ended: 'Ended',
}

/**
 * Must stay in step with the `ad_engagement_status` pg enum.
 *
 * `flagged` was added to the database and not to this list, so every surface
 * typed against `AdEngagementStatus` silently could not represent the one
 * status that carries a consequence. The pg enum is the source of truth and
 * this is the mirror; changing one without the other is the mistake to watch
 * for.
 */
export const AD_ENGAGEMENT_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'skipped',
  /** The verifier refused it outright: a submit block and a human queue. */
  'flagged',
] as const
export type AdEngagementStatus = (typeof AD_ENGAGEMENT_STATUSES)[number]

/** Labels for the operator surfaces. */
export const AD_ENGAGEMENT_STATUS_LABELS: Record<AdEngagementStatus, string> = {
  pending: 'Verifying',
  approved: 'Approved',
  rejected: 'Rejected',
  skipped: 'Skipped',
  flagged: 'Flagged',
}

/**
 * Posts to showcase on the advertiser landing page as proof the thing works.
 *
 * ## Why this is a list of URLs and not a list of case studies
 *
 * The numbers beside each one are read from the DATABASE at render time —
 * real approved engagements on that real post. A post in this list that has
 * never run through the system resolves to nothing and is silently dropped,
 * which is the property that matters: there is no way to put a number on this
 * page that we did not actually deliver.
 *
 * Curated rather than "top N by engagement" because a showcase is an editorial
 * choice — the best-performing post might be off-brand, or from a customer who
 * would rather not be an advertisement for us.
 */
export const AD_SHOWCASE_POST_URLS: readonly string[] = [
  'https://x.com/victorxheng/status/2086989599646314583',
  'https://x.com/victorxheng/status/2085813482558259233',
  'https://x.com/victorxheng/status/2085502613949473014',
]

/**
 * The before/after we can show on our own account.
 *
 * ## Why the view counts live here and not in the database
 *
 * Engagements we deliver are ours to count (`showcase.ts` reads them from
 * `ad_engagement`). VIEWS are X's number, on somebody's own posts, and we have
 * no access to them — so unlike everything else on that page, these figures
 * are operator-supplied. That makes them the one place a wrong number can get
 * onto the landing page, which is why they are a checked-in constant somebody
 * has to edit deliberately rather than a field on a form.
 *
 * **Only put real numbers here, and only for an account we own.** They are a
 * public claim about a third party's platform.
 *
 * ## Why it is framed as one account rather than as a result
 *
 * Boosting was not the only thing that changed across these posts — cadence
 * and subject matter did too, and X's ranking is not a function anybody gets
 * to see. So the copy says what happened on OUR account over that period and
 * lets the reader draw the inference, rather than promising a multiple. A
 * marketing claim that implies causation we cannot demonstrate is the one a
 * customer quotes back when their own numbers differ.
 */
export const AD_SHOWCASE_REACH = {
  /** The account these posts belong to. Named on the page — an anonymous
   *  before/after is indistinguishable from an invented one. */
  handle: '@victorxheng',
  /** Representative posts from before we started boosting. */
  beforeUrls: [
    'https://x.com/victorxheng/status/2056853673100345558',
    'https://x.com/victorxheng/status/2053972044292014482',
    'https://x.com/victorxheng/status/2052603545313333395',
  ],
  /** Typical views on those, as reported by X. */
  beforeViews: 300,
  /** The range boosted posts have landed in. A RANGE, not an average: one
   *  number would be a promise, and the spread is the honest description. */
  afterViewsMin: 10_000,
  afterViewsMax: 50_000,
} as const

/**
 * What each showcase post SAYS, and how it did.
 *
 * ## Why this is a hand-maintained constant
 *
 * The landing page used to render X's own iframe embed for these. That put
 * the layout in X's hands: a fixed 550px card we could not widen, its own
 * palette that never matched the page, a height posted back over postMessage
 * that arrived late, early, or not at all, and media that made every card a
 * different height. Rendering them ourselves fixes all four, and the price is
 * that the content has to live somewhere.
 *
 * ## Which of these numbers are real, and which are missing on purpose
 *
 * `likes` and `replies` come from X's syndication endpoint
 * (`cdn.syndication.twimg.com/tweet-result?id=…`, fields `favorite_count` and
 * `conversation_count`), so they are exact as of the date below. Refresh them
 * from there rather than by eye.
 *
 * `reposts` and `views` are NOT returned by that endpoint, by oEmbed, or by the
 * embed page — nothing reachable without an authenticated X API key exposes
 * them. They stay `null` until somebody pastes them out of X's own analytics,
 * and the card omits a null metric rather than showing a placeholder. A made-up
 * repost count on the page whose entire argument is "buy reposts" would be the
 * worst possible thing to be caught doing.
 *
 * These go stale. They are a snapshot of engagement on somebody's real posts,
 * not a live read, and a post keeps accruing likes after we write one down.
 * Treat a refresh as routine, and never round one UP.
 */
export const AD_SHOWCASE_TWEET_STATS_AS_OF = 'August 21, 2026'

export interface AdShowcaseTweet {
  /** Exactly as posted. Line breaks are meaningful; keep them. */
  text: string
  /** As X prints it under the post. */
  postedAt: string
  likes: number
  replies: number
  /**
   * Not reachable from any public endpoint — see above. These are copied by
   * hand from X's own post view, signed in as the author, where the permalink
   * prints the impression count and the action bar prints the reposts.
   *
   * `views` is the RAW count, not the abbreviation X displays: store 48_300,
   * not 48.3. The card abbreviates at render, so the number stays comparable
   * and the display rule lives in one place.
   *
   * Null until somebody looks them up, and the card omits a null metric.
   */
  reposts: number | null
  views: number | null
  /** Optional still for a post carrying a photo or video. Rendered in a fixed
   *  box so one post with media cannot make its column taller than the rest. */
  image?: { src: string; alt: string }
}

export const AD_SHOWCASE_TWEETS: Record<string, AdShowcaseTweet> = {
  'https://x.com/victorxheng/status/2053972044292014482': {
    text: 'forgot my laptop at home today, ended up laying on the office couch the entire time working from my phone\n\nsomehow was able to ship more.\n\nthe future of ai is laziness',
    postedAt: '3:54 PM · May 11, 2026',
    likes: 16,
    replies: 3,
    reposts: null,
    views: null,
  },
  'https://x.com/victorxheng/status/2052603545313333395': {
    text: 'coding has devolved to the point where you can now do everything from imessage itself.\n\ntoday i spent my workday vibecoding from the couch.\n\nshoutout @triggerdotdev i love you',
    postedAt: '9:16 PM · May 7, 2026',
    likes: 8,
    replies: 2,
    reposts: null,
    views: null,
  },
  'https://x.com/victorxheng/status/2086989599646314583': {
    text: "you can now get unlimited free GLM 5.2 for the first time in history 😳\n\nthis is bigger than ever. here's how to do it:\n\n1 / cancel your existing subscriptions:\n\ncancel your Lovable, Cursor, and Claude Code subscriptions. you don't need them anymore",
    postedAt: '6:34 PM · Aug 10, 2026',
    likes: 871,
    replies: 829,
    reposts: 498,
    views: 48_300,
  },
  'https://x.com/victorxheng/status/2085813482558259233': {
    text: 'bolt lost almost all their customers due to this free alternative 😳\n\ntheir $700M valuation just got wiped out overnight.\n\nwidely regarded as one of the worst AI products in history, bolt is beign replaced by this small open-source repo.',
    postedAt: '12:41 PM · Aug 7, 2026',
    likes: 746,
    replies: 823,
    reposts: 436,
    views: 16_800,
  },
}

/**
 * Marketing copy for the advertiser landing page, kept beside the numbers it
 * quotes so a price change cannot leave a stale claim on the page.
 *
 * The comparison figures are public rate-card ranges for developer-audience
 * campaigns, stated as ranges because that is what they are. Nothing here
 * asserts a competitor's exact price.
 */
export const AD_COMPARISON = {
  linkedinCpcUsd: [8, 14] as const,
  twitterCpcUsd: [1.5, 4] as const,
  /** What $10 buys here. Derived, so it cannot drift from the price. */
  engagementsPerTenDollars: engagementsForDailyBudget(1_000),
  /**
   * Roughly what one engagement costs on a paid social platform, in dollars.
   *
   * Operator-supplied, like the reach figures, and for the same reason: every
   * platform we would be comparing against prices by auction, so there is no
   * published number to cite. It is a checked-in constant rather than anything
   * computed because it is a PUBLIC CLAIM about other people's products and
   * somebody has to decide to make it. The hero quotes it as an "industry
   * average" — keep it conservative, and keep it defensible.
   */
  industryAverageEngagementUsd: 5,
} as const
