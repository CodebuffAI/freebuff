import { z } from 'zod'

/** Client evidence only: the execution host rechecks these facts before Accept. */
export const sponsoredCapabilityReasonSchema = z.enum([
  'no_git_repository',
  'enclosing_repository',
  'git_unavailable',
  'missing_workspace_identity',
  'no_committed_head',
  'windows_no_containment',
  'bubblewrap_missing',
  'unsupported_platform',
  'inspection_failed',
  'unsupported_framework',
  'unreadable_package_manifest',
  'no_consent_bridge',
  'containment_probe_failed',
])
export const capabilityInspectionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available') }).strict(),
  z
    .object({
      status: z.literal('unavailable'),
      reason: sponsoredCapabilityReasonSchema,
    })
    .strict(),
])
export const sponsoredLocalTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('repo'),
      repoFullName: z
        .string()
        .regex(/^[a-z0-9][a-z0-9._-]{0,98}\/[a-z0-9][a-z0-9._-]{0,98}$/i),
    })
    .strict(),
  z
    .object({ kind: z.literal('workspace'), workspaceId: z.string().uuid() })
    .strict(),
])
/**
 * Where a local sponsored run executes. `desktop_windows` (COD-642) is the one
 * surface with NO OS sandbox: its protection is campaign review plus the
 * portable floor (`SPONSORED_WINDOWS_CONTAINMENT` in `./sponsored-windows`).
 * A Windows value on the wire admits nothing by itself — the server serves it
 * only behind `FREEBUFF_SPONSORED_WINDOWS` and a per-campaign opt-in, and the
 * Supabase format never serves it at all.
 */
export const sponsoredExecutionSurfaceSchema = z.enum([
  'desktop_macos',
  'desktop_linux',
  'desktop_windows',
  'cli_macos',
  'cli_linux',
  'cli_wsl',
])
export type SponsoredExecutionSurface = z.infer<
  typeof sponsoredExecutionSurfaceSchema
>

/** The Desktop execution surfaces, one per OS a Desktop client reports. */
export const SPONSORED_DESKTOP_EXECUTION_SURFACES = [
  'desktop_macos',
  'desktop_linux',
  'desktop_windows',
] as const satisfies readonly SponsoredExecutionSurface[]
export type SponsoredDesktopExecutionSurface =
  (typeof SPONSORED_DESKTOP_EXECUTION_SURFACES)[number]
export const sponsoredCapabilitySchema = z
  .object({
    schemaVersion: z.literal(2),
    target: sponsoredLocalTargetSchema,
    framework: z.enum([
      'nextjs',
      'react-vite',
      'nodejs',
      'unsupported',
      'unknown',
    ]),
    packageManager: z.enum(['bun', 'npm', 'pnpm', 'yarn', 'unknown']),
    hasSupabaseBoundary: z.boolean(),
    hasCommittedDatabaseBoundary: z.boolean(),
    // Missing on older clients means unknown, never provider-open.
    hasCommittedAuthBoundary: z.boolean().optional(),
    hasCommittedStorageBoundary: z.boolean().optional(),
    hasGitRepository: z.boolean(),
    hasCommittedHead: z.boolean(),
    execution: z
      .object({
        surface: sponsoredExecutionSurfaceSchema,
        status: z.enum(['available', 'unavailable']),
        reason: sponsoredCapabilityReasonSchema.optional(),
      })
      .strict(),
  })
  .strict()

export type SponsoredCapability = z.infer<typeof sponsoredCapabilitySchema>
export type SponsoredLocalTarget = z.infer<typeof sponsoredLocalTargetSchema>
export type CapabilityInspection = z.infer<typeof capabilityInspectionSchema>
export type SponsoredCapabilityReason = z.infer<
  typeof sponsoredCapabilityReasonSchema
>

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

/**
 * The stacks the reviewed Supabase foundation procedure runs on. THE ONE LIST:
 * paid fulfillment (`supabaseFoundationCapabilityEligible`) and the paid
 * invitation's serve gate both read it through `supabaseFoundationStackEligible`,
 * so a billable invitation is never served for a stack fulfillment refuses.
 * `unknown` and `unsupported` are deliberately absent.
 */
export const SUPABASE_FOUNDATION_RUNNABLE_FRAMEWORKS = [
  'nextjs',
  'react-vite',
  'nodejs',
] as const satisfies readonly SponsoredCapability['framework'][]

export function supabaseFoundationFrameworkRunnable(
  framework: string,
): framework is (typeof SUPABASE_FOUNDATION_RUNNABLE_FRAMEWORKS)[number] {
  return (
    SUPABASE_FOUNDATION_RUNNABLE_FRAMEWORKS as readonly string[]
  ).includes(framework)
}

/**
 * The framework-and-surface half of foundation admission, per wave. It needs
 * only facts a non-billable invitation capability also carries, so the paid
 * serve gate applies exactly what fulfillment will. Git, head and containment
 * are the other half, checked only on the sponsored capability.
 */
export function supabaseFoundationStackEligible(
  stack: {
    framework: string
    surface: SponsoredCapability['execution']['surface']
  },
  rawMode: string | null | undefined,
): boolean {
  const mode = supabaseFoundationMode(rawMode)
  if (!mode || !supabaseFoundationFrameworkRunnable(stack.framework))
    return false
  // The Supabase format stays macOS/Linux (COD-642 scope: generic campaigns
  // only). Refused by name because the waves below test prefixes, and a
  // `desktop_` prefix alone would otherwise admit Windows to every wave.
  if (stack.surface === 'desktop_windows') return false
  if (mode === 'foundation-mac')
    return stack.surface === 'desktop_macos' && stack.framework === 'nextjs'
  if (mode === 'foundation-desktop' || mode === 'foundation-backend-desktop')
    return stack.surface.startsWith('desktop_')
  return true
}

/** Each later wave includes the earlier wave; absent/legacy settings never opt in. */
export function supabaseFoundationCapabilityEligible(
  capability: SponsoredCapability | null | undefined,
  rawMode: string | null | undefined,
): boolean {
  if (
    !capability ||
    !capability.hasGitRepository ||
    !capability.hasCommittedHead ||
    capability.execution.status !== 'available' ||
    capability.execution.reason !== undefined
  )
    return false
  return supabaseFoundationStackEligible(
    {
      framework: capability.framework,
      surface: capability.execution.surface,
    },
    rawMode,
  )
}
