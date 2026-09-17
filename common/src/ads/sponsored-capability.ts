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
export const sponsoredExecutionSurfaceSchema = z.enum([
  'desktop_macos',
  'desktop_linux',
  'cli_macos',
  'cli_linux',
  'cli_wsl',
])
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

/** Each later wave includes the earlier wave; absent/legacy settings never opt in. */
export function supabaseFoundationCapabilityEligible(
  capability: SponsoredCapability | null | undefined,
  rawMode: string | null | undefined,
): boolean {
  const mode = supabaseFoundationMode(rawMode)
  if (
    !mode ||
    !capability ||
    !capability.hasGitRepository ||
    !capability.hasCommittedHead ||
    capability.execution.status !== 'available' ||
    capability.execution.reason !== undefined ||
    capability.framework === 'unsupported' ||
    capability.framework === 'unknown'
  )
    return false
  if (mode === 'foundation-mac') {
    return (
      capability.execution.surface === 'desktop_macos' &&
      capability.framework === 'nextjs'
    )
  }
  if (mode === 'foundation-desktop' || mode === 'foundation-backend-desktop')
    return capability.execution.surface.startsWith('desktop_')
  return true
}
