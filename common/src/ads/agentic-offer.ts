/**
 * THE AGENTIC OFFER ROUTE's wire contract (COD-665), shared by Freebuff
 * Desktop and `POST /api/v1/ads/agentic/offer` on freebuff-web.
 *
 * The agentic pool (COD-662, `agentic-pool.ts`) gave agentic cards a
 * placement of their own, but still decided them INSIDE the display request:
 * the display chain waited on the roster, the identity check and generic
 * selection, and a card could only be discovered when a display-ad threshold
 * fired mid-stream. This route asks the agentic question on its own request,
 * once per user turn, and the display request stops asking it.
 *
 * Deliberately thin: the response names WHAT was offered, never how it is
 * drawn. The card UX is being reworked, and the rework must not need a
 * contract change -- an invitation carries the existing invitation payload,
 * and a proposal is read from the proposal routes as every proposal already
 * is. The response objects are not `.strict()`, so the server may add fields
 * without a version bump and an older client simply drops them.
 *
 * CUTOVER. There is no server knob: the Desktop release that sends
 * `agenticOfferRoute: 1` is the cutover. For such a client this endpoint
 * serves and `/api/ads` skips agentic discovery, wherever the channel's kill
 * switch (`FREEBUFF_AGENTIC_ADS`) admits the caller. Where it does not, this
 * endpoint answers `none/disabled` and `/api/ads` ignores the flag -- one
 * predicate on the server, so exactly one path serves. `FREEBUFF_AGENTIC_ADS=off`
 * therefore stops agentic on BOTH paths; there is no position that sends an
 * updated Desktop back to the old one.
 */

import { z } from 'zod'

import {
  capabilityInspectionSchema,
  sponsoredCapabilitySchema,
} from './sponsored-capability'
import { genericSetupInvitationSchema } from './generic-setup-invitation'

/** `agenticOfferRoute` on an `/api/ads` request, and `v` on this route's wire. */
export const AGENTIC_OFFER_ROUTE_VERSION = 1

export const AGENTIC_OFFER_PATH = '/api/v1/ads/agentic/offer'

/** Mirrors `localCapabilitySchema` in `freebuff/web/src/app/api/ads/route.ts`. */
export const agenticOfferLocalCapabilitySchema = z
  .object({
    schemaVersion: z.literal(1),
    repoFullName: z.string().min(3).max(199),
    framework: z.enum(['nextjs', 'unsupported', 'unknown']),
    packageManager: z.enum(['bun', 'npm', 'pnpm', 'yarn', 'unknown']),
    hasSupabaseBoundary: z.boolean(),
    hasCommittedDatabaseBoundary: z.boolean(),
    hasGitRepository: z.boolean(),
  })
  .strict()

/** Mirrors `desktopDeviceSchema` in `freebuff/web/src/app/api/ads/route.ts`. */
export const agenticOfferDeviceSchema = z
  .object({
    os: z.enum(['macos', 'windows', 'linux']),
    timezone: z.string().max(100).optional(),
    locale: z.string().max(100).optional(),
  })
  .strict()

export const agenticOfferRequestSchema = z.object({
  v: z.literal(AGENTIC_OFFER_ROUTE_VERSION),
  /** The Desktop thread id -- the same value `/api/ads` receives as `sessionId`. */
  conversationId: z.string().min(1).max(200),
  /** The most recent turns, oldest first, as `{ role, content }`. */
  messages: z
    .array(z.object({ role: z.string().max(40), content: z.string() }))
    .max(20),
  localCapability: agenticOfferLocalCapabilitySchema.optional(),
  sponsoredCapability: sponsoredCapabilitySchema.optional(),
  capabilityInspection: capabilityInspectionSchema.optional(),
  /** Setup-only capability; parsed server-side exactly as `/api/ads` does. */
  invitationCapability: z.unknown().optional(),
  invitationCapabilityInspection: z.unknown().optional(),
  /** `1`: the client can draw an invitation on ready-project discovery. */
  invitationReadyDiscoveryVersion: z.literal(1).optional(),
  device: agenticOfferDeviceSchema.optional(),
  /**
   * A recheck of an invitation already shown ("Check compatibility"). Binds
   * selection to that campaign; everything else is re-evaluated.
   */
  recheck: z
    .object({
      invitationId: z.string().uuid(),
      campaignId: z.string().min(1).max(128),
    })
    .strict()
    .optional(),
})

export type AgenticOfferRequest = z.infer<typeof agenticOfferRequestSchema>

/** Why nothing was offered. Closed, so a dashboard can group by it. */
export const AGENTIC_OFFER_NONE_REASONS = [
  /**
   * `FREEBUFF_AGENTIC_ADS` does not admit this caller (`off`, or a `god`/`beta`
   * audience without them); `/api/ads` asks their agentic question as before.
   */
  'disabled',
  /** Not a Desktop bearer, product UA or OS pairing this route serves. */
  'ineligible_client',
  /**
   * No price tier for this request's geo. Named for its original meaning
   * (outside Tier 1); since COD-665 (2026-09-25) Tier 2 is served at $1, so
   * this now answers only an UNRESOLVED country. Kept, not renamed: the enum
   * is closed and dashboards group by it.
   */
  'not_tier1',
  /** Classification ran and nothing matched or was invitable. */
  'no_match',
  /** Matched, but the pool declined: cap, no fill, mint rules, not offered. */
  'suppressed',
  'deadline',
  'error',
] as const

export type AgenticOfferNoneReason = (typeof AGENTIC_OFFER_NONE_REASONS)[number]

const agenticOfferNoneSchema = z.object({
  v: z.literal(AGENTIC_OFFER_ROUTE_VERSION),
  decision: z.literal('none'),
  reason: z.enum(AGENTIC_OFFER_NONE_REASONS),
})

const agenticOfferMadeSchema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(AGENTIC_OFFER_ROUTE_VERSION),
    decision: z.literal('offer'),
    kind: z.literal('invitation'),
    invitation: genericSetupInvitationSchema,
  }),
  z.object({
    v: z.literal(AGENTIC_OFFER_ROUTE_VERSION),
    decision: z.literal('offer'),
    kind: z.literal('proposal'),
    /** Read it through `GET /api/v1/ads/proposal` like every other proposal. */
    proposalId: z.string().min(1),
    campaignId: z.string().min(1),
  }),
])

export const agenticOfferResponseSchema = z.union([
  agenticOfferNoneSchema,
  agenticOfferMadeSchema,
])

export type AgenticOfferResponse = z.infer<typeof agenticOfferResponseSchema>
