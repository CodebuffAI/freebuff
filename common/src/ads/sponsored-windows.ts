/**
 * Windows Desktop serving for GENERIC agentic campaigns (COD-642).
 *
 * Windows has no OS sandbox under a sponsored run. Its protection is human
 * review of each campaign's procedure (against intent) plus the portable floor
 * (against accidents): scrubbed environment, redirected profile directories,
 * non-interactive git with hooks disabled, and cwd bound to the worktree.
 * `docs/freebuff-sponsored-local-execution.md` records the decision (Owen,
 * 2026-09-23) and the risk it accepts.
 *
 * Because review is per campaign, serving is gated twice and both gates are
 * read here, so every consumer (Next serving, the funded Accept route, the
 * Convex reservation and Accept contracts) applies the same rule:
 *
 *   - `FREEBUFF_SPONSORED_WINDOWS` — `on` or not. Only the exact value `on`
 *     opens; unset, `off`, a typo or any other value is closed.
 *   - `FREEBUFF_SPONSORED_WINDOWS_CAMPAIGN_IDS` — a comma-separated list of
 *     campaign UUIDs whose procedure was reviewed for Windows. There is no
 *     `*`: a wildcard would skip exactly the review the list records. One
 *     malformed entry closes the whole list rather than dropping that entry.
 *
 * Either gate closed means NO Windows offer, invitation or roster class, and
 * no fresh Windows Accept. The Supabase format never serves Windows whatever
 * these say.
 */

import { SUPABASE_FORMAT_DATABASE_PAIR } from './supabase-format-experiment'

import type { SponsoredExecutionSurface } from './sponsored-capability'

export type SponsoredWindowsEnv = {
  FREEBUFF_SPONSORED_WINDOWS?: string
  FREEBUFF_SPONSORED_WINDOWS_CAMPAIGN_IDS?: string
}

/** Non-null only when the switch is `on` AND at least one campaign opted in. */
export type SponsoredWindowsPolicy = Readonly<{
  campaignIds: ReadonlySet<string>
}>

/** The execution surface a Windows Desktop client reports and is granted. */
export const SPONSORED_WINDOWS_EXECUTION_SURFACE =
  'desktop_windows' as const satisfies SponsoredExecutionSurface

/**
 * What stands between a Windows run and the user's machine: the floor, not a
 * sandbox. Recorded on the compute grant, the acceptance record, the funnel
 * rows and the serving logs so analytics can separate floor-contained runs
 * from sandboxed ones. macOS/Linux rows omit it (their containment is the OS
 * sandbox the client proved before reporting a capability).
 */
export const SPONSORED_WINDOWS_CONTAINMENT = 'floor' as const
export type SponsoredExecutionContainment = typeof SPONSORED_WINDOWS_CONTAINMENT

const MAX_WINDOWS_CAMPAIGNS = 100

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function parseCampaignIds(raw: string | undefined): ReadonlySet<string> | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  const ids = trimmed.split(',').map((id) => id.trim())
  // `*`, an empty entry (`a,,b`, a trailing comma) or any non-UUID closes the
  // list: a typo must close Windows serving, never widen it.
  if (ids.length > MAX_WINDOWS_CAMPAIGNS || ids.some((id) => !UUID.test(id)))
    return null
  return Object.freeze(new Set(ids.map((id) => id.toLowerCase())))
}

/**
 * Supabase stays macOS/Linux (COD-642 scope boundary), and since COD-649 its
 * agentic campaign can be an ORDINARY generic candidate under
 * `FREEBUFF_AGENTIC_ONE_FUNNEL=on` -- so list membership alone would let an
 * operator who opted a Supabase id in serve, reserve and accept it on
 * Windows. The fixed database pair is refused here, by name, on every
 * runtime; the env-configured pairs (Auth) are passed in by each side, which
 * is the only place that can read them.
 */
const SUPABASE_FIXED_CAMPAIGN_IDS: ReadonlySet<string> = new Set(
  [
    SUPABASE_FORMAT_DATABASE_PAIR.displayCampaignId,
    SUPABASE_FORMAT_DATABASE_PAIR.agenticCampaignId,
  ].map((id) => id.toLowerCase()),
)

/** Server configuration only. Absent, off, garbage or an empty list admits nothing. */
export function readSponsoredWindowsPolicy(
  env: SponsoredWindowsEnv,
  options: { excludedCampaignIds?: Iterable<string> } = {},
): SponsoredWindowsPolicy | null {
  if (env.FREEBUFF_SPONSORED_WINDOWS?.trim() !== 'on') return null
  const campaignIds = parseCampaignIds(
    env.FREEBUFF_SPONSORED_WINDOWS_CAMPAIGN_IDS,
  )
  if (!campaignIds) return null
  const excluded = new Set(SUPABASE_FIXED_CAMPAIGN_IDS)
  for (const id of options.excludedCampaignIds ?? [])
    excluded.add(id.toLowerCase())
  // A Supabase id on the list is DROPPED, not fatal: it narrows what Windows
  // serves, which is the safe direction for an operator's mistake.
  const admitted = [...campaignIds].filter((id) => !excluded.has(id))
  if (admitted.length === 0) return null
  return Object.freeze({ campaignIds: Object.freeze(new Set(admitted)) })
}

/** Whether this campaign may be offered, invited or accepted on Windows. */
export function sponsoredWindowsAdmitsCampaign(
  policy: SponsoredWindowsPolicy | null | undefined,
  campaignId: string | null | undefined,
): boolean {
  return Boolean(
    policy &&
    campaignId &&
    UUID.test(campaignId) &&
    !SUPABASE_FIXED_CAMPAIGN_IDS.has(campaignId.toLowerCase()) &&
    policy.campaignIds.has(campaignId.toLowerCase()),
  )
}

/** The containment a run on this execution surface gets, when it is not an OS sandbox. */
export function sponsoredExecutionContainment(
  surface: string | null | undefined,
): SponsoredExecutionContainment | null {
  return surface === SPONSORED_WINDOWS_EXECUTION_SURFACE
    ? SPONSORED_WINDOWS_CONTAINMENT
    : null
}

/**
 * The OS pairing every serving gate applies: a reported OS may only claim its
 * own Desktop surface. Windows claiming a macOS/Linux surface, or the reverse,
 * is refused. `windows` says whether THIS consumer serves Windows at all — the
 * Supabase paths pass `false`, the generic paths pass whether the Windows
 * policy admits the campaign in question.
 */
export function sponsoredDesktopSurfaceMatchesOs(
  surface: string | null | undefined,
  reportedOs: string | null | undefined,
  options: { windows: boolean },
): boolean {
  return (
    (reportedOs === 'macos' && surface === 'desktop_macos') ||
    (reportedOs === 'linux' && surface === 'desktop_linux') ||
    (options.windows &&
      reportedOs === 'windows' &&
      surface === SPONSORED_WINDOWS_EXECUTION_SURFACE)
  )
}
