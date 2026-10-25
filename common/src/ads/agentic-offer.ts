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
 * is. Since revamp S10 a proposal may also carry its `preview`: the two
 * answers those routes would give, so the card draws and Accept is one POST
 * without a second read. The response objects are not `.strict()`, so the
 * server may add fields without a version bump and an older client simply
 * drops them.
 *
 * CUTOVER. There is no server knob: the Desktop release that sends
 * `agenticOfferRoute: 1` is the cutover. For such a client this endpoint
 * serves and `/api/ads` skips agentic discovery, wherever the channel's kill
 * switch (`FREEBUFF_AGENTIC_ADS`) admits the caller. Where it does not, this
 * endpoint answers `none/disabled` and `/api/ads` ignores the flag -- one
 * predicate on the server, so exactly one path serves. `FREEBUFF_AGENTIC_ADS=off`
 * therefore stops agentic on BOTH paths; there is no position that sends an
 * updated Desktop back to the old one.
 *
 * THE CLI (`Freebuff-CLI/` UA) is served here too, under the same
 * `FREEBUFF_AGENTIC_ADS` audience as Desktop; it has no switch of its own. A
 * CLI request must also carry `inPlaceExecutionVersion: 1` and report macOS
 * or Linux; a CLI request without the in-place flag, or from Windows, is
 * `ineligible_client`, so the CLI's old worktree flow is never served. The CLI reads offers from the `CLI-Chat-Inline` book,
 * mints rows with `surface: 'cli'`, and is never answered an invitation (it
 * cannot draw one). There is no `/api/ads` fallback for the CLI: it has never
 * been asked the agentic question there.
 */

import { z } from 'zod'

import {
  capabilityInspectionSchema,
  cloudWorktreeCapabilitySchema,
  sponsoredCapabilitySchema,
} from './sponsored-capability'
import { genericSetupInvitationSchema } from './generic-setup-invitation'
import { sponsoredEnvironmentWarningSchema } from './sponsored-environment-warning'
import { SPONSORED_IN_PLACE_VERSION } from './sponsored-in-place'
import { SPONSORED_RUN_SPEC_VERSION } from './sponsored-run-spec'
import {
  MAX_REPO_FACT_DEPENDENCY_NAMES,
  MAX_REPO_FACT_MANIFESTS,
  MAX_REPO_FACT_PATHS,
  type SponsoredRepoFacts,
} from './sponsored-skill-fit'

/** `offerPreviewVersion` on a request whose client draws the offer's preview. */
export const AGENTIC_OFFER_PREVIEW_VERSION = 1

/** `agenticOfferRoute` on an `/api/ads` request, and `v` on this route's wire. */
export const AGENTIC_OFFER_ROUTE_VERSION = 1

export const AGENTIC_OFFER_PATH = '/api/v1/ads/agentic/offer'

/**
 * The ad training log's record of one decision on this route (COD-738): the
 * `ad_provider_attempt.provider` of its decision row. The row's
 * `response_body` carries `proposal_id` and `campaign_id`, which is how a
 * sponsored run is joined back to the conversation the offer was decided on
 * (`@codebuff/bigquery/agentic-offer-context`). Shared by the producer and the
 * reader so the two cannot drift.
 */
export const AGENTIC_OFFER_TRAINING_LOG_PROVIDER = 'agentic_offer'

/**
 * Was a mirror of `localCapabilitySchema` in
 * `freebuff/web/src/app/api/ads/route.ts`, and DELIBERATELY IS NOT ANY MORE
 * in two fields: `repoFullName` accepts `''` here, and `workspaceId` exists
 * only here.
 *
 * Do not restore the symmetry by loosening the display route. `/api/ads`
 * serves every display request on every surface, and a validation rule
 * relaxed there is relaxed for all of them to buy something only an agentic
 * client needs. In-place clients ask on THIS route, which is where the
 * workspace keying belongs; the display route keeps its `.min(3)`.
 */
export const agenticOfferLocalCapabilitySchema = z
  .object({
    schemaVersion: z.literal(1),
    /**
     * `''` from an IN-PLACE client whose folder has no GitHub remote
     * (`sponsored-in-place.ts`); `owner/repo` otherwise. The eligibility
     * check refuses an empty value unless the request is in-place, so a
     * worktree client sending one is refused on `repo` exactly as before.
     */
    repoFullName: z.string().max(199),
    framework: z.enum(['nextjs', 'unsupported', 'unknown']),
    packageManager: z.enum(['bun', 'npm', 'pnpm', 'yarn', 'unknown']),
    hasSupabaseBoundary: z.boolean(),
    hasCommittedDatabaseBoundary: z.boolean(),
    hasGitRepository: z.boolean(),
    /**
     * The folder's durable opaque id (`.freebuff/project-id`), which keys an
     * in-place offer where `owner/repo` keys a worktree one. A path is never
     * sent.
     */
    workspaceId: z.string().uuid().optional(),
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

const repoFactPath = z
  .string()
  .min(1)
  .max(400)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'))

/**
 * The repository's fit facts (`sponsoredRepoFacts`, `sponsored-skill-fit.ts`):
 * fit-file paths and the manifests' dependency names, capped. The names are
 * used in memory to decide fit and NEVER logged, persisted or put in the
 * training log (Owen, 2026-10-14). Sent top-level, beside the strict
 * capabilities, so a server that predates it ignores it rather than 400ing.
 */
export const sponsoredRepoFactsSchema: z.ZodType<SponsoredRepoFacts> = z
  .object({
    v: z.literal(1),
    paths: z.array(repoFactPath).max(MAX_REPO_FACT_PATHS),
    complete: z.boolean(),
    absent: z.array(repoFactPath).max(16).optional(),
    manifests: z
      .array(
        z
          .object({
            path: repoFactPath,
            ecosystem: z.enum(['npm', 'pypi']),
            names: z
              .array(z.string().min(1).max(214))
              .max(MAX_REPO_FACT_DEPENDENCY_NAMES),
            complete: z.boolean(),
          })
          .strict(),
      )
      .max(MAX_REPO_FACT_MANIFESTS)
      .refine(
        (manifests) =>
          manifests.reduce((n, manifest) => n + manifest.names.length, 0) <=
          MAX_REPO_FACT_DEPENDENCY_NAMES,
      ),
    empty: z.array(repoFactPath).max(MAX_REPO_FACT_PATHS).optional(),
  })
  .strict()

/** A request's `repoFacts`, or null when absent or malformed (never a 400). */
export function parseAgenticOfferRepoFacts(
  value: unknown,
): SponsoredRepoFacts | null {
  const parsed = sponsoredRepoFactsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

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
  /**
   * The browser workspace's worktree facts (`web` client only). The route
   * reads it only from the workspace server, adds the server-assigned
   * `cloud_linux` execution itself, and ignores it from any other client.
   */
  cloudCapability: cloudWorktreeCapabilitySchema.optional(),
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
  /**
   * `TEST_AGENTIC_ADS_CAMPAIGN` from an isolated local Desktop
   * (`local-agentic-test.ts`). Honored only by a backend whose own
   * environment names the same campaign; never grants production authority.
   */
  localTestCampaignId: z.string().uuid().optional(),
  /** Registered staging only; the server verifies the signed-in tester role. */
  stagingTestCampaignId: z.string().uuid().optional(),
  /**
   * `1`: this client runs an accepted offer IN PLACE, in the accepting
   * conversation, with no worktree or commit (`sponsored-in-place.ts`). Such a
   * client needs no Git repository to be eligible, so this decides what may
   * be offered; absent is the worktree flow every released build runs.
   */
  inPlaceExecutionVersion: z.literal(SPONSORED_IN_PLACE_VERSION).optional(),
  /**
   * `1`: this client runs the run spec the Accept delivers
   * (`sponsored-run-spec.ts`): the server's prompt, skill and declared
   * packages, never its own. Such a client is not refused a skill for being
   * too old to resolve it (`sponsoredSkillClientRefusal`).
   */
  runSpecVersion: z.literal(SPONSORED_RUN_SPEC_VERSION).optional(),
  /**
   * `1`: this client draws a proposal's card from the offer's `preview` and
   * Accepts with one POST (S10). Only then does the server build the
   * preview: it costs two reads per proposal, which a client that reads the
   * proposal routes itself would pay twice. Absent is every released build.
   */
  offerPreviewVersion: z.literal(AGENTIC_OFFER_PREVIEW_VERSION).optional(),
  /**
   * `SPONSORED_CONVERSION_TOOLS_VERSION`: this client has the sponsored
   * conversion tools (`sponsored-conversion.ts`), so a skill with a
   * conversion definition may be offered to it. Unknown here and read with
   * `clientHasSponsoredConversionTools`, so a malformed value reads as absent
   * instead of failing the request.
   */
  conversionToolsVersion: z.unknown().optional(),
  /**
   * Pointer ids to the conversation's trace, never its text
   * (`trace-context.ts`). Unknown here and read with `parseAdTraceContext`, so
   * a malformed value is dropped instead of failing the request.
   */
  traceContext: z.unknown().optional(),
  /**
   * The conversation's project (`local:<sha256 prefix>`), or null for a chat
   * with no folder: agentic relevance reads that project's understanding
   * profile. Unknown here and read with `parseAdRequestProjectKey`, so a
   * malformed value is dropped instead of failing the request.
   */
  projectKey: z.unknown().optional(),
  /**
   * The repository's fit facts (`sponsoredRepoFactsSchema`). Unknown here and
   * read with `parseAgenticOfferRepoFacts`, so a malformed value is dropped
   * instead of failing the request.
   */
  repoFacts: z.unknown().optional(),
})

export type AgenticOfferRequest = z.infer<typeof agenticOfferRequestSchema>

/** Why nothing was offered. Closed, so a dashboard can group by it. */
export const AGENTIC_OFFER_NONE_REASONS = [
  /**
   * `FREEBUFF_AGENTIC_ADS` does not admit this caller; `/api/ads` asks their
   * agentic question as before.
   */
  'disabled',
  /**
   * Not a bearer, product UA or OS pairing this route serves: a Desktop, or a
   * CLI that sends `inPlaceExecutionVersion: 1` and reports macOS or Linux.
   */
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
  /**
   * Matched, but the pool declined: cap, no fill, mint rules, not offered.
   * Also the user-wide pre-check before relevance: the user opted out, or
   * already has a live proposal on this target, so nothing could be minted.
   */
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

/**
 * A proposal's card and Accept preview, carried on the offer (agentic ads
 * revamp S10, E3). Each part is EXACTLY the body a read would answer, so a
 * client handles it as it handles that read:
 *
 * - `proposal`: `GET /api/v1/ads/proposal`'s `proposal` (the card row, with
 *   its `offer_plan`);
 * - `accept`: `GET /api/v1/ads/proposal/{id}/accept`'s 200 body (the
 *   procedure the Accept binds, its SHA-256, the acceptance criteria and the
 *   skill), the same checks having passed.
 *
 * Advisory, never authority: every click-time check stays in the Accept POST,
 * which answers 409 `procedure_changed` (with the new `preview`) when the
 * procedure moved. Sent only to a request with `offerPreviewVersion: 1`, and
 * absent whenever either read would not answer 200 for this proposal or did
 * not answer in time; the client then reads as before.
 */
export const agenticOfferPreviewSchema = z.object({
  proposal: z.object({ _id: z.string().min(1) }).loose(),
  accept: z
    .object({
      proposalId: z.string().min(1),
      procedure: z.string().min(1),
      procedureSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .loose(),
})

export type AgenticOfferPreview = z.infer<typeof agenticOfferPreviewSchema>

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
    /**
     * Read it through `GET /api/v1/ads/proposal` like every other proposal,
     * unless `preview` already carries that answer.
     */
    proposalId: z.string().min(1),
    campaignId: z.string().min(1),
    /**
     * "May not work on your machine" (COD-829): shown on the card, never a
     * reason to withhold Accept. Absent when the machine matches or is unknown.
     */
    environmentWarning: sponsoredEnvironmentWarningSchema.optional(),
    /**
     * The card and Accept preview (S10, `agenticOfferPreviewSchema`). A
     * malformed one is dropped, never a reason to refuse the offer.
     */
    preview: agenticOfferPreviewSchema.optional().catch(undefined),
  }),
])

export const agenticOfferResponseSchema = z.union([
  agenticOfferNoneSchema,
  agenticOfferMadeSchema,
])

export type AgenticOfferResponse = z.infer<typeof agenticOfferResponseSchema>
