import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '../constants/freebuff-model-ids'

import type {
  SponsoredExecutionSurface,
  SponsoredLocalTarget,
} from './sponsored-capability'
import type {
  SPONSORED_WINDOWS_EXECUTION_SURFACE,
  SponsoredExecutionContainment,
} from './sponsored-windows'

/**
 * The funded Accept request, `POST /api/v1/ads/proposal/{id}/accept`, as the
 * accepting surface sends it and the route reads it.
 */
export type SponsoredAcceptRequest = {
  /** Which kind of client accepts: `desktop` or `cli`. */
  surface: 'desktop' | 'cli'
  /** The run id the surface minted before consent. */
  runId: string
  /** The hash of the exact procedure the user consented to. */
  procedureSha256: string
  target?: SponsoredLocalTarget
  /**
   * The ACCEPTING CLIENT's own execution surface (COD-642): `desktop_windows`
   * from Windows Desktop, `desktop_macos` / `desktop_linux` otherwise. The
   * row's `execution_surface` says which machine the offer was minted for;
   * this says which machine is about to run it, so the two can be paired and
   * a client is never charged for a run it cannot execute (a Windows client
   * accepting a `desktop_macos` row, or the reverse). Optional on the wire
   * because an older client does not send it.
   */
  clientExecutionSurface?: SponsoredExecutionSurface
}

/**
 * The same fact on the read-only preview (`GET .../accept`), which has no
 * body: a query parameter named like the body field.
 */
export const SPONSORED_ACCEPT_EXECUTION_SURFACE_PARAM =
  'clientExecutionSurface' as const satisfies keyof SponsoredAcceptRequest

/**
 * Whether a client on `clientSurface` may accept a row minted for
 * `rowSurface`. A row with no recorded surface (older rows, Cloud) is not a
 * mismatch; a recorded one must be exactly the client's own.
 */
export function sponsoredAcceptSurfaceMatchesRow(
  clientSurface: string | null | undefined,
  rowSurface: string | null | undefined,
): boolean {
  if (rowSurface === undefined || rowSurface === null) return true
  return clientSurface === rowSurface
}

/** Public response shape. The bearer belongs in host memory, never a thread. */
export type SponsoredComputeGrant = Readonly<{
  token: string
  proposalId: string
  runId: string
  procedureSha256: string
  modelId: string
  expiresAtMs: number
  allowanceUsdMicros: number
  /**
   * Present ONLY on a grant for a Windows offer (COD-642), and then both are:
   * the surface the server granted and the containment that applies — the
   * floor, not an OS sandbox. A client selects its floor-only broker only
   * when it runs on Windows AND this grant names `desktop_windows`; never as
   * a fallback. Absent means the client's own OS sandbox (macOS/Linux).
   */
  executionSurface?: typeof SPONSORED_WINDOWS_EXECUTION_SURFACE
  containment?: SponsoredExecutionContainment
}>

/**
 * Which campaigns the sponsored runtime may execute. `all` admits every
 * campaign; each consumer still requires the campaign's own reviewed procedure,
 * so approval is what makes a campaign runnable. `listed` is the scalpel.
 */
export type SponsoredComputeCampaigns =
  | Readonly<{ kind: 'all' }>
  | Readonly<{ kind: 'listed'; ids: readonly string[] }>

export type SponsoredComputePolicy = Readonly<{
  modelId: string
  campaigns: SponsoredComputeCampaigns
  allowanceUsdMicros: number
  acceptancePriceCents: number
  ttlMs: number
}>

export type SponsoredComputePolicyEnv = {
  FREEBUFF_SPONSORED_COMPUTE_ENABLED?: string
  FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS?: string
  FREEBUFF_SPONSORED_COMPUTE_MODEL_ID?: string
  FREEBUFF_SPONSORED_COMPUTE_ACCEPTANCE_PRICE_CENTS?: string
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Absent preserves the existing paid contract; malformed prices close admission. */
export function sponsoredComputeAcceptancePriceCents(
  raw?: string,
): number | null {
  if (raw === undefined) return 200
  if (!/^[1-9][0-9]*$/.test(raw)) return null
  const cents = Number(raw)
  return Number.isSafeInteger(cents) ? cents : null
}

/** The value of `FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS` that admits every campaign. */
export const SPONSORED_COMPUTE_ALL_CAMPAIGNS = '*'

function parseSponsoredComputeCampaigns(
  raw: string | undefined,
): SponsoredComputeCampaigns | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  // Only the whole value. `*,<uuid>` is a typo, and a typo must close
  // admission rather than widen it.
  if (trimmed === SPONSORED_COMPUTE_ALL_CAMPAIGNS) {
    return Object.freeze({ kind: 'all' })
  }
  const ids = trimmed.split(',').map((id) => id.trim())
  if (ids.length > 100 || ids.some((id) => !UUID.test(id))) return null
  return Object.freeze({
    kind: 'listed',
    ids: Object.freeze([...new Set(ids)]),
  })
}

/** Whether the sponsored runtime may execute this campaign's reviewed procedure. */
export function sponsoredComputeAdmitsCampaign(
  policy: Pick<SponsoredComputePolicy, 'campaigns'>,
  campaignId: string,
): boolean {
  return policy.campaigns.kind === 'all'
    ? UUID.test(campaignId)
    : policy.campaigns.ids.includes(campaignId)
}

/** Server configuration only. An absent or incomplete policy admits nothing. */
export function readSponsoredComputePolicy(
  env: SponsoredComputePolicyEnv,
): SponsoredComputePolicy | null {
  if (env.FREEBUFF_SPONSORED_COMPUTE_ENABLED !== 'true') return null
  const acceptancePriceCents = sponsoredComputeAcceptancePriceCents(
    env.FREEBUFF_SPONSORED_COMPUTE_ACCEPTANCE_PRICE_CENTS,
  )
  const modelId = env.FREEBUFF_SPONSORED_COMPUTE_MODEL_ID?.trim()
  const campaigns = parseSponsoredComputeCampaigns(
    env.FREEBUFF_SPONSORED_COMPUTE_CAMPAIGN_IDS,
  )
  if (
    acceptancePriceCents === null ||
    !modelId ||
    modelId !== FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID ||
    modelId.length > 128 ||
    !/^[a-zA-Z0-9._:/-]+$/.test(modelId) ||
    !campaigns
  )
    return null
  return Object.freeze({
    modelId,
    campaigns,
    // The configured acceptance fee is the only commercial charge. Compute is an
    // internal, bounded cost of fulfilling that offer, capped here at $0.50.
    allowanceUsdMicros: 500_000,
    acceptancePriceCents,
    ttlMs: 60 * 60_000,
  })
}
