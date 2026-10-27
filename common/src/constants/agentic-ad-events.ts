/**
 * The agentic-ads proposal funnel — the event vocabulary for sponsored
 * proposals served through the first-party placements rail.
 *
 * A sponsored proposal moves through a funnel that is longer than a display
 * ad's serve/view/click: it is offered, displayed, accepted, committed, may
 * open and merge a PR, and the advertiser may later observe
 * downstream activation on their own side. Every stage below is recorded so
 * the next campaign can be priced from measured drop-off — but recording is
 * all most of them do.
 *
 * ## The billing rule (decision 2026-08-27)
 *
 * Billing is CPC where the click IS the proposal Accept. The accept flows
 * through the rail's existing first-party click path
 * (`settleFirstPartyClick`), exactly like a display click on the same
 * campaign — nothing in THIS vocabulary ever settles. Every other funnel
 * event is pure telemetry: it must never create a charge, move advertiser
 * ledger balance, or touch a user's credits. `pr_made`/`landed`/`merged`
 * price the NEXT campaign; they do not bill this one.
 *
 * This file is deliberately dependency-free so the Postgres schema
 * (`packages/internal/src/db/schema.ts`), the ad-serving rail, and Convex
 * modules (`freebuff/web/convex/ads/*`) can all import the same closed set.
 */

export const AGENTIC_FUNNEL_EVENT_TYPES = [
  /** A sponsored proposal card was offered to a user. */
  'proposal_offered',
  /**
   * The user pressed Accept. This is the one billable stage, and it bills as
   * the campaign's CPC CLICK through the existing first-party click
   * settlement — never through funnel-event recording.
   */
  'accepted',
  /**
   * RETIRED 2026-09-09 (COD-516). Never had a producer, and `landed` already
   * means "a pull request was opened" everywhere it is read — `sponsoredDelivery.ts`
   * records the PR and only then calls the row `landed`, the off-Cloud state
   * route writes `landed` on a `pr_url`, and the shared view model renders the
   * link from `landed`. A second word for the same fact would put the same PR
   * in two funnel rows and make the drop-off between them read as loss.
   *
   * Stays in the array because the Postgres enum mirrors it in ORDER (see
   * below) and an enum value cannot be dropped; readouts skip it through
   * `RETIRED_AGENTIC_FUNNEL_EVENT_TYPES`. Nothing may write it.
   */
  'pr_made',
  /** A pull request was opened. The stored name is retained for enum compatibility. */
  'landed',
  /** The PR was merged by the repo's owners. */
  'merged',
  /** The run installed the advertiser's MCP server. */
  'mcp_installed',
  /** The run provisioned or wired an API key for the advertiser's service. */
  'api_key_issued',
  /** Advertiser-side: the user created an account with the advertiser. */
  'account_created',
  /**
   * Advertiser-side: the integrated tool was used. Recurring by design — the
   * advertiser may report it many times with distinct event ids.
   */
  'tool_used',
  // APPEND-ONLY BELOW THIS LINE. The Postgres enum
  // `ad_agentic_funnel_event_type` mirrors this array in ORDER, and the only
  // migration Postgres can apply cheaply is `ALTER TYPE ... ADD VALUE`, which
  // appends. Inserting a member in the middle asks drizzle-kit to drop and
  // recreate a type an append-only ledger already depends on, so a new stage
  // goes at the END no matter where it sits in the funnel's story.
  /**
   * The user declined the proposal card. The other half of `proposal_offered`:
   * without it an offer that was neither accepted nor dismissed is
   * indistinguishable from one the user simply never saw, and the drop-off the
   * next campaign is priced from cannot be measured.
   */
  'dismissed',
  /**
   * The sponsored run ended without committable work. Telemetry, and pointedly
   * not a refund signal — the money already moved at Accept, and COD-92 owns
   * whether a failed run is refunded.
   */
  'run_failed',
  /**
   * The run committed its work to its own branch and stopped there. The stage
   * the advertiser actually buys under COD-279 ("the agent should implement
   * with commits along the way, user can PR if they think its good") — a PR
   * that is never opened does not mean the work was not done.
   */
  'run_committed',
  /**
   * The sponsored proposal card was actually visible on a supported surface.
   *
   * This is deliberately later than `proposal_offered`: the latter is a
   * durable server decision while this records a card the owner could see.
   * It is telemetry only and is never a billing trigger.
   */
  'proposal_displayed',
  /**
   * An IN-PLACE run left its work in the user's working copy and stopped
   * there (the 2026-09-24 amendment in
   * `freebuff-sponsored-local-execution.md`). The same buying stage as
   * `run_committed` -- the work was done -- on a surface where there is no
   * branch to commit it to, so it is a SEPARATE stage rather than a reuse:
   * `run_committed` is read as "a commit exists that a pull request could be
   * opened from", and for one of these rows no such commit does.
   */
  'run_delivered',
  // The client-and-server funnel (agentic ads revamp, 2026-10-23, COD-935).
  // Every one is telemetry: `accepted` stays the only billable stage, and
  // `accept_clicked` below is the press, not the charge.
  /**
   * A client was handed an offered proposal: the agentic offer route's
   * response that carried it went out (`/api/v1/ads/agentic/offer`; the
   * legacy `/api/ads` agentic slot does not write it). Later than
   * `proposal_offered` (the server minted the offer) and earlier than
   * `proposal_displayed` (the card was visible), so a drop between the three
   * says whether the offer was lost in transit or never shown.
   */
  'offer_received',
  /** The user opened the card's plan (its procedure preview). */
  'plan_viewed',
  /**
   * The user pressed Accept on the client, recorded before the Accept POST
   * answers. NOT a charge and never billable: the charge is `accepted`,
   * which only the funded Accept writes. Pressed-but-not-accepted is the gap
   * between the two.
   */
  'accept_clicked',
  /**
   * The server refused an Accept (a 409: the offer expired, the procedure
   * changed, the project is not a fit, ...). REPEATING: each refusal has its
   * own event id, and the refusal code is in `metadata.reason`.
   */
  'accept_refused',
  /** The accepted run started executing on the user's machine. */
  'run_started',
  /**
   * The run stopped to wait on the user (an account step, a credential).
   * REPEATING: each wait has its own event id.
   */
  'needs_you',
  /** The user undid the run's changes. */
  'undo',
  /**
   * A sponsored run opened the advertiser's tracked sign-up link for the user
   * (Desktop's in-app browser, COD-965). Once per proposal: a reopened tab is
   * the same stage. The step between `needs_you` and the advertiser's own
   * `account_created`, so "never opened" and "opened, never signed up" read
   * apart. Telemetry only.
   */
  'signup_opened',
] as const

export type AgenticFunnelEventType = (typeof AGENTIC_FUNNEL_EVENT_TYPES)[number]

/**
 * Members that remain in the array only because the Postgres enum is
 * append-only. No producer writes them, and every readout
 * (`packages/internal/src/ad-serving/agentic-funnel-readout.ts`) excludes
 * them, so a stray row -- a seeder, an old build -- can never surface as a
 * funnel stage. Kept as data so the exclusion is asserted rather than trusted.
 */
export const RETIRED_AGENTIC_FUNNEL_EVENT_TYPES = ['pr_made'] as const

/**
 * Stages that can happen more than once per proposal. Funnel recording
 * dedupes on `(campaign_id, event_id)`, so each occurrence carries its own
 * event id rather than one derived from the proposal alone, which would keep
 * only the first.
 */
export const REPEATING_AGENTIC_FUNNEL_EVENT_TYPES = [
  'accept_refused',
  'needs_you',
  'tool_used',
] as const satisfies readonly AgenticFunnelEventType[]

/**
 * The stages a proposal's owner reports from their client, through
 * `POST /api/v1/ads/proposal/{id}/event` (Desktop, the CLI) or
 * `POST /api/web/ads/proposal/{id}/event` (the browser workspace). Only what
 * the client alone can see: the server records `offer_received`,
 * `accept_refused` and `run_started` itself, where it observes them, and
 * `accepted` stays the funded Accept's own row.
 */
export const CLIENT_REPORTED_AGENTIC_FUNNEL_EVENT_TYPES = [
  'plan_viewed',
  'accept_clicked',
  'needs_you',
  'undo',
  'signup_opened',
] as const satisfies readonly AgenticFunnelEventType[]

export type ClientReportedAgenticFunnelEventType =
  (typeof CLIENT_REPORTED_AGENTIC_FUNNEL_EVENT_TYPES)[number]

export function isClientReportedAgenticFunnelEvent(
  value: unknown,
): value is ClientReportedAgenticFunnelEventType {
  return (
    CLIENT_REPORTED_AGENTIC_FUNNEL_EVENT_TYPES as readonly unknown[]
  ).includes(value)
}

export function isRepeatingAgenticFunnelEvent(
  eventType: AgenticFunnelEventType,
): boolean {
  return (REPEATING_AGENTIC_FUNNEL_EVENT_TYPES as readonly string[]).includes(
    eventType,
  )
}

/** A client's occurrence id: what tells two waits on one run apart. */
export const AGENTIC_FUNNEL_OCCURRENCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The idempotency key of one funnel stage of one proposal:
 * `<type>:<proposalId>`, as the state route and the funnel bridge derive
 * theirs, so a retried report records once. A REPEATING stage appends the
 * occurrence (`<type>:<proposalId>:<occurrence>`): one row per wait or
 * refusal, and still one per retry of the same one.
 */
export function agenticProposalFunnelEventId(
  eventType: AgenticFunnelEventType,
  proposalId: string,
  occurrenceId?: string,
): string {
  return occurrenceId === undefined
    ? `${eventType}:${proposalId}`
    : `${eventType}:${proposalId}:${occurrenceId}`
}

/**
 * The `accepted` event's idempotency key, derived from the PROPOSAL id.
 *
 * Funnel recording dedupes on `(campaignId, eventId)`, so the key is what
 * makes "Accept twice records one row" true rather than hoped for. The
 * proposal id is the only identifier that is stable across a retried
 * settlement, a redelivered scheduler run and a second Accept attempt — an
 * impression token would be equally stable but is absent on a seeded row, and
 * a fresh uuid per attempt would record the same accept twice.
 *
 * Prefixed rather than used bare so a future funnel event derived from the
 * same proposal (a `dismissed` census, say) cannot collide with this one.
 *
 * Lives HERE, in the dependency-free vocabulary, because the producer (the
 * Next settle route) and the consumer of the guarantee (Convex, which may
 * never import `@codebuff/internal`) must agree on it without either one
 * importing the other.
 */
export function agenticAcceptEventId(proposalId: string): string {
  return `accept_${proposalId}`
}

/**
 * The only funnel stage that may ever bill, and it bills as a click. Kept as
 * data so tests can prove the rule instead of trusting a comment.
 */
export const AGENTIC_BILLABLE_FUNNEL_EVENT_TYPES = ['accepted'] as const

export function isBillableAgenticFunnelEvent(
  eventType: AgenticFunnelEventType,
): boolean {
  return (AGENTIC_BILLABLE_FUNNEL_EVENT_TYPES as readonly string[]).includes(
    eventType,
  )
}

/**
 * The subset an advertiser may report through the S2S postback
 * (`POST /api/ads/agentic/postback`). Everything else is observed by our own
 * side (the proposal surface and the sponsored run) and must not be
 * accepted from a partner: an advertiser asserting `merged` about our own
 * run would be self-reported telemetry about facts we can read directly.
 */
export const AGENTIC_POSTBACK_EVENT_TYPES = [
  'account_created',
  'tool_used',
] as const

export type AgenticPostbackEventType =
  (typeof AGENTIC_POSTBACK_EVENT_TYPES)[number]

/** Who observed the event: our own serving/run pipeline, or the advertiser. */
export const AGENTIC_FUNNEL_EVENT_SOURCES = [
  'internal',
  'advertiser_postback',
] as const

export type AgenticFunnelEventSource =
  (typeof AGENTIC_FUNNEL_EVENT_SOURCES)[number]
