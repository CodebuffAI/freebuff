/** Historical Imprezia experiment id, retained for reporting. */
export const IMPREZIA_EXPERIMENT = 'ads_imprezia_primary_2026_08'

/**
 * Stable salt for request sampling. The sample key rotates per ad request, but
 * the hash must stay shared by the route gate and campaign allocator.
 */
export const FIRST_PARTY_ROUTING_EXPERIMENT =
  'ads_first_party_before_paid_networks_2026_08'

/**
 * Salt for the sticky per-user first-party arm (COD-369).
 *
 * NOTHING ROUTES ON THIS TODAY. The arm is a LOGGED FIELD
 * (`first_party_arm_bucket` on `ads.fetch_completed`) and not an input to the
 * route draw, which stays on a fresh per-request `randomUUID()` exactly as it
 * was. A per-user draw would move which inventory a person gets, and that is a
 * delivery change that has to be costed on its own -- COD-362 flips routing
 * onto this once the logged buckets have produced a measured number.
 *
 * Dated, like every salt in this module, and for a stronger reason than the
 * others: once routing does read it, rotating it is the ONLY way to reshuffle
 * the arm, so a rotation is a new experiment and has to look like one.
 */
export const FIRST_PARTY_ARM_SALT = 'ads_first_party_arm_2026_09'

/**
 * An absent runtime knob is a dark deploy. Allocation is deliberately opt-in:
 * a missing Infisical value must not take paid-network inventory.
 */
export const DEFAULT_FIRST_PARTY_PRIMARY_PERCENT = 0
export const DEFAULT_FIRST_PARTY_BACKFILL = false
export const DEFAULT_FIRST_PARTY_GEO_ROUTING = false
export const DEFAULT_FIRST_PARTY_TIER2_BONUS_PERCENT = 0
/**
 * The house leg (COD-358) is a dark deploy too: absent means the house
 * campaigns keep their legacy single door behind the paid rotation.
 */
export const DEFAULT_FIRST_PARTY_HOUSE_LEG = false

/**
 * Coarse, server-resolved inventory geography. `unknown` is intentionally its
 * own value: a missing/untrusted country signal must never be treated as a
 * premium country or admitted to free advertiser inventory.
 */
export type FirstPartyAdGeoTier = 'tier1' | 'tier2' | 'unknown'

export type FirstPartyAdRoute =
  | 'paid_network_only'
  | 'first_party_primary'
  | 'gravity_then_first_party'
  | 'paid_networks_then_first_party_bonus'

export interface FirstPartyRoutingConfig {
  /** Request share, 0..100, that tries our book before paid networks. */
  primaryPercent: number
  /** Whether the remaining paid-network cohort uses our book as backfill. */
  backfill: boolean
}

export interface FirstPartyGeoRoutingConfig extends FirstPartyRoutingConfig {
  /** Dark-deploy gate. Off preserves the pre-geo routing policy exactly. */
  geoRouting: boolean
  /** Share of terminal Tier-2 paid no-fills offered non-billable inventory. */
  tier2BonusPercent: number
}

/**
 * Normalize the percentage knob to the 10,000-bucket precision used by both
 * request routing and campaign allocation. Keeping this conversion shared
 * prevents decimal environment values from opening a route that the campaign
 * selector later rejects (or vice versa).
 */
export function firstPartyPrimaryBasisPoints(primaryPercent: number): number {
  const configuredPercent = Number.isFinite(primaryPercent)
    ? primaryPercent
    : DEFAULT_FIRST_PARTY_PRIMARY_PERCENT
  return Math.round(Math.min(100, Math.max(0, configuredPercent)) * 100)
}

/**
 * Map one server-minted request sample to the allocator's 10,000-bucket space.
 * Both routing and campaign selection use this exact function so a request
 * admitted to first-party inventory cannot land in a different campaign slice.
 */
export function firstPartyPrimaryBucket(sampleId: string): number {
  return fnv1a(`${FIRST_PARTY_ROUTING_EXPERIMENT}:${sampleId}`) % 10_000
}

/**
 * The sticky sample key for one user's first-party arm.
 *
 * OBSERVATIONAL ONLY. Both rails feed it to {@link firstPartyPrimaryBucket}
 * and report the result as `first_party_arm_bucket`; neither feeds it to the
 * route draw or to campaign allocation, which keep reading the per-request
 * sample. Pointing routing at this is COD-362's job and changes delivery.
 *
 * Both rails always have a user id -- the browser route 401s without a
 * session and the v1 route is API-key authenticated -- so the empty-id case
 * is defensive rather than a supported path; it parks every anonymous caller
 * on one bucket.
 */
export function firstPartyArmKey(userId: string | null | undefined): string {
  return `fpa_${fnv1a(`${FIRST_PARTY_ARM_SALT}:${userId ?? ''}`).toString(36)}`
}

/**
 * Salt for the sticky CLI dock arm (COD-457).
 *
 * Its OWN salt, not a reuse of any other in this module: the dock experiment
 * asks a presentation question and the first-party salts move which inventory
 * a person gets, so sharing one would correlate the two arms and make either
 * result unreadable. Dated for the same reason as its neighbours — rotating it
 * reshuffles every user, and that is a new experiment rather than a re-tune.
 */
export const CLI_DOCK_EXPERIMENT_SALT = 'ads_cli_dock_v2_2026_09'

/** Share of users given the expandable dock while the knob is `on`. */
export const CLI_DOCK_EXPERIMENT_PERCENT = 50

/** `off` serves control to everyone; `shadow` assigns and logs but still serves
 * control; `on` is the only mode where an arm changes what is rendered. */
export type CliDockExperimentMode = 'off' | 'shadow' | 'on'
export const CLI_DOCK_EXPERIMENT_MODES = ['off', 'shadow', 'on'] as const
export const DEFAULT_CLI_DOCK_EXPERIMENT: CliDockExperimentMode = 'off'

/**
 * An unrecognised value is `off`, never a guess at intent — the same rule
 * `parseSupabaseGateMode` follows, and for the same reason: a typo in an
 * Infisical value must not silently enrol every CLI user in an experiment.
 * Case-sensitive on purpose, so `ON` is a refusal rather than a rollout.
 */
export function parseCliDockExperimentMode(
  raw: string | undefined | null,
): CliDockExperimentMode {
  return raw === 'on' || raw === 'shadow' ? raw : DEFAULT_CLI_DOCK_EXPERIMENT
}

export type CliDockArm = 'control' | 'expandable'

/**
 * The user's sticky dock arm.
 *
 * `off` is not merely "assign nobody": it returns control WITHOUT hashing, so
 * an unset knob is byte-identical to the pre-COD-457 world rather than merely
 * harmless. `shadow` assigns the bucket so it can be logged and sized, and the
 * CALLER is responsible for still rendering control — the mode rides back to
 * the client beside the arm so a shadow assignment cannot be mistaken for a
 * live one by a client that only reads `dockArm`.
 *
 * An absent user id parks on control: every ad surface rejects unauthenticated
 * callers, so an anonymous caller sees no dock to expand.
 */
export function cliDockArmForUser(
  userId: string | null | undefined,
  mode: CliDockExperimentMode,
): CliDockArm {
  if (mode === 'off') return 'control'
  if (!userId) return 'control'
  const bucket = fnv1a(`${CLI_DOCK_EXPERIMENT_SALT}:${userId}`) % 100
  return bucket < CLI_DOCK_EXPERIMENT_PERCENT ? 'expandable' : 'control'
}

/**
 * The arm to REPORT for one ad request.
 *
 * The client's cached value wins whenever it sent a recognisable one, because
 * the server recomputes `serverAssigned` from the CURRENT env mode while a CLI
 * session holds its arm for its whole life. At a `shadow` -> `on` flip a
 * session still drawing the control dock would otherwise be logged as
 * `expandable`, and a rollback mislabels the reverse — exactly at the rollout
 * boundaries the experiment is read across.
 *
 * Anything unrecognisable falls back rather than being trusted: this is a
 * request-body field, and the only thing it may ever do is label a log line.
 */
export function resolveReportedCliDockArm(
  clientCached: unknown,
  serverAssigned: CliDockArm,
): { arm: CliDockArm; source: 'client' | 'server' } {
  if (clientCached === 'expandable' || clientCached === 'control') {
    return { arm: clientCached, source: 'client' }
  }
  return { arm: serverAssigned, source: 'server' }
}

/** What the client should actually RENDER, as opposed to what it was assigned. */
export function cliDockArmServed(
  arm: CliDockArm,
  mode: CliDockExperimentMode,
): CliDockArm {
  return mode === 'on' ? arm : 'control'
}

export type AdExperimentArm = 'imprezia_forced' | 'imprezia_first' | 'control'

export function isImpreziaAudienceEmail(
  email: string | null | undefined,
): boolean {
  if (!email) return false
  const normalized = email.trim().toLowerCase()
  return normalized.endsWith('@imprezia.ai')
}

/** FNV-1a 32-bit: tiny, dependency-free, stable across runtimes. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Sticky destination split for the Freebuff house-subscription promotion.
 *
 * Its own dated salt keeps this acquisition experiment independent from ad
 * routing and creative-selection experiments. Changing the salt starts a new
 * experiment because it reassigns users.
 */
export const HOUSE_SUBSCRIPTION_BILLING_EXPERIMENT =
  'house_subscription_billing_2026_09'

export type HouseSubscriptionBillingExperimentMode = 'off' | 'on'
export type HouseSubscriptionBillingArm = 'monthly' | 'yearly'

export function parseHouseSubscriptionBillingExperimentMode(
  raw: string | null | undefined,
): HouseSubscriptionBillingExperimentMode {
  return raw === 'on' ? 'on' : 'off'
}

/** 50% assignment probability, stable across sessions and pods for one user. */
export function houseSubscriptionBillingArmForUser(
  userId: string,
): HouseSubscriptionBillingArm {
  return fnv1a(`${HOUSE_SUBSCRIPTION_BILLING_EXPERIMENT}:${userId}`) % 100 < 50
    ? 'monthly'
    : 'yearly'
}

/** Gravity exclusivity retires the Imprezia cohorts. */
export function adExperimentArmForUser(
  _userId: string | null | undefined,
  _userEmail?: string | null,
): AdExperimentArm {
  return 'control'
}

/**
 * Choose the request's routing policy.
 *
 * Production callers pass a fresh server-minted `sampleId` for each ad request
 * so a percentage applies to requests, not a permanently pinned set of users.
 * The fallback to `userId` preserves deterministic behavior for old callers
 * and tests. The function clamps direct callers defensively; the runtime env
 * schema rejects out-of-range values.
 */
export function firstPartyAdRouteForUser(
  userId: string | null | undefined,
  config: FirstPartyRoutingConfig,
  sampleId?: string,
): FirstPartyAdRoute {
  if (!userId) return 'paid_network_only'
  const bucket = firstPartyPrimaryBucket(sampleId || userId)
  if (bucket < firstPartyPrimaryBasisPoints(config.primaryPercent)) {
    return 'first_party_primary'
  }
  return config.backfill ? 'gravity_then_first_party' : 'paid_network_only'
}

/**
 * Whether the HOUSE leg may run on this request (COD-358).
 *
 * The house campaigns are our own promotion: they bill nobody, so none of
 * the sampled windows above apply to them. The leg follows paid no-fill, ahead
 * of bonus inventory, on Tier 1 AND Tier 2. Unknown geography stays closed
 * while geo routing is on: a missing or untrusted signal never
 * opens inventory. With geo routing off there is no tier, and the knob alone
 * decides.
 *
 * Deliberately NOT a `FirstPartyAdRoute`: the paid routes describe where the
 * BILLABLE book sits relative to the networks, and the house leg is
 * orthogonal to all of them -- it runs on the paid-network-only route as
 * readily as on the backfill one.
 */
export function houseLegOpen(
  userId: string | null | undefined,
  config: { houseLeg: boolean; geoRouting: boolean },
  geoTier: FirstPartyAdGeoTier,
): boolean {
  if (!config.houseLeg) return false
  if (!userId) return false
  if (!config.geoRouting) return true
  return geoTier === 'tier1' || geoTier === 'tier2'
}

/**
 * Apply the geo-aware policy without changing the legacy gate's semantics.
 *
 * - Tier 1 keeps the configured primary/backfill policy.
 * - Tier 2 never preempts a paid provider. Once the caller proves that every
 *   paid provider available on that surface has declined, a sampled request
 *   may receive explicitly non-billable bonus inventory.
 * - Unknown geography stays on paid networks only.
 */
export function firstPartyAdRouteForGeoRequest(
  userId: string | null | undefined,
  config: FirstPartyGeoRoutingConfig,
  context: {
    geoTier: FirstPartyAdGeoTier
    terminalPaidFallback: boolean
  },
  sampleId?: string,
): FirstPartyAdRoute {
  if (!config.geoRouting) {
    return firstPartyAdRouteForUser(userId, config, sampleId)
  }
  if (!userId) return 'paid_network_only'
  if (context.geoTier === 'tier1') {
    return firstPartyAdRouteForUser(userId, config, sampleId)
  }
  if (
    context.geoTier === 'tier2' &&
    context.terminalPaidFallback &&
    firstPartyPrimaryBucket(sampleId || userId) <
      firstPartyPrimaryBasisPoints(config.tier2BonusPercent)
  ) {
    return 'paid_networks_then_first_party_bonus'
  }
  return 'paid_network_only'
}

/**
 * ============================================================================
 * SPONSOR BREAKS (COD-453 scope item 5)
 * ============================================================================
 *
 * Two INDEPENDENT sticky experiments, each with its own salt, its own knob and
 * its own arm vocabulary. They are independent because they ask different
 * questions of the same person: the break experiment asks whether interrupting
 * once buys back the attention four inline cards an hour spend, and the
 * showcase experiment asks whether a taller always-present unit does. Sharing
 * a salt would correlate the two assignments and make neither readable.
 */

/**
 * Salt for the sticky sponsor-break arm.
 *
 * NEW, never reused, and dated like every salt in this module. Rotating it
 * reshuffles every user, which for an arm that CHANGES DELIVERY is a new
 * experiment and has to look like one -- so a rotation gets a new dated
 * constant rather than an edit to this string.
 */
export const SPONSOR_BREAK_ARM_SALT = 'ads_sponsor_break_arm_2026_09'

/**
 * Salt for the SHOWCASE cadence test. A different string rather than a suffix
 * of the one above: two FNV-1a hashes under salts sharing a prefix are still
 * independent, but nobody reading a split should have to know that to trust it.
 */
export const SHOWCASE_ARM_SALT = 'ads_showcase_cadence_2026_09'

/**
 * The sponsor-break arms.
 *
 * ORDER IS PART OF THE CONTRACT. {@link sponsorBreakArmForUser} walks this
 * array accumulating basis points, so reordering it moves every user between
 * arms exactly as rotating the salt would -- without the salt change that is
 * supposed to announce a reshuffle.
 *
 * - `control` is today: 60s inline rotation, a pool of 4, no break.
 * - `reduced` is the inline half of the hypothesis ALONE -- fewer, slower
 *   inline cards and still no break. It is the arm that says whether an
 *   improvement is the break or merely the quiet, and without it every break
 *   arm is confounded with the cadence change it ships beside.
 * - `reduced_spotlight` / `reduced_intermission` add one break format on top of
 *   `reduced`. Showcase is deliberately NOT an arm here: it does not interrupt,
 *   so it is not comparable to these, and it gets its own 50/50 knob below.
 */
export const SPONSOR_BREAK_ARMS = [
  'control',
  'reduced',
  'reduced_spotlight',
  'reduced_intermission',
] as const
export type SponsorBreakArm = (typeof SPONSOR_BREAK_ARMS)[number]

export const SHOWCASE_ARMS = ['control', 'showcase'] as const
export type ShowcaseArm = (typeof SHOWCASE_ARMS)[number]

/** `off` decides nothing, `shadow` assigns and logs, `on` also routes. */
export type SponsorBreakExperimentMode = 'off' | 'shadow' | 'on'

export function parseSponsorBreakExperimentMode(
  raw: string | null | undefined,
): SponsorBreakExperimentMode {
  return raw === 'shadow' || raw === 'on' ? raw : 'off'
}

/**
 * An even four-way split, in basis points of 10,000.
 *
 * Even rather than control-heavy: all four arms cost the same to serve, and
 * the comparison of interest is between the three treatments rather than
 * against a precisely-measured control.
 */
export const DEFAULT_SPONSOR_BREAK_SPLIT_BPS: Readonly<
  Record<SponsorBreakArm, number>
> = {
  control: 2_500,
  reduced: 2_500,
  reduced_spotlight: 2_500,
  reduced_intermission: 2_500,
}

/** The showcase test is a straight 50/50; there is only one thing to vary. */
export const SHOWCASE_SPLIT_BPS = 5_000

/**
 * What each arm asks the client to do. Delivered by `GET /api/v1/ads/policy`
 * and never inferred client-side: an arm the server assigned and a cadence the
 * client derived from its name are two places one experiment can drift.
 *
 * `inlinePoolMax` is the distinct-ad pool the transcript draws from and
 * `rotationMs` how long a drawn card holds its slot. `control` restates
 * today's values rather than referencing them, so reading this table is enough
 * to know what every arm does.
 */
export const SPONSOR_BREAK_ARM_POLICY: Readonly<
  Record<SponsorBreakArm, { rotationMs: number; inlinePoolMax: number }>
> = {
  control: { rotationMs: 60_000, inlinePoolMax: 4 },
  reduced: { rotationMs: 180_000, inlinePoolMax: 2 },
  reduced_spotlight: { rotationMs: 180_000, inlinePoolMax: 2 },
  reduced_intermission: { rotationMs: 180_000, inlinePoolMax: 2 },
}

/**
 * The break placement ids an arm may render. Empty for the two arms that run
 * no break, which is what makes the policy response TOTAL: a client reads
 * `breakPlacementIds` and never maps an arm name onto a placement itself, so
 * adding a fourth format stays a server change.
 */
export const SPONSOR_BREAK_ARM_PLACEMENT_IDS: Readonly<
  Record<SponsorBreakArm, readonly string[]>
> = {
  control: [],
  reduced: [],
  reduced_spotlight: ['Desktop-Spotlight'],
  reduced_intermission: ['Desktop-Intermission'],
}

/** Bounds for the Intermission countdown, in milliseconds. */
export const SPONSOR_BREAK_TIMER_MS_DEFAULT = 3_000
export const SPONSOR_BREAK_TIMER_MS_MIN = 1_000
export const SPONSOR_BREAK_TIMER_MS_MAX = 5_000

/**
 * Clamp, never reject. This knob is read on a serving path and a bad value
 * must not take the policy route down -- an out-of-range countdown is a typo
 * in Infisical, and the honest answer to a typo is the nearest legal number.
 */
export function clampSponsorBreakTimerMs(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(numeric)) return SPONSOR_BREAK_TIMER_MS_DEFAULT
  return Math.min(
    SPONSOR_BREAK_TIMER_MS_MAX,
    Math.max(SPONSOR_BREAK_TIMER_MS_MIN, Math.round(numeric)),
  )
}

/**
 * Bounds for SPOTLIGHT'S DISMISS LOCK, in milliseconds (COD-454).
 *
 * A DIFFERENT THING FROM THE COUNTDOWN ABOVE, and the difference is the whole
 * reason it is a second knob rather than a reuse of `timerMs`. Intermission's
 * countdown gates the WHOLE card: nothing may be pressed until it finishes.
 * The dismiss lock gates only the ways OUT — the X, Escape, the backdrop and
 * Continue — while the CTA and the hero stay live throughout, so the shortest
 * path off the card the entire time is the advertiser's own link. Sharing one
 * value would mean re-tuning one format silently re-tuned the other.
 *
 * ZERO IS LEGAL AND IS THE KILL SWITCH -- unlike the countdown, whose floor is
 * 1000. A lock of 0 restores the immediately-dismissible card exactly, which is
 * the rollback an operator needs to be able to reach without a deploy.
 */
export const SPONSOR_BREAK_DISMISS_LOCK_MS_DEFAULT = 5_000
export const SPONSOR_BREAK_DISMISS_LOCK_MS_MIN = 0
export const SPONSOR_BREAK_DISMISS_LOCK_MS_MAX = 5_000

/**
 * Clamp, never reject — the same rule and the same reason as
 * {@link clampSponsorBreakTimerMs}. The ceiling is what matters here: this
 * value decides how long a full-screen card cannot be dismissed, so every hop
 * that could have introduced a bad one bounds it again.
 */
export function clampSponsorBreakDismissLockMs(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(numeric)) return SPONSOR_BREAK_DISMISS_LOCK_MS_DEFAULT
  return Math.min(
    SPONSOR_BREAK_DISMISS_LOCK_MS_MAX,
    Math.max(SPONSOR_BREAK_DISMISS_LOCK_MS_MIN, Math.round(numeric)),
  )
}

/**
 * The sticky sample key for one user's sponsor-break arm. Shaped like
 * {@link firstPartyArmKey} so the two read the same at a call site, with its
 * own prefix so one cannot be passed to the other's bucket function unnoticed.
 */
export function sponsorBreakArmKey(userId: string | null | undefined): string {
  return `sbk_${fnv1a(`${SPONSOR_BREAK_ARM_SALT}:${userId ?? ''}`).toString(36)}`
}

export function showcaseArmKey(userId: string | null | undefined): string {
  return `swk_${fnv1a(`${SHOWCASE_ARM_SALT}:${userId ?? ''}`).toString(36)}`
}

/** 0..9999, the same bucket space every first-party window uses. */
export function sponsorBreakArmBucket(
  userId: string | null | undefined,
): number {
  return fnv1a(`${SPONSOR_BREAK_ARM_SALT}:${userId ?? ''}`) % 10_000
}

export function showcaseArmBucket(userId: string | null | undefined): number {
  return fnv1a(`${SHOWCASE_ARM_SALT}:${userId ?? ''}`) % 10_000
}

/**
 * Parse the split knob:
 * `control=2500,reduced=2500,reduced_spotlight=2500,reduced_intermission=2500`.
 *
 * TOTAL. An unparseable value, an unknown arm name, a negative number, or a
 * table summing past 10,000 all return the default split rather than throwing
 * or half-applying. The failure mode this avoids is the expensive one: a
 * partially-applied split is a silent, unbalanced experiment that nobody
 * notices until the readout, where a whole-table fallback is visible the
 * moment anyone compares the knob to `sponsor_break_arm` in Axiom.
 *
 * A table summing UNDER 10,000 is LEGAL and means the remainder stays in
 * `control` -- which is how a 10% ramp is expressed.
 */
export function parseSponsorBreakSplitBps(
  raw: string | null | undefined,
): Readonly<Record<SponsorBreakArm, number>> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return DEFAULT_SPONSOR_BREAK_SPLIT_BPS
  }
  const parsed: Record<SponsorBreakArm, number> = {
    control: 0,
    reduced: 0,
    reduced_spotlight: 0,
    reduced_intermission: 0,
  }
  let total = 0
  for (const entry of raw.split(',')) {
    const parts = entry.split('=')
    // Exactly one `=`, and something on each side. Without this an entry of
    // bare `control` parses as `control=0` -- `Number('')` is 0 -- and the
    // whole table silently becomes zeros, which assigns everybody to control
    // while looking like a configured split.
    if (parts.length !== 2) return DEFAULT_SPONSOR_BREAK_SPLIT_BPS
    const [name = '', value = ''] = parts
    const arm = name.trim() as SponsorBreakArm
    if (!SPONSOR_BREAK_ARMS.includes(arm)) {
      return DEFAULT_SPONSOR_BREAK_SPLIT_BPS
    }
    if (value.trim() === '') return DEFAULT_SPONSOR_BREAK_SPLIT_BPS
    const bps = Number(value.trim())
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      return DEFAULT_SPONSOR_BREAK_SPLIT_BPS
    }
    parsed[arm] = bps
    total += bps
  }
  if (total > 10_000) return DEFAULT_SPONSOR_BREAK_SPLIT_BPS
  return parsed
}

/**
 * The sticky arm for one user.
 *
 * `off` IS `control` FOR EVERYONE, and not merely "control by default": the
 * mode is checked BEFORE the hash, so with the knob absent nothing about the
 * assignment can vary. That is the byte-identical-when-off property every ad
 * knob in this repo has.
 *
 * `shadow` still returns a REAL arm -- it is assigned and logged, and whether
 * anything may be routed on it is the caller's decision, not this function's.
 * Folding the mode check into the return value here would mean a shadow week
 * measured nothing.
 *
 * A caller with no user id parks in `control`: every ad surface rejects
 * unauthenticated callers, so this is defensive rather than a supported path.
 */
export function sponsorBreakArmForUser(
  userId: string | null | undefined,
  config: {
    mode: SponsorBreakExperimentMode
    splitBps?: Readonly<Record<SponsorBreakArm, number>>
  },
): SponsorBreakArm {
  if (config.mode === 'off') return 'control'
  if (!userId) return 'control'
  const split = config.splitBps ?? DEFAULT_SPONSOR_BREAK_SPLIT_BPS
  const bucket = sponsorBreakArmBucket(userId)
  let ceiling = 0
  for (const arm of SPONSOR_BREAK_ARMS) {
    ceiling += split[arm]
    if (bucket < ceiling) return arm
  }
  // The split summed under 10,000; the remainder is control by construction.
  return 'control'
}

/** The showcase cadence test's sticky arm. Same `off` semantics as above. */
export function showcaseArmForUser(
  userId: string | null | undefined,
  config: { mode: SponsorBreakExperimentMode },
): ShowcaseArm {
  if (config.mode === 'off') return 'control'
  if (!userId) return 'control'
  return showcaseArmBucket(userId) < SHOWCASE_SPLIT_BPS ? 'showcase' : 'control'
}
