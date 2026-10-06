/**
 * The sponsored execution surfaces and the helpers that read them, without
 * zod. `./sponsored-capability` re-exports all of it beside the wire schemas.
 *
 * Kept zod-free because Convex evaluates a function module's whole import
 * graph on every call, and `ads/proposals:activeProposal` (the deployment's
 * highest-volume query) needs only these lists, never a schema. A test in
 * `freebuff/web/convex/ads/__tests__/` fails if zod re-enters that bundle.
 */

/**
 * Where a local sponsored run executes. `desktop_windows` (COD-642) runs on
 * the portable floor (`SPONSORED_WINDOWS_CONTAINMENT` in
 * `./sponsored-windows`). A Windows value on the wire admits nothing by
 * itself — the server serves it only behind its server-side switch, every
 * agentic campaign alike when on.
 */
export const SPONSORED_EXECUTION_SURFACES = [
  'desktop_macos',
  'desktop_linux',
  'desktop_windows',
  'cli_macos',
  'cli_linux',
  'cli_wsl',
] as const
export type SponsoredExecutionSurface =
  (typeof SPONSORED_EXECUTION_SURFACES)[number]

/**
 * Whether a value is one of {@link SPONSORED_EXECUTION_SURFACES}: exactly
 * what `sponsoredExecutionSurfaceSchema.safeParse(value).success` answers.
 */
export function isSponsoredExecutionSurface(
  value: unknown,
): value is SponsoredExecutionSurface {
  return (SPONSORED_EXECUTION_SURFACES as readonly unknown[]).includes(value)
}

/** The Desktop execution surfaces, one per OS a Desktop client reports. */
export const SPONSORED_DESKTOP_EXECUTION_SURFACES = [
  'desktop_macos',
  'desktop_linux',
  'desktop_windows',
] as const satisfies readonly SponsoredExecutionSurface[]
export type SponsoredDesktopExecutionSurface =
  (typeof SPONSORED_DESKTOP_EXECUTION_SURFACES)[number]

/**
 * The CLI execution surfaces. macOS runs under the Seatbelt sandbox, Linux and
 * WSL under bubblewrap; the CLI never runs sponsored work on native Windows
 * (its capability reports `windows_no_containment`), so there is no
 * `cli_windows`.
 */
export const SPONSORED_CLI_EXECUTION_SURFACES = [
  'cli_macos',
  'cli_linux',
  'cli_wsl',
] as const satisfies readonly SponsoredExecutionSurface[]
export type SponsoredCliExecutionSurface =
  (typeof SPONSORED_CLI_EXECUTION_SURFACES)[number]

/** Whether a recorded or reported execution surface is one of the CLI's. */
export function isSponsoredCliExecutionSurface(
  surface: string | null | undefined,
): surface is SponsoredCliExecutionSurface {
  return (SPONSORED_CLI_EXECUTION_SURFACES as readonly string[]).includes(
    surface ?? '',
  )
}

/**
 * The CLI execution surface a request PROVES it can run a paid sponsored
 * procedure on, or null. The proof is the request's own v2 capability: it must
 * name a CLI surface that belongs to the reported OS (`cli_macos` on macOS,
 * `cli_linux` or `cli_wsl` on Linux -- WSL reports `linux`) with execution
 * `available` and no reason. The CLI reports `available` only when its
 * containment probe passed, so a Linux CLI without `bwrap` is never offered a
 * task whose Accept could only fail.
 *
 * The same OS pairing `/api/ads` applies to a CLI capability
 * (`sponsoredCapabilityMatchesRequest`), and the answer is also what tells
 * `cli_linux` from `cli_wsl`: the reported OS cannot.
 */
export function sponsoredCliExecutionSurfaceForRequest(
  reportedOs: string | null | undefined,
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
): SponsoredCliExecutionSurface | null {
  const execution = capability?.execution
  if (
    !execution ||
    execution.status !== 'available' ||
    execution.reason !== undefined
  )
    return null
  if (reportedOs === 'macos')
    return execution.surface === 'cli_macos' ? 'cli_macos' : null
  if (reportedOs === 'linux')
    return execution.surface === 'cli_linux' || execution.surface === 'cli_wsl'
      ? execution.surface
      : null
  return null
}

/**
 * The Desktop execution surface of the OS a Desktop process runs on, or null
 * for an OS Desktop does not run sponsored work on. What the client reports,
 * never what it is granted: the server decides whether that surface is served.
 */
export function sponsoredDesktopExecutionSurfaceForPlatform(
  platform: string,
): SponsoredDesktopExecutionSurface | null {
  if (platform === 'darwin') return 'desktop_macos'
  if (platform === 'linux') return 'desktop_linux'
  if (platform === 'win32') return 'desktop_windows'
  return null
}

export const SUPABASE_FOUNDATION_MODES = [
  'foundation-mac',
  'foundation-desktop',
  'foundation-backend-desktop',
  'foundation-local',
  'foundation-all',
] as const
export type SupabaseFoundationMode = (typeof SUPABASE_FOUNDATION_MODES)[number]
export function supabaseFoundationMode(
  raw: string | null | undefined,
): SupabaseFoundationMode | null {
  return SUPABASE_FOUNDATION_MODES.find((mode) => mode === raw) ?? null
}
