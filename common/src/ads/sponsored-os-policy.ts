/**
 * Per-OS rollout switches for PAID agentic serving on Desktop.
 *
 * macOS has served paid generic offers since COD-568 with no switch of its
 * own. Every other Desktop OS reaches the same paid path only behind ONE
 * switch per OS, with exactly the same rules as macOS once it is on (Owen,
 * 2026-09-24: every agentic campaign follows the same rules on every OS, with
 * no special paths and no per-campaign lists):
 *
 * - Windows (COD-642): `FREEBUFF_SPONSORED_WINDOWS`, surface `desktop_windows`,
 *   contained by the portable floor (`./sponsored-windows`).
 * - Linux (COD-655): `FREEBUFF_SPONSORED_LINUX`, surface `desktop_linux`,
 *   contained by bubblewrap — a missing `bwrap` makes the client report no
 *   execution capability, so it is never offered a paid task.
 *
 * One table, one reader, one capability predicate, so every consumer (Next
 * serving, the funded Accept route, the Convex reservation and Accept
 * contracts) applies the same rule to every switched OS. Only the EXACT value
 * `on` opens a switch. Unset, `off`, `ON`, ` on `, a typo: closed. A present
 * value that is neither `on` nor `off` is reported through `onUnrecognised`
 * so an operator's typo does not look like a working switch.
 */

import type { SponsoredExecutionSurface } from './sponsored-capability'

/** Each switched Desktop OS: the env knob that opens it and the surface it runs on. */
export const SPONSORED_OS_SWITCHES = {
  windows: {
    env: 'FREEBUFF_SPONSORED_WINDOWS',
    surface: 'desktop_windows',
  },
  linux: {
    env: 'FREEBUFF_SPONSORED_LINUX',
    surface: 'desktop_linux',
  },
} as const satisfies Record<
  string,
  { env: `FREEBUFF_SPONSORED_${string}`; surface: SponsoredExecutionSurface }
>

/** A Desktop OS whose paid agentic serving sits behind its own switch. */
export type SponsoredSwitchedOs = keyof typeof SPONSORED_OS_SWITCHES
export type SponsoredSwitchedOsSurface =
  (typeof SPONSORED_OS_SWITCHES)[SponsoredSwitchedOs]['surface']

/** The env vars the switches are read from. */
export type SponsoredOsSwitchEnv = {
  [Os in SponsoredSwitchedOs as (typeof SPONSORED_OS_SWITCHES)[Os]['env']]?: string
}

/**
 * Non-null only when an OS's switch is exactly `on`. Carries no campaign list:
 * with the switch on, that OS serves every agentic campaign. Kept as a value
 * rather than a boolean so a caller cannot confuse "the switch" with "this
 * request is on that OS".
 */
export type SponsoredOsPolicy = Readonly<{ switch: 'on' }>

/** The only policy there is: the switch, on. */
export const SPONSORED_OS_ON: SponsoredOsPolicy = Object.freeze({
  switch: 'on',
})

/**
 * How a raw switch value reads. `off` is unset, empty, or exactly `off`; `on`
 * is exactly `on`; anything else (`ON`, ` on `, `true`, a typo) is
 * `unrecognised`, which is CLOSED and worth a log line.
 */
export function sponsoredOsSwitchState(
  raw: string | undefined,
): 'on' | 'off' | 'unrecognised' {
  if (raw === undefined || raw === '' || raw === 'off') return 'off'
  return raw === 'on' ? 'on' : 'unrecognised'
}

/** Server configuration only. Anything but the exact value `on` admits nothing. */
export function readSponsoredOsPolicy(
  os: SponsoredSwitchedOs,
  env: SponsoredOsSwitchEnv,
  options: { onUnrecognised?: (value: string) => void } = {},
): SponsoredOsPolicy | null {
  const raw = env[SPONSORED_OS_SWITCHES[os].env]
  const state = sponsoredOsSwitchState(raw)
  if (state === 'unrecognised' && raw !== undefined)
    options.onUnrecognised?.(raw)
  return state === 'on' ? SPONSORED_OS_ON : null
}

/**
 * A reporter for `onUnrecognised` that says so ONCE per value per interval
 * (default ten minutes) instead of on every request. Each runtime owns one
 * per switch (module scope), and passes its own logger. The value is bounded
 * and JSON-quoted before it reaches the log, so whitespace is visible.
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

/** The switched OS a request reports, or null for macOS, unknown and absent. */
export function sponsoredSwitchedOs(
  reportedOs: string | null | undefined,
): SponsoredSwitchedOs | null {
  return reportedOs === 'windows' || reportedOs === 'linux' ? reportedOs : null
}

/** The switched OS a row's execution surface belongs to, or null (macOS, CLI, unrecorded). */
export function sponsoredSwitchedOsForSurface(
  surface: string | null | undefined,
): SponsoredSwitchedOs | null {
  if (surface === SPONSORED_OS_SWITCHES.windows.surface) return 'windows'
  if (surface === SPONSORED_OS_SWITCHES.linux.surface) return 'linux'
  return null
}

/**
 * Whether a request carries the proof that its client can RUN a paid
 * sponsored procedure on this OS: a v2 `sponsoredCapability` that names the
 * OS's own Desktop surface and reports execution `available` with no reason.
 * On Linux that is only reported when bubblewrap is present; on Windows it is
 * only sent by builds that carry the floor.
 */
export function sponsoredOsExecutionCapable(
  os: SponsoredSwitchedOs,
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
    capability?.execution.surface === SPONSORED_OS_SWITCHES[os].surface &&
    capability.execution.status === 'available' &&
    capability.execution.reason === undefined
  )
}
