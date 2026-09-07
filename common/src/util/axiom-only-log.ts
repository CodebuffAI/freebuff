import { AnalyticsEvent } from '../constants/analytics-events'
import {
  ADS_BREAK_CLICKED_EVENT,
  ADS_BREAK_CLOSED_EVENT,
  ADS_BREAK_SHOWN_EVENT,
} from '../ads/sponsor-break-events'
import { PLACEMENT_SLOTS } from '../constants/freebuff-placements'
import {
  FIRST_PARTY_VIEW_ACK_CLIENT_FAMILIES,
  FIRST_PARTY_VIEW_ACK_MAX_DURATION_MS,
  FIRST_PARTY_VIEW_ACK_OUTCOMES,
  type FirstPartyViewAckClientFamily,
  type FirstPartyViewAckObservation,
  type FirstPartyViewAckOutcome,
} from '../ads/first-party-view-ack'

export {
  FIRST_PARTY_VIEW_ACK_CLIENT_FAMILIES,
  FIRST_PARTY_VIEW_ACK_OUTCOMES,
  type FirstPartyViewAckClientFamily,
  type FirstPartyViewAckOutcome,
}
export {
  ADS_BREAK_CLICKED_EVENT,
  ADS_BREAK_CLOSED_EVENT,
  ADS_BREAK_SHOWN_EVENT,
}

import type { SponsorBreakEvent } from '../ads/sponsor-break-events'

/**
 * Operational events that belong in Axiom but not in product analytics.
 *
 * This allowlist lets a small set of content-free operational events retain
 * useful numeric/string/boolean metadata without becoming product events or
 * providing a general redaction bypass. Unknown fields and unexpected value
 * types are always discarded.
 */

export const CONTEXT_PRUNING_COMPLETED_EVENT =
  'context_pruning.completed' as const

/** Stream-cut / output-limit recovery (sdk/src/impl/stream-interruption.ts,
 *  packages/agent-runtime/src/tools/stream-parser.ts). `metric` distinguishes
 *  the log sites (stream_recovery_detected / _rescued) that share this one
 *  allowlisted event — `_gave_up` logs at error level, which already ships
 *  raw and doesn't need the allowlist. */
export const STREAM_RECOVERY_EVENT = 'stream_recovery' as const
export const ADS_FETCH_COMPLETED_EVENT = AnalyticsEvent.ADS_FETCH_COMPLETED
export const ADS_FIRST_PARTY_DECISION_EVENT =
  AnalyticsEvent.ADS_FIRST_PARTY_DECISION
export const ADS_FIRST_PARTY_SETTLEMENT_EVENT =
  AnalyticsEvent.ADS_FIRST_PARTY_SETTLEMENT
export const ADS_FIRST_PARTY_VIEW_ACK_EVENT =
  AnalyticsEvent.ADS_FIRST_PARTY_VIEW_ACK
export const ADS_FIRST_PARTY_CLICK_RECORDED_EVENT =
  'ads.first_party_click_recorded' as const
export const ADS_FIRST_PARTY_IMPRESSION_RECORDED_EVENT =
  'ads.first_party_impression_recorded' as const
/** Advertiser S2S conversion postbacks. This event is deliberately limited to
 * a small, content-free operational census; partner credentials and the
 * opaque click/event identifiers never leave the request handler. */
export const ADS_EXTERNAL_CONVERSION_POSTBACK_EVENT =
  'ads.external_conversion_postback' as const
/**
 * Why an authenticated S2S postback failed the click-id shape guard before
 * body validation. Values describe only the failed predicate; the presented
 * value, API key, advertiser, campaign, IP and request body stay out of Axiom.
 */
export const ADS_EXTERNAL_CONVERSION_CLICK_ID_SHAPES = [
  'missing',
  'wrong_type',
  'empty',
  'oversized',
  'control_char',
] as const
export type AdsExternalConversionClickIdShape =
  (typeof ADS_EXTERNAL_CONVERSION_CLICK_ID_SHAPES)[number]
/**
 * Durable campaign-health evidence. Unlike the content-free postback census,
 * this stream intentionally carries opaque advertiser/campaign identifiers so
 * the health reader can distinguish independent ingress binding from a join
 * learned only after click resolution. Raw click ids, event ids, credentials,
 * email, IP and user-agent data are never fields on this event.
 */
export const ADS_CAMPAIGN_INGRESS_EVIDENCE_EVENT =
  'ads.campaign_ingress_evidence_v1' as const
export const ADS_ADVERTISER_REPORTING_READ_EVENT =
  'ads.advertiser_reporting_read' as const
/** Content-free advertiser MCP operation census; never arguments or results. */
export const ADS_MCP_TOOL_CALL_EVENT = 'ads.mcp_tool_call' as const
/** Browser-side Imprezia decisions. The route deliberately reports only
 * bounded serving dimensions: request/content/creative identifiers, URLs, and
 * raw provider errors never enter this event. */
export const ADS_IMPREZIA_FETCH_COMPLETED_EVENT =
  'ads.imprezia_fetch_completed' as const
/**
 * Ad routes refusing a request (COD-372) — rate limits and capability
 * failures on both rails, one event per refusal.
 *
 * A census of REFUSALS, never a forensic record: the capability token, the
 * impression id, the campaign and the ip are all absent by construction, so
 * this stream can be aggregated without ever having handled a bearer secret.
 * `reason` is a closed enum owned by `ad-route-rate-limit.ts`.
 */
export const ADS_REQUEST_REJECTED_EVENT = 'ads.request_rejected' as const

type AxiomOnlyFieldType = 'string' | 'number' | 'boolean'
type AxiomOnlyFieldSchema = Record<string, AxiomOnlyFieldType>

const CONTEXT_PRUNING_FIELDS = {
  agent_run_id: 'string',
  parent_agent_run_id: 'string',
  client_session_id: 'string',
  client_request_id: 'string',
  trigger_reason: 'string',
  context_token_count: 'number',
  max_context_length: 'number',
  cache_gap_ms: 'number',
  cache_expiry_ms: 'number',
  cache_expiry_min_tokens: 'number',
  previous_summary_entry_count: 'number',
  user_budget: 'number',
  user_entry_count: 'number',
  dropped_user_entry_count: 'number',
  assistant_tool_budget: 'number',
  assistant_tool_entry_count: 'number',
  dropped_assistant_tool_entry_count: 'number',
  summary_estimated_tokens: 'number',
  mid_turn: 'boolean',
  live_user_prompt_found: 'boolean',
  live_user_prompt_text_preserved: 'boolean',
  newest_entry_forced: 'boolean',
} as const satisfies AxiomOnlyFieldSchema

const STREAM_RECOVERY_FIELDS = {
  metric: 'string',
  source: 'string',
  model: 'string',
  agentId: 'string',
  runId: 'string',
  userInputId: 'string',
  finishReason: 'string',
  hasYieldedContent: 'boolean',
  consecutive: 'number',
} as const satisfies AxiomOnlyFieldSchema

const ADS_FETCH_COMPLETED_FIELDS = {
  outcome: 'string',
  /**
   * The REQUEST-grain correlation handle (`adr_`, COD-406): one per HTTP ad
   * request on both rails, and the key of the decision outbox batch the same
   * request appends (`ad_decision_outbox_batch.request_id`). Opaque and
   * server-minted: never derived from the prompt, the IP, or the session.
   */
  request_id: 'string',
  /**
   * The AUCTION-grain handle (`opp_`, COD-369). Since COD-406 both rails mint
   * one per resolved placement; this event is request-grain, so it carries
   * the FIRST placement's -- exact for the single-placement request that is
   * the overwhelming case, and the same coarsest-honest answer it always gave
   * for a batch. Every placement's own id is on its `ad_impression` row and
   * in the outbox payload under `request_id` above.
   *
   * Every join the first-party chain needs already hangs off
   * `ad_impression.id`, so this is what connects an auction -- including the
   * ones that filled nothing -- to the row the rest of that chain reaches.
   */
  opportunity_id: 'string',
  /**
   * The frozen decision policy. `policy_version` is a 12-character digest of
   * the selection version, the deploy commit and the serving flag tuple;
   * `policy_commit` is the deploy SHA, `unknown` where the platform supplies
   * none (every local run). Two events sharing a `policy_version` were
   * decided by the same rules, on every pod.
   */
  policy_version: 'string',
  policy_commit: 'string',
  /**
   * Integer denominator for this event. Always 1 today -- nothing samples --
   * and present from the start so that future sampling becomes a divisor
   * rather than a silent break in every count already built on this stream.
   */
  sample_rate: 'number',
  /**
   * The 0-9999 bucket of the sticky per-user first-party arm, LOGGED AND NOT
   * ROUTED ON (COD-369). One person lands in the same bucket on every request
   * and every surface, which is what an incrementality read needs -- but the
   * route draw still reads a fresh per-request UUID, so today this field SIZES
   * the contrast a per-user arm would create rather than reporting one.
   * COD-362 moves delivery onto it.
   */
  first_party_arm_bucket: 'number',
  /**
   * The eligibility census: two counts and two producer-encoded histogram
   * strings. `eligible_campaign_labels` comma-joins opaque allocation labels
   * (`unlabeled` for a campaign carrying none) and `exclusion_reasons` is
   * `code:count` pairs sorted by code, omitted when nothing was excluded.
   * Campaign and advertiser ids never enter this event -- the label is the
   * campaign handle on Axiom, the raw id stays in Postgres.
   */
  eligible_campaign_count: 'number',
  excluded_campaign_count: 'number',
  eligible_campaign_labels: 'string',
  exclusion_reasons: 'string',
  /** Frozen decision context a later ranker cannot reconstruct after the fact. */
  hour_utc: 'number',
  /** Ads already served in this session; `-1` when the counter is unavailable. */
  session_ad_seq: 'number',
  /** The caller's model id, validated against the catalog; `unknown` when absent. */
  model: 'string',
  /** Slot value prior. `unscored` until provider eRPM priors exist (COD-272). */
  slot_erpm_bucket: 'string',
  requested_provider: 'string',
  served_provider: 'string',
  // This is a producer-encoded, bounded string such as
  // "gravity>first_party>carbon". Keep the raw attempted_providers array out
  // of Axiom so operational events remain scalar-only.
  attempted_provider_chain: 'string',
  experiment_arm: 'string',
  first_party_route: 'string',
  first_party_primary_percent: 'number',
  first_party_backfill_enabled: 'boolean',
  /** Geo-aware inventory controls and the bounded request classification used
   * by the routing policy. Country is an ISO-style two-letter code or absent;
   * no IP address or user identifier enters this event. */
  first_party_geo_routing_enabled: 'boolean',
  /**
   * COD-370. The viewer tier resolved on EVERY request, whether or not geo
   * routing was allowed to act on it: `tier1`, `tier2`, or `unknown`.
   *
   * Deliberately NOT a replacement for `first_party_inventory_geo_tier` below,
   * which keeps its gated meaning -- that field says what the ROUTING POLICY
   * saw, and reads `unknown` on every request while the flag is off. Merging
   * them would erase the distinction between "the viewer is in Tier 2" and
   * "we declined to look", which is the difference between an inventory fact
   * and a configuration fact. Carrying both is what lets a geo ramp be sized
   * from traffic that predates it.
   */
  request_geo_tier: 'string',
  first_party_inventory_geo_tier: 'string',
  first_party_geo_source: 'string',
  first_party_country_code: 'string',
  first_party_tier2_bonus_percent: 'number',
  /** Effective runtime money gates, emitted as bounded configuration state.
   * These are not campaign pricing or advertiser identifiers. */
  first_party_billing_mode: 'string',
  external_settlement_enabled: 'boolean',
  /**
   * Exact primary allocation is intentionally represented by an opaque,
   * operator-chosen cohort label rather than a campaign or advertiser id.
   * Producers emit `none` / 0 when the request is not assigned to a primary
   * cohort, so an absent field is distinguishable from a deliberate control.
   */
  first_party_primary_cohort: 'string',
  first_party_primary_cohort_percent: 'number',
  /** The opaque cohort that actually produced a first-party fill, or `none`. */
  first_party_served_cohort: 'string',
  /** `primary`, `gravity_no_fill_backfill`, `house_leg`, ..., or `none`. */
  first_party_entrypoint: 'string',
  /** Whether the COD-358 house leg could run on this request (not whether it did). */
  first_party_house_leg: 'boolean',
  /** CPC geo-pricing state. These names predate inventory geo routing and are
   * kept separate from `first_party_inventory_geo_tier`. */
  first_party_geo_tier: 'string',
  first_party_geo_floored: 'boolean',
  /** COD-264: the multiplier actually applied, and the resulting click price
   * as a bounded cents bucket. Both are carried because neither recovers the
   * other -- a scale that lands on the floor and one that lands below it
   * price the same, and only `first_party_geo_floored` tells them apart. */
  first_party_geo_multiplier_bps: 'number',
  first_party_geo_cpc_bucket: 'string',
  geo_cpc_enabled: 'boolean',
  /** Whether the immediately preceding Gravity attempt filled, no-filled, or
   * failed. This makes recovered no-fill inventory observable without logging
   * any campaign or creative identity. */
  gravity_outcome: 'string',
  selection_reason: 'string',
  ad_count: 'number',
  surface: 'string',
  placement_id: 'string',
  duration_ms: 'number',
  client_ua_product: 'string',
  client_ua_version: 'string',
  /**
   * CPC yield-shadow telemetry is a bounded operational comparison, never a
   * decision ledger. Values are producer-encoded buckets and provider states;
   * no raw priors, currency values, identifiers, or arrays are permitted.
   */
  yield_shadow_sampled: 'boolean',
  yield_shadow_policy_version: 'string',
  yield_shadow_scope: 'string',
  yield_shadow_exclusion_reason: 'string',
  yield_shadow_current_provider: 'string',
  yield_shadow_recommended_provider: 'string',
  yield_shadow_disagrees: 'boolean',
  yield_shadow_first_party_state: 'string',
  yield_shadow_first_party_value_bucket: 'string',
  yield_shadow_gravity_state: 'string',
  yield_shadow_gravity_value_bucket: 'string',
  yield_shadow_imprezia_state: 'string',
  yield_shadow_imprezia_value_bucket: 'string',
  yield_actual_attempt_chain: 'string',
  yield_requested_placement_count_bucket: 'string',
  yield_returned_ad_count_bucket: 'string',
  /** Live routing is represented only by bounded configuration and outcome
   * labels. Exact scores and decision identifiers stay in the durable ledger. */
  yield_live_mode: 'string',
  yield_live_activated: 'boolean',
  yield_live_reason: 'string',
  yield_live_arm: 'string',
  yield_live_policy_version: 'string',
  yield_live_estimate_version: 'string',
  yield_live_effective_treatment_bps: 'number',
  yield_live_planned_chain: 'string',
  yield_live_evidence_reservation_status: 'string',
  yield_live_evidence_status: 'string',
  /**
   * COD-361. What the decision-outbox producer did with this opportunity:
   * `scheduled | saturated | cooling_down | schedule_failed | disabled |
   * not_sampled`. On both rails, so a producer that stops writing is visible
   * as a change of STATUS rather than as an absence of rows -- an absence is
   * indistinguishable from the knob being off, which is the missingness this
   * field exists to make analysable.
   *
   * `decision_outbox_sample_rate_ppm` is the rate that ACTUALLY applied, so a
   * contested auction written by the >=2-admitted override reports certainty
   * rather than the configured sample. Zero on every unwritten opportunity.
   */
  decision_outbox_status: 'string',
  /**
   * DEPRECATED ALIAS of `inclusion_probability_ppm` (COD-367), kept for one
   * release so existing dashboards and the exporter keep resolving. Producers
   * emit both and they are pinned equal.
   *
   * NOT THE SAME FIELD AS `sample_rate` above, and the two must never be
   * merged. `sample_rate` is the EVENT-STREAM sampler -- the divisor for
   * counting `ads.fetch_completed` rows, hardcoded 1 on both rails because
   * nothing samples the stream. This is the DECISION-OUTBOX sampler: whether
   * the durable evidence row was written at all. An opportunity is always in
   * the event stream and usually not in the outbox, so one field cannot carry
   * both, and a query dividing by the wrong one is off by the sample percent.
   */
  decision_outbox_sample_rate_ppm: 'number',
  /**
   * COD-367. The probability this opportunity had of entering the decision
   * record, and WHY it did.
   *
   * The reason is what makes the probability readable: a value of 1,000,000
   * means "certain", and there are three different ways to be certain -- a
   * contested auction kept by the >=2-admitted override, a direct-sold serve,
   * and a 100%-sampled deployment -- which bias the sample three different
   * ways. Only `random_baseline` rows are an unbiased draw from the
   * opportunity population. Closed enum, owned by `AD_INCLUSION_REASONS`.
   */
  inclusion_probability_ppm: 'number',
  inclusion_reason: 'string',
  /**
   * COD-367. WHICH keying secret produced the `usr_` handle in the durable
   * decision payload, as `<label>_<fingerprint>`.
   *
   * Never the handle itself -- no user key enters this event. It is here so a
   * secret rotation is visible on the OPERATIONAL stream at the moment it
   * happens, rather than being discovered months later as an unexplained
   * discontinuity in a per-user aggregate built from the warehouse.
   */
  user_key_version: 'string',
  /**
   * COD-453. The sticky sponsor-break arm this request's viewer is in
   * (`control` | `reduced` | `reduced_spotlight` | `reduced_intermission`),
   * and the separate showcase-cadence arm beside it.
   *
   * Present on EVERY completion event, including the overwhelming majority
   * that carry no break placement at all -- because the arm is a property of
   * the PERSON, and the inline delivery a `reduced` user gets is exactly what
   * the arm has to be compared on. Reporting it only on break requests would
   * leave the cadence half of the hypothesis unmeasurable.
   *
   * While `FREEBUFF_SPONSOR_BREAK_EXPERIMENT` is `off` this reads `control`
   * for everyone, which is the same value it carried before the field
   * existed -- so the knob's `off` state remains a true no-op.
   */
  sponsor_break_arm: 'string',
  showcase_arm: 'string',
  /**
   * The daily-cap verdict, present only on a request that RESOLVED a break
   * placement: `allowed`, `capped`, `too_early` or `unavailable`.
   *
   * The three refusals collapse to one census code (`break_capped`) because
   * the census is a closed histogram; they stay separate HERE because they are
   * three different incidents. A rise in `unavailable` is Redis, a rise in
   * `too_early` is the minimum-session floor binding harder than intended, and
   * only `capped` is the feature working.
   */
  sponsor_break_cap_status: 'string',
  /**
   * Why a no-fill was a no-fill, when the rails know a reason ahead of the
   * provider chain. `break_capped` is the only value today.
   *
   * Deliberately NOT folded into `outcome`: every dashboard built on this
   * stream partitions on `outcome`, and adding a fifth value to it would
   * silently drop capped requests out of every no-fill count that already
   * exists.
   */
  no_fill_reason: 'string',
} as const satisfies AxiomOnlyFieldSchema

/**
 * The `ads.fetch_completed` allowlist, exported for the decision-contract test
 * (COD-367).
 *
 * It is the Axiom half of the contract the durable decision record is the
 * warehouse half of, and it was pinned nowhere: a field could be added,
 * renamed or dropped here and no test would notice, on a stream several
 * dashboards and the yield read are built on.
 *
 * RAIL PARITY -- that both rails actually EMIT the same subset -- is COD-406's
 * test, not this one. This pins the vocabulary; that pins the producers.
 */
export const ADS_FETCH_COMPLETED_FIELD_NAMES: readonly string[] = Object.keys(
  ADS_FETCH_COMPLETED_FIELDS,
)

const ADS_IMPREZIA_FETCH_COMPLETED_FIELDS = {
  outcome: 'string',
  /**
   * Server-minted correlation handles for this route's single placement.
   * These are the same request/opportunity identities written by the route;
   * client, session, prompt, and provider request identifiers stay excluded.
   */
  request_id: 'string',
  opportunity_id: 'string',
  selection_reason: 'string',
  experiment_arm: 'string',
  surface: 'string',
  ad_count: 'number',
  duration_ms: 'number',
  test_mode: 'boolean',
  failure_class: 'string',
} as const satisfies AxiomOnlyFieldSchema

const ADS_IMPREZIA_FETCH_OUTCOMES = [
  'fill',
  'no_fill',
  'timeout',
  'provider_error',
  'not_configured',
  'not_eligible',
  /**
   * Our book took the slot before Imprezia was asked (COD-338). Its own
   * outcome rather than a `not_eligible` failure class: the request was
   * perfectly eligible, we chose not to ask, and every eligibility-rate and
   * fill-collapse query grouped on `outcome` must keep meaning what it did.
   */
  'preempted',
] as const
const ADS_IMPREZIA_SELECTION_REASONS = ['primary', 'fallback'] as const
const ADS_IMPREZIA_EXPERIMENT_ARMS = [
  'imprezia_forced',
  'imprezia_first',
  'control',
] as const
const ADS_IMPREZIA_BROWSER_SURFACES = [
  'freebuff_web_chat',
  'chat_assistant',
] as const
const ADS_IMPREZIA_FAILURE_CLASSES = [
  'missing_api_key',
  'missing_user_agent',
  'invalid_source_url',
  'provider_timeout',
  'provider_failure',
  'client_exception',
] as const
const ADS_IMPREZIA_MAX_DURATION_MS = 60_000
const AD_REQUEST_GRAIN_ID_RE = /^adr_[0-9a-f]{32}$/
const AD_OPPORTUNITY_ID_RE = /^opp_[0-9a-f]{32}$/

function sanitizeImpreziaFetchCompletedFields(
  record: Record<string, unknown>,
): AxiomOnlyLogEvent['data'] | null {
  const data = sanitizeAllowlistedFields(
    record,
    ADS_IMPREZIA_FETCH_COMPLETED_FIELDS,
  )
  const outcome = data.outcome
  const requestId = data.request_id
  const opportunityId = data.opportunity_id
  const selectionReason = data.selection_reason
  const experimentArm = data.experiment_arm
  const surface = data.surface
  const adCount = data.ad_count
  const durationMs = data.duration_ms
  const testMode = data.test_mode
  const failureClass = data.failure_class

  if (
    !ADS_IMPREZIA_FETCH_OUTCOMES.includes(
      outcome as (typeof ADS_IMPREZIA_FETCH_OUTCOMES)[number],
    ) ||
    typeof requestId !== 'string' ||
    !AD_REQUEST_GRAIN_ID_RE.test(requestId) ||
    typeof opportunityId !== 'string' ||
    !AD_OPPORTUNITY_ID_RE.test(opportunityId) ||
    !ADS_IMPREZIA_SELECTION_REASONS.includes(
      selectionReason as (typeof ADS_IMPREZIA_SELECTION_REASONS)[number],
    ) ||
    !ADS_IMPREZIA_EXPERIMENT_ARMS.includes(
      experimentArm as (typeof ADS_IMPREZIA_EXPERIMENT_ARMS)[number],
    ) ||
    !ADS_IMPREZIA_BROWSER_SURFACES.includes(
      surface as (typeof ADS_IMPREZIA_BROWSER_SURFACES)[number],
    ) ||
    (adCount !== 0 && adCount !== 1) ||
    (outcome === 'fill' ? adCount !== 1 : adCount !== 0) ||
    typeof durationMs !== 'number' ||
    durationMs < 0 ||
    durationMs > ADS_IMPREZIA_MAX_DURATION_MS ||
    typeof testMode !== 'boolean' ||
    (failureClass !== undefined &&
      !ADS_IMPREZIA_FAILURE_CLASSES.includes(
        failureClass as (typeof ADS_IMPREZIA_FAILURE_CLASSES)[number],
      ))
  ) {
    return null
  }
  return data
}

/**
 * First-party inventory selection is operational telemetry only. In
 * particular, campaign/creative/placement arrays and user/session IDs stay
 * out: their cardinality makes them unsuitable for the event stream and they
 * are available in the database when an operator needs drill-down.
 */
const ADS_FIRST_PARTY_DECISION_FIELDS = {
  outcome: 'string',
  primary_allocation_invalid: 'boolean',
  no_fill_reason: 'string',
  selection_reason: 'string',
  ad_count: 'number',
  placement_count: 'number',
  candidate_count: 'number',
  candidate_load_ms: 'number',
  frequency_status: 'string',
  frequency_unavailable_cause: 'string',
  frequency_unavailable_causes: 'string',
  frequency_reservation_ms: 'number',
  frequency_max_reservation_ms: 'number',
  duration_ms: 'number',
} as const satisfies AxiomOnlyFieldSchema

/** Settlement telemetry deliberately excludes impression, campaign, and
 * advertiser identifiers. The bounded status/reason and amount fields are
 * sufficient for charge and absorption dashboards. */
const ADS_FIRST_PARTY_SETTLEMENT_FIELDS = {
  metric: 'string',
  billing_model: 'string',
  settlement_status: 'string',
  absorbed_reason: 'string',
  amount_cents: 'number',
  balance_cents: 'number',
  duration_ms: 'number',
} as const satisfies AxiomOnlyFieldSchema

const ADS_FIRST_PARTY_TRACKING_FIELDS = {
  provider: 'string',
  surface: 'string',
  placement_id: 'string',
  already_clicked: 'boolean',
  impression_recorded: 'boolean',
  pixel_count: 'number',
  /**
   * COD-365 hygiene. `client_event_id` is the client-minted, per-logical-
   * event UUID (opaque, bounded, never parsed); `deduped` says this request
   * did NOT transition the row, so a transition count is
   * `where deduped == false`. `render_delay_ms` is the client-measured
   * receipt-to-mount delay, clamped and never derived. `opportunity_id` and
   * `creative_version` are copied off the impression row so the event can
   * join the auction and the copy without a database read.
   * `client_family` is derived server-side from the UA; `sample_rate` is the
   * integer denominator, 1 until something samples.
   */
  client_event_id: 'string',
  deduped: 'boolean',
  render_delay_ms: 'number',
  opportunity_id: 'string',
  creative_version: 'number',
  client_family: 'string',
  sample_rate: 'number',
  /**
   * COD-453. On a first-party CLICK only, and only from a sponsor break: how
   * long the break had been on screen. Absent means the client measured none,
   * which is every inline click. Here as well as on `ads.break_clicked` so the
   * SETTLED click -- the one the ledger actually billed -- carries its own
   * dwell, without a join to a client event that may have been lost.
   */
  dwell_ms: 'number',
} as const satisfies AxiomOnlyFieldSchema

/**
 * A client attempt to acknowledge a first-party unit it mounted. This is an
 * operational transport census, never an attribution record: opaque tokens,
 * identifiers, URLs, bodies, and raw errors are rejected rather than redacted.
 */
export type FirstPartyViewAckTelemetry = FirstPartyViewAckObservation

const FIRST_PARTY_VIEW_ACK_FIELDS = [
  'surface',
  'placement_id',
  'outcome',
  'attempt',
  'duration_ms',
  'client_family',
] as const

/**
 * Fields a NEWER client may add to the exact set above (COD-365). Optional
 * on the check, not appended to the exact set, because a released CLI or
 * Desktop binary still sends the six-field shape and its events must stay
 * valid. Each is still validated when present -- a malformed value rejects
 * the whole event exactly as a malformed required field does.
 */
const FIRST_PARTY_VIEW_ACK_OPTIONAL_FIELDS = [
  'client_event_id',
  'sample_rate',
] as const
const FIRST_PARTY_VIEW_ACK_CLIENT_EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

const FIRST_PARTY_VIEW_ACK_PLACEMENTS = new Map<string, string>(
  PLACEMENT_SLOTS.map((slot) => [slot.id, slot.surface]),
)

/**
 * Validate the only telemetry payload a client may send for view
 * acknowledgement. Returning null rejects the entire event: dropping an
 * unsafe field but retaining the count would make malformed client input look
 * like a real rendering signal.
 */
export function createFirstPartyViewAckTelemetry(
  input: unknown,
): FirstPartyViewAckTelemetry | null {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return null
  }
  const record = input as Record<string, unknown>
  const keys = Object.keys(record)
  const required = new Set<string>(FIRST_PARTY_VIEW_ACK_FIELDS)
  const optional = new Set<string>(FIRST_PARTY_VIEW_ACK_OPTIONAL_FIELDS)
  if (
    keys.some((key) => !required.has(key) && !optional.has(key)) ||
    FIRST_PARTY_VIEW_ACK_FIELDS.some((key) => !(key in record))
  ) {
    return null
  }
  const clientEventId = record.client_event_id
  const sampleRate = record.sample_rate
  if (
    (clientEventId !== undefined &&
      (typeof clientEventId !== 'string' ||
        !FIRST_PARTY_VIEW_ACK_CLIENT_EVENT_ID_RE.test(clientEventId))) ||
    (sampleRate !== undefined &&
      (typeof sampleRate !== 'number' ||
        !Number.isInteger(sampleRate) ||
        sampleRate < 1))
  ) {
    return null
  }

  const surface = record.surface
  const placementId = record.placement_id
  const outcome = record.outcome
  const attempt = record.attempt
  const durationMs = record.duration_ms
  const clientFamily = record.client_family
  if (
    typeof surface !== 'string' ||
    typeof placementId !== 'string' ||
    FIRST_PARTY_VIEW_ACK_PLACEMENTS.get(placementId) !== surface ||
    !FIRST_PARTY_VIEW_ACK_OUTCOMES.includes(
      outcome as FirstPartyViewAckOutcome,
    ) ||
    typeof attempt !== 'number' ||
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    attempt > 3 ||
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    durationMs > FIRST_PARTY_VIEW_ACK_MAX_DURATION_MS ||
    !FIRST_PARTY_VIEW_ACK_CLIENT_FAMILIES.includes(
      clientFamily as FirstPartyViewAckClientFamily,
    )
  ) {
    return null
  }
  return {
    surface,
    placement_id: placementId,
    outcome: outcome as FirstPartyViewAckOutcome,
    attempt: attempt as 1 | 2 | 3,
    duration_ms: durationMs,
    client_family: clientFamily as FirstPartyViewAckClientFamily,
    ...(clientEventId !== undefined
      ? { client_event_id: clientEventId as string }
      : {}),
    ...(sampleRate !== undefined ? { sample_rate: sampleRate as number } : {}),
  }
}

/** Keep the advertiser postback stream safe to aggregate. In particular this
 * must not grow into an attribution/debugging record: the database owns that
 * drill-down and Axiom receives only bounded operational dimensions. */
const ADS_EXTERNAL_CONVERSION_POSTBACK_FIELDS = {
  // Which ingress reported: 's2s' (key-authenticated postback) or 'client'
  // (the keyless browser endpoint). Two-valued, never a partner identifier.
  channel: 'string',
  outcome: 'string',
  rejection_reason: 'string',
  click_id_shape: 'string',
  event_type: 'string',
  traffic_class: 'string',
  primary_allocation_cohort: 'string',
  settlement_status: 'string',
  charged_cents: 'number',
  duration_ms: 'number',
  // Identity rail only (docs/freebuff-placements-conversions.md §16): how the
  // hashed-email lookup ended — matched | observed_match | unmatched |
  // ambiguous | gated | consent_denied — and 'none' on every click-id row.
  // Bounded by construction; never a digest, never a user.
  match_outcome: 'string',
} as const satisfies AxiomOnlyFieldSchema

function sanitizeExternalConversionPostbackFields(
  record: Record<string, unknown>,
): AxiomOnlyLogEvent['data'] {
  const data = sanitizeAllowlistedFields(
    record,
    ADS_EXTERNAL_CONVERSION_POSTBACK_FIELDS,
  )
  if (
    typeof data.click_id_shape === 'string' &&
    !(ADS_EXTERNAL_CONVERSION_CLICK_ID_SHAPES as readonly string[]).includes(
      data.click_id_shape,
    )
  ) {
    delete data.click_id_shape
  }
  return data
}

const ADS_CAMPAIGN_INGRESS_EVIDENCE_FIELDS = {
  evidence_version: 'string',
  evidence_id: 'string',
  advertiser_id: 'string',
  campaign_id: 'string',
  campaign_config_revision: 'number',
  binding_status: 'string',
  outcome: 'string',
  rail: 'string',
  traffic_class: 'string',
  traffic_class_version: 'string',
} as const satisfies AxiomOnlyFieldSchema

const ADS_MCP_TOOL_CALL_FIELDS = {
  advertiser_id: 'string',
  key_id: 'string',
  tool: 'string',
  outcome: 'string',
  error_code: 'string',
  duration_ms: 'number',
} as const satisfies AxiomOnlyFieldSchema

const ADS_ADVERTISER_REPORTING_READ_FIELDS = {
  advertiser_id: 'string',
  key_id: 'string',
  endpoint: 'string',
  range_days: 'number',
  rows: 'number',
  duration_ms: 'number',
  outcome: 'string',
} as const satisfies AxiomOnlyFieldSchema

/** The refusal census. Bounded producer-encoded labels only; the closed
 *  `reason` enum lives beside the limiter that produces it. */
const ADS_REQUEST_REJECTED_FIELDS = {
  route: 'string',
  rail: 'string',
  reason: 'string',
  limiter_backend: 'string',
  /** True in the `observe` phase: the request was SERVED and this records the
   *  verdict enforcement would have produced. */
  would_limit: 'boolean',
} as const satisfies AxiomOnlyFieldSchema

/**
 * The three SPONSOR-BREAK client events (COD-453). One allowlist for all
 * three: they share a subject -- one break, on one placement, for one person
 * in one arm -- and splitting them into three near-identical tables is how the
 * shown/closed pair drifts until a close cannot be matched to its show.
 *
 * Every field is a scalar and none of them identifies anybody:
 * `campaign_label` is the opaque allocation label the census already uses, and
 * no campaign id, advertiser id, creative text, url or user id may enter here.
 */
const ADS_SPONSOR_BREAK_FIELDS = {
  placement_id: 'string',
  surface: 'string',
  /** `spotlight` | `showcase` | `intermission`. */
  format: 'string',
  sponsor_break_arm: 'string',
  campaign_label: 'string',
  creative_version: 'number',
  opportunity_id: 'string',
  /** `ads.break_shown` only. `turn_completed` today. */
  trigger: 'string',
  /** `ads.break_closed` only; the closed method vocabulary. */
  method: 'string',
  /**
   * How long the break held the screen, clamped to an hour. Absent means
   * UNKNOWN and is never reconstructed from timestamps -- the same rule
   * `render_delay_ms` follows.
   */
  dwell_ms: 'number',
  /** Intermission's countdown, and whether it ran out before they acted. */
  timer_ms: 'number',
  timer_completed: 'boolean',
  // COD-365 hygiene, required on every client ads event by the CI guard.
  client_event_id: 'string',
  client_family: 'string',
  sample_rate: 'number',
} as const satisfies AxiomOnlyFieldSchema

export const ADS_SPONSOR_BREAK_FIELD_NAMES: readonly string[] = Object.keys(
  ADS_SPONSOR_BREAK_FIELDS,
)

export type AxiomOnlyLogEvent = {
  event:
    | typeof CONTEXT_PRUNING_COMPLETED_EVENT
    | typeof STREAM_RECOVERY_EVENT
    | typeof ADS_FETCH_COMPLETED_EVENT
    | typeof ADS_FIRST_PARTY_DECISION_EVENT
    | typeof ADS_FIRST_PARTY_SETTLEMENT_EVENT
    | typeof ADS_FIRST_PARTY_VIEW_ACK_EVENT
    | typeof ADS_FIRST_PARTY_CLICK_RECORDED_EVENT
    | typeof ADS_FIRST_PARTY_IMPRESSION_RECORDED_EVENT
    | typeof ADS_EXTERNAL_CONVERSION_POSTBACK_EVENT
    | typeof ADS_CAMPAIGN_INGRESS_EVIDENCE_EVENT
    | typeof ADS_ADVERTISER_REPORTING_READ_EVENT
    | typeof ADS_MCP_TOOL_CALL_EVENT
    | typeof ADS_IMPREZIA_FETCH_COMPLETED_EVENT
    | typeof ADS_REQUEST_REJECTED_EVENT
    | SponsorBreakEvent
  data: Record<string, string | number | boolean>
}

/** Keep only the allowlisted keys whose value matches the declared type
 *  (strings truncated); everything else is dropped. */
function sanitizeAllowlistedFields(
  record: Record<string, unknown>,
  fields: AxiomOnlyFieldSchema,
): AxiomOnlyLogEvent['data'] {
  const sanitized: AxiomOnlyLogEvent['data'] = {}
  for (const [key, expectedType] of Object.entries(fields)) {
    const value = record[key]
    if (typeof value !== expectedType) continue
    if (typeof value === 'string') {
      sanitized[key] = value.slice(0, 200)
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = value
    } else if (typeof value === 'boolean') {
      sanitized[key] = value
    }
  }
  return sanitized
}

/**
 * Return a sanitized Axiom-only event, or null for ordinary logger payloads.
 * The event name comes from `data.axiomEvent` (the in-process marker set at
 * the log call site) or the `event` param (the wire-format field a caller
 * already extracted, e.g. the server-side sink re-checking a persisted
 * `LogRow`). Unknown keys and unexpected value types are deliberately
 * discarded.
 *
 * Matched by exact equality (not a lookup keyed on the caller-supplied name)
 * so a value like 'constructor' can't resolve through an object's prototype.
 */
export function getAxiomOnlyLogEvent(
  data: unknown,
  event?: string | null,
): AxiomOnlyLogEvent | null {
  const record =
    data != null && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {}
  const eventName =
    typeof record.axiomEvent === 'string' ? record.axiomEvent : event

  if (eventName === CONTEXT_PRUNING_COMPLETED_EVENT) {
    return {
      event: eventName,
      data: sanitizeAllowlistedFields(record, CONTEXT_PRUNING_FIELDS),
    }
  }
  if (eventName === STREAM_RECOVERY_EVENT) {
    return {
      event: eventName,
      data: sanitizeAllowlistedFields(record, STREAM_RECOVERY_FIELDS),
    }
  }
  if (eventName === ADS_FETCH_COMPLETED_EVENT) {
    return {
      event: eventName,
      data: sanitizeAllowlistedFields(record, ADS_FETCH_COMPLETED_FIELDS),
    }
  }
  if (eventName === ADS_IMPREZIA_FETCH_COMPLETED_EVENT) {
    const data = sanitizeImpreziaFetchCompletedFields(record)
    return data ? { event: eventName, data } : null
  }
  if (eventName === ADS_FIRST_PARTY_DECISION_EVENT) {
    return {
      event: eventName,
      data: sanitizeAllowlistedFields(record, ADS_FIRST_PARTY_DECISION_FIELDS),
    }
  }
  if (eventName === ADS_FIRST_PARTY_SETTLEMENT_EVENT) {
    return {
      event: eventName,
      data: sanitizeAllowlistedFields(
        record,
        ADS_FIRST_PARTY_SETTLEMENT_FIELDS,
      ),
    }
  }
  if (eventName === ADS_FIRST_PARTY_VIEW_ACK_EVENT) {
    // `axiomEvent` is the in-process marker only; it is not telemetry data.
    const { axiomEvent: _axiomEvent, ...payload } = record
    const telemetry = createFirstPartyViewAckTelemetry(payload)
    return telemetry ? { event: eventName, data: { ...telemetry } } : null
  }
  if (
    eventName === ADS_FIRST_PARTY_CLICK_RECORDED_EVENT ||
    eventName === ADS_FIRST_PARTY_IMPRESSION_RECORDED_EVENT
  ) {
    return {
      event: eventName,
      data: sanitizeAllowlistedFields(record, ADS_FIRST_PARTY_TRACKING_FIELDS),
    }
  }
  if (eventName === ADS_REQUEST_REJECTED_EVENT) {
    return {
      event: eventName,
      data: sanitizeAllowlistedFields(record, ADS_REQUEST_REJECTED_FIELDS),
    }
  }
  if (
    eventName === ADS_BREAK_SHOWN_EVENT ||
    eventName === ADS_BREAK_CLOSED_EVENT ||
    eventName === ADS_BREAK_CLICKED_EVENT
  ) {
    return {
      event: eventName,
      data: sanitizeAllowlistedFields(record, ADS_SPONSOR_BREAK_FIELDS),
    }
  }
  if (eventName === ADS_EXTERNAL_CONVERSION_POSTBACK_EVENT) {
    return {
      event: eventName,
      data: sanitizeExternalConversionPostbackFields(record),
    }
  }
  if (eventName === ADS_CAMPAIGN_INGRESS_EVIDENCE_EVENT) {
    return {
      event: eventName,
      data: sanitizeAllowlistedFields(
        record,
        ADS_CAMPAIGN_INGRESS_EVIDENCE_FIELDS,
      ),
    }
  }
  if (eventName === ADS_ADVERTISER_REPORTING_READ_EVENT) {
    return {
      event: eventName,
      data: sanitizeAllowlistedFields(
        record,
        ADS_ADVERTISER_REPORTING_READ_FIELDS,
      ),
    }
  }
  if (eventName === ADS_MCP_TOOL_CALL_EVENT) {
    return {
      event: eventName,
      data: sanitizeAllowlistedFields(record, ADS_MCP_TOOL_CALL_FIELDS),
    }
  }
  return null
}

/**
 * COD-365 hygiene contract, exported for the CI guard in
 * `__tests__/axiom-only-log.test.ts`: every ads event allowlist this module
 * owns for CLIENT-emitted events must carry these keys, and an unsampled
 * producer emits `sample_rate: 1`. `ADS_FETCH_COMPLETED_FIELDS` is a server
 * event owned by the rail slice (COD-369): it carries `sample_rate` already
 * and is deliberately outside this guard until it also carries
 * `client_family`, at which point the guard widens to
 * `ADS_FETCH_COMPLETED_FIELD_NAMES`.
 */
export const ADS_CLIENT_EVENT_HYGIENE_FIELDS = [
  'client_event_id',
  'client_family',
  'sample_rate',
] as const
export const ADS_FIRST_PARTY_TRACKING_FIELD_NAMES: readonly string[] =
  Object.keys(ADS_FIRST_PARTY_TRACKING_FIELDS)
export const FIRST_PARTY_VIEW_ACK_FIELD_NAMES: readonly string[] = [
  ...FIRST_PARTY_VIEW_ACK_FIELDS,
  ...FIRST_PARTY_VIEW_ACK_OPTIONAL_FIELDS,
]
