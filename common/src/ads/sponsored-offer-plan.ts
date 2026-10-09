/**
 * What a sponsored offer will ask of the user, said BEFORE Accept (COD-824).
 *
 * `connect_dismissed` runs closed a median 23s after Accept: people accepted,
 * met an account or API-key step they had not expected, and left. The step
 * tracker existed, but only from `running` on, after most of those losses.
 * So the offer card now says "6 steps · ~4 min · 1 needs you (Archil
 * account)", and a progress pill follows the run from Accept onwards.
 *
 * Everything here is derived from the reviewed procedure text, the same way
 * `outcomes:` (`sponsored-run-outcomes.ts`) and `requires-credential:`
 * (`sponsored-run-credentials.ts`) are: the text is what the advertiser
 * writes, what we review, and what the SHA-256 the user consents to covers.
 *
 *  - The STEPS are `parseSponsoredProcedureSteps`'s (COD-832), the one step
 *    list the run card and the grader count too. A procedure with no
 *    numbered steps has no step count, and the card omits that clause
 *    rather than guessing.
 *  - The user is NEEDED for each `needs-user: <what>` annotation, e.g.
 *
 *        3. Create the storage volume. needs-user: Archil account
 *
 *    and for every declared `requires-credential:` label: the run asks for
 *    that credential mid-run (COD-827).
 *
 * Pure and dependency-free apart from the step and credential parsers, so the server
 * that composes the plan and every surface that renders it agree exactly.
 * The plan is ADVERTISER TEXT on its way to a terminal and a DOM: labels are
 * held to printable characters and a short length here, and again when a
 * surface reads one off the wire.
 */

import {
  formatSponsoredStepCount,
  parseSponsoredProcedureSteps,
} from './sponsored-procedure-steps'
import { declaredRunCredentials } from './sponsored-run-credentials'

import type {
  SponsoredProposalState,
  SponsoredProposalStepState,
} from './sponsored-proposal-view'

export const SPONSORED_NEEDS_USER_DIRECTIVE = 'needs-user:'

/** More than this is a procedure we would not believe the count of. */
export const SPONSORED_OFFER_STEP_MAX = 50
/** Named on the card; any more are counted, not listed. */
export const SPONSORED_OFFER_NEEDS_USER_MAX = 3
const LABEL_MAX = 40
/** Two hours: a longer "estimate" is a broken span, not a run. */
const ESTIMATE_MAX_SECONDS = 2 * 60 * 60

/**
 * Perfect runs a campaign needs before its own median is used. Fewer, and one
 * slow outlier would set the promise for everyone.
 */
export const SPONSORED_ESTIMATE_MIN_RUNS = 3
/** The no-history fallback: per procedure step, within the bounds below. */
export const SPONSORED_ESTIMATE_FALLBACK_SECONDS_PER_STEP = 45
const FALLBACK_MIN_SECONDS = 2 * 60
const FALLBACK_MAX_SECONDS = 15 * 60

const NEEDS_USER = /\bneeds-user\s*:\s*([^\n]*)/i

/** A label a surface may print, or null. Same character rule as credentials. */
export function sponsoredNeedsUserLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value
    .replace(/[)\].,;:]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (label.length === 0 || label.length > LABEL_MAX) return null
  if (!/^[^\u0000-\u001f\u007f-\u009f"<>\\`]+$/.test(label)) return null
  return label
}

/**
 * What the procedure declares it needs the user for, in order: the label of
 * every `needs-user:` annotation, read to the end of its line. `''` where an
 * annotation names nothing printable.
 */
export function sponsoredNeedsUserAnnotations(
  procedure: string | null | undefined,
): string[] {
  if (typeof procedure !== 'string') return []
  const labels: string[] = []
  for (const line of procedure.split(/\r?\n/)) {
    const mark = NEEDS_USER.exec(line)
    if (mark) labels.push(sponsoredNeedsUserLabel(mark[1]) ?? '')
  }
  return labels
}

export type SponsoredOfferPlan = {
  /** Null when the procedure has no numbered steps. */
  stepCount: number | null
  /**
   * One entry per thing the user is needed for, named where the procedure
   * names it (`''` where it does not), deduplicated.
   */
  needsUser: string[]
  /** Null when there is neither run history nor a step count to go on. */
  estimateSeconds: number | null
}

/** The wire shape, on the proposal row as `offer_plan`. */
export type SponsoredOfferPlanWire = {
  step_count: number | null
  needs_user: string[]
  estimate_seconds: number | null
}

/**
 * The median of the campaign's perfect runs when it has enough of them,
 * otherwise a per-step guess, otherwise nothing.
 */
export function sponsoredOfferEstimateSeconds(input: {
  perfectRunSeconds: readonly number[]
  stepCount: number | null
}): number | null {
  const spans = input.perfectRunSeconds
    .filter((s) => Number.isFinite(s) && s > 0 && s <= ESTIMATE_MAX_SECONDS)
    .sort((a, b) => a - b)
  if (spans.length >= SPONSORED_ESTIMATE_MIN_RUNS) {
    const mid = Math.floor(spans.length / 2)
    const median =
      spans.length % 2 === 1 ? spans[mid]! : (spans[mid - 1]! + spans[mid]!) / 2
    return Math.round(median)
  }
  if (input.stepCount === null || input.stepCount === 0) return null
  return Math.min(
    FALLBACK_MAX_SECONDS,
    Math.max(
      FALLBACK_MIN_SECONDS,
      input.stepCount * SPONSORED_ESTIMATE_FALLBACK_SECONDS_PER_STEP,
    ),
  )
}

export function sponsoredOfferPlan(input: {
  procedure: string | null | undefined
  perfectRunSeconds?: readonly number[]
}): SponsoredOfferPlan {
  // THE step list (COD-832), so the offer's "6 steps" is the same 6 the run
  // card, the grader and the agentic-runs page count.
  const steps = parseSponsoredProcedureSteps(input.procedure)
  const stepCount =
    steps.length > 0 ? Math.min(steps.length, SPONSORED_OFFER_STEP_MAX) : null
  const needsUser = dedupeNeeds([
    ...sponsoredNeedsUserAnnotations(input.procedure),
    ...declaredRunCredentials(input.procedure).map(
      (credential) => sponsoredNeedsUserLabel(credential.label) ?? '',
    ),
  ])
  return {
    stepCount,
    needsUser,
    estimateSeconds: sponsoredOfferEstimateSeconds({
      perfectRunSeconds: input.perfectRunSeconds ?? [],
      stepCount,
    }),
  }
}

function dedupeNeeds(labels: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const label of labels) {
    // Unnamed entries are each their own thing; named ones collapse.
    const key = label === '' ? `#${out.length}` : label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(label)
  }
  return out.slice(0, SPONSORED_OFFER_STEP_MAX)
}

export function sponsoredOfferPlanToWire(
  plan: SponsoredOfferPlan,
): SponsoredOfferPlanWire {
  return {
    step_count: plan.stepCount,
    needs_user: plan.needsUser,
    estimate_seconds: plan.estimateSeconds,
  }
}

function wireCount(value: unknown, max: number): number | null | undefined {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return value >= 0 && value <= max ? value : undefined
}

/**
 * A plan read off the wire, re-validated, or null. Anything malformed is no
 * plan at all: the card then reads exactly as it did before plans existed.
 */
export function sponsoredOfferPlanFromWire(
  value: unknown,
): SponsoredOfferPlan | null {
  if (!value || typeof value !== 'object') return null
  const wire = value as Record<string, unknown>
  const stepCount = wireCount(wire.step_count, SPONSORED_OFFER_STEP_MAX)
  const estimateSeconds = wireCount(wire.estimate_seconds, ESTIMATE_MAX_SECONDS)
  if (stepCount === undefined || estimateSeconds === undefined) return null
  if (!Array.isArray(wire.needs_user)) return null
  const needsUser: string[] = []
  for (const entry of wire.needs_user.slice(0, SPONSORED_OFFER_STEP_MAX)) {
    if (entry === '') needsUser.push('')
    else {
      const label = sponsoredNeedsUserLabel(entry)
      if (label === null) return null
      needsUser.push(label)
    }
  }
  return {
    stepCount: stepCount === 0 ? null : stepCount,
    needsUser: dedupeNeeds(needsUser),
    estimateSeconds: estimateSeconds === 0 ? null : estimateSeconds,
  }
}

/** `~4 min`; never under a minute, since the estimate is not that precise. */
export function sponsoredEstimateCopy(seconds: number): string {
  return `~${Math.max(1, Math.round(seconds / 60))} min`
}

/**
 * The offer card's one line: "6 steps · ~4 min · 1 needs you (Archil
 * account)". Null when the plan says nothing, so the card is unchanged.
 */
export function sponsoredOfferSummary(
  plan: SponsoredOfferPlan | null,
): string | null {
  if (!plan) return null
  const parts: string[] = []
  if (plan.stepCount !== null)
    parts.push(`${plan.stepCount} step${plan.stepCount === 1 ? '' : 's'}`)
  if (plan.estimateSeconds !== null)
    parts.push(sponsoredEstimateCopy(plan.estimateSeconds))
  if (plan.needsUser.length > 0) {
    const named = plan.needsUser
      .filter((label) => label !== '')
      .slice(0, SPONSORED_OFFER_NEEDS_USER_MAX)
    const more = plan.needsUser.filter((l) => l !== '').length - named.length
    const names =
      named.length > 0
        ? ` (${named.join(', ')}${more > 0 ? `, +${more} more` : ''})`
        : ''
    parts.push(`${plan.needsUser.length} needs you${names}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/** `45s` under a minute, then whole minutes: `2m`. */
export function sponsoredElapsedCopy(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`
}

export const SPONSORED_PILL_NEEDS_YOU = 'Needs you'

/**
 * The progress pill, from Accept onwards (COD-824):
 *
 *   queued   "0/6 · Starting"
 *   running  "3/6 · 2m"
 *   waiting  "Needs you"
 *   done     "6/6 ✓"
 *
 * Null on `offered` (the summary speaks there) and on `failed` (the failure
 * reason does). The run's own steps win over the procedure's count once it
 * reports any, since those are the ones it is ticking off. `needsYou` is the
 * surface's to answer -- the waiting state is not on the row -- and
 * `elapsedMs` is omitted where the surface has no start time.
 */
export function sponsoredProgressPill(input: {
  state: SponsoredProposalState
  steps: ReadonlyArray<{ state: SponsoredProposalStepState }>
  plan: SponsoredOfferPlan | null
  needsYou?: boolean
  elapsedMs?: number | null
}): string | null {
  const { state, steps, plan } = input
  const total = steps.length > 0 ? steps.length : (plan?.stepCount ?? null)
  const done = steps.filter((step) => step.state === 'done').length
  switch (state) {
    case 'offered':
    case 'failed':
      return null
    case 'accepted':
      if (input.needsYou) return SPONSORED_PILL_NEEDS_YOU
      return total === null ? 'Starting' : `0/${total} · Starting`
    case 'running': {
      if (input.needsYou) return SPONSORED_PILL_NEEDS_YOU
      const time =
        typeof input.elapsedMs === 'number' && input.elapsedMs >= 0
          ? sponsoredElapsedCopy(input.elapsedMs)
          : null
      const count = formatSponsoredStepCount(done, total)
      if (count === null) return time ? `Running · ${time}` : 'Running'
      return time ? `${count} · ${time}` : count
    }
    case 'committed':
    case 'delivered':
    case 'landed':
    case 'merged':
      return total === null ? 'Done ✓' : `${total}/${total} ✓`
  }
}
