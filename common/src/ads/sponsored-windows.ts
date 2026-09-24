/**
 * Windows Desktop serving for agentic campaigns (COD-642).
 *
 * Windows has no OS sandbox under a sponsored run. Its protection is human
 * review of each campaign's procedure (against intent) plus the portable floor
 * (against accidents): scrubbed environment, redirected profile directories,
 * non-interactive git with hooks disabled, and cwd bound to the worktree.
 * `docs/freebuff-sponsored-local-execution.md` records the decision (Owen,
 * 2026-09-23) and the risk it accepts.
 *
 * ONE SWITCH, NO PER-CAMPAIGN LIST (Owen, 2026-09-24). With
 * `FREEBUFF_SPONSORED_WINDOWS=on`, EVERY agentic campaign that can serve on
 * macOS can serve on Windows, under exactly the same rules as every other
 * campaign — review, funding, servability, the classifier, the roster.
 * Campaign review already happens once per campaign; a second, Windows-only
 * list of reviewed ids was a second place to forget one. Supabase included:
 * under `FREEBUFF_AGENTIC_ONE_FUNNEL=on` it is an ordinary generic candidate
 * and reaches Windows like everyone else.
 *
 * The switch is read here, so every consumer (Next serving, the funded Accept
 * route, the Convex reservation and Accept contracts) applies the same rule.
 * Only the EXACT value `on` opens it. Unset, `off`, `ON`, ` on `, a typo:
 * closed. A present value that is neither `on` nor `off` is reported through
 * `onUnrecognised` so an operator's typo does not look like a working switch.
 */

import type { SponsoredExecutionSurface } from './sponsored-capability'

export type SponsoredWindowsEnv = {
  FREEBUFF_SPONSORED_WINDOWS?: string
}

/**
 * Non-null only when the switch is exactly `on`. Carries no campaign list:
 * with the switch on, Windows serves every agentic campaign (COD-642,
 * 2026-09-24). Kept as a value rather than a boolean so a caller cannot
 * confuse "the switch" with "this request is Windows".
 */
export type SponsoredWindowsPolicy = Readonly<{ switch: 'on' }>

/** The only policy there is: the switch, on. */
export const SPONSORED_WINDOWS_ON: SponsoredWindowsPolicy = Object.freeze({
  switch: 'on',
})

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

/**
 * How the raw switch value reads. `off` is unset, empty, or exactly `off`;
 * `on` is exactly `on`; anything else (`ON`, ` on `, `true`, a typo) is
 * `unrecognised`, which is CLOSED and worth a log line.
 */
export function sponsoredWindowsSwitchState(
  raw: string | undefined,
): 'on' | 'off' | 'unrecognised' {
  if (raw === undefined || raw === '' || raw === 'off') return 'off'
  return raw === 'on' ? 'on' : 'unrecognised'
}

/** Server configuration only. Anything but the exact value `on` admits nothing. */
export function readSponsoredWindowsPolicy(
  env: SponsoredWindowsEnv,
  options: { onUnrecognised?: (value: string) => void } = {},
): SponsoredWindowsPolicy | null {
  const raw = env.FREEBUFF_SPONSORED_WINDOWS
  const state = sponsoredWindowsSwitchState(raw)
  if (state === 'unrecognised' && raw !== undefined)
    options.onUnrecognised?.(raw)
  return state === 'on' ? SPONSORED_WINDOWS_ON : null
}

/**
 * A reporter for `onUnrecognised` that says so ONCE per value per interval
 * (default ten minutes) instead of on every request. Each runtime owns one
 * (module scope), and passes its own logger. The value is bounded and
 * JSON-quoted before it reaches the log, so whitespace is visible.
 */
export function throttledUnrecognisedSwitchReporter(
  report: (quotedValue: string) => void,
  options: { intervalMs?: number; now?: () => number } = {},
): (value: string) => void {
  const intervalMs = options.intervalMs ?? 10 * 60_000
  const now = options.now ?? Date.now
  let last: { value: string; at: number } | null = null
  return (value) => {
    const at = now()
    if (last && last.value === value && at - last.at < intervalMs) return
    last = { value, at }
    report(JSON.stringify(value.slice(0, 32)))
  }
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
 * The `accepted` funnel row's metadata for a floor-contained run, or null for
 * every other run (whose row keeps its exact pre-COD-642 shape). ONE builder
 * for both producers of that row — the funded Accept route and the settle
 * endpoint Convex calls — because the row is insert-once per
 * (campaign, `accept_<proposalId>`) and whichever producer wins the race is
 * the row analytics reads. Keyed on the acceptance record's `containment`,
 * the immutable fact, never on a surface re-derived later.
 */
export function sponsoredContainmentFunnelMetadata(
  containment: string | null | undefined,
): {
  execution_surface: typeof SPONSORED_WINDOWS_EXECUTION_SURFACE
  containment: SponsoredExecutionContainment
} | null {
  return containment === SPONSORED_WINDOWS_CONTAINMENT
    ? {
        execution_surface: SPONSORED_WINDOWS_EXECUTION_SURFACE,
        containment: SPONSORED_WINDOWS_CONTAINMENT,
      }
    : null
}

/**
 * The OS pairing every serving gate applies: a reported OS may only claim its
 * own Desktop surface. Windows claiming a macOS/Linux surface, or the reverse,
 * is refused. `windows` says whether THIS consumer serves Windows at all — the
 * legacy Supabase paths pass `false`, the generic paths pass whether the
 * Windows switch is on.
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

/**
 * Whether a Windows request carries the proof that its client can RUN a paid
 * sponsored procedure (COD-642 review, finding 1): a v2 `sponsoredCapability`
 * that names `desktop_windows` and reports execution `available`. Released
 * Windows builds send only `device.os`, the UA and `localCapability`, so
 * without this a paid offer would reach a client whose Accept can only fail.
 */
export function sponsoredWindowsExecutionCapable(
  capability:
    | {
        execution: {
          surface: string
          status: string
          reason?: string | undefined
        }
      }
    | null
    | undefined,
): boolean {
  return (
    capability?.execution.surface === SPONSORED_WINDOWS_EXECUTION_SURFACE &&
    capability.execution.status === 'available' &&
    capability.execution.reason === undefined
  )
}
