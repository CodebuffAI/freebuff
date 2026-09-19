import { z } from 'zod'
import { SUPABASE_FORMAT_CPC_EXPERIMENT_VERSION } from './supabase-format-cpc-experiment'

/**
 * Read-only Desktop facts used to decide whether a setup invitation may be
 * returned. This is deliberately not a sponsored-execution capability: it
 * proves neither a committed checkout nor a runnable paid task.
 * Version 2 recognizes existing third-party provider packages. Do not accept
 * version 1's incomplete provider evidence for serving new invitations.
 */
export const supabaseSetupInvitationCapabilityV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    target: z
      .object({ kind: z.literal('workspace'), workspaceId: z.string().uuid() })
      .strict(),
    framework: z.enum(['nextjs', 'react-vite', 'nodejs']),
    execution: z
      .object({
        surface: z.enum(['desktop_macos', 'desktop_linux']),
        status: z.literal('available'),
      })
      .strict(),
    // This wave explains only why paid execution is not ready. Do not turn
    // inspection uncertainty into a setup instruction.
    setupReason: z.enum(['no_git_repository', 'no_committed_head']),
    providerEvidence: z
      .object({
        database: z.enum(['missing', 'present', 'unknown']),
        auth: z.enum(['missing', 'present', 'unknown']),
        storage: z.enum(['missing', 'present', 'unknown']),
      })
      .strict(),
  })
  .strict()

export type SupabaseSetupInvitationCapabilityV2 = z.infer<
  typeof supabaseSetupInvitationCapabilityV2Schema
>

/**
 * Broad discovery capability. Unlike v2, this says only that Desktop has an
 * opaque workspace identity on a supported local surface. It deliberately
 * makes no claim about a package manifest, Git checkout, containment, or
 * whether sponsored execution can start.
 */
export const supabaseSetupInvitationCapabilityV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    target: z
      .object({ kind: z.literal('workspace'), workspaceId: z.string().uuid() })
      .strict(),
    framework: z.enum([
      'nextjs',
      'react-vite',
      'nodejs',
      'unknown',
      'unsupported',
    ]),
    execution: z
      .object({
        surface: z.enum(['desktop_macos', 'desktop_linux']),
        status: z.literal('unchecked'),
      })
      .strict(),
    setupReason: z.literal('compatibility_check_required'),
    providerEvidence: z
      .object({
        database: z.enum(['missing', 'present', 'unknown']),
        auth: z.enum(['missing', 'present', 'unknown']),
        storage: z.enum(['missing', 'present', 'unknown']),
      })
      .strict(),
  })
  .strict()

export type SupabaseSetupInvitationCapabilityV3 = z.infer<
  typeof supabaseSetupInvitationCapabilityV3Schema
>

/** Accept outstanding v2 invitations while new Desktop clients send v3. */
export const supabaseSetupInvitationCapabilitySchema = z.union([
  supabaseSetupInvitationCapabilityV2Schema,
  supabaseSetupInvitationCapabilityV3Schema,
])

export type SupabaseSetupInvitationCapability = z.infer<
  typeof supabaseSetupInvitationCapabilitySchema
>

/**
 * Bounded client-side discovery state for aggregate delivery diagnostics.
 * It is intentionally an enum: never send a local path, parser error, or
 * other host-derived detail with an ad request.
 */
export const supabaseInvitationInspectionReasonSchema = z.enum([
  'no_project',
  'paid_execution_path',
  'cooldown',
  'in_flight',
  'no_workspace_identity',
  'unreadable_package_manifest',
  'unsupported_framework',
  'windows_no_containment',
  'bubblewrap_missing',
  'containment_probe_failed',
  'unsupported_platform',
  'no_git_repository',
  'no_committed_head',
  'ready_for_paid_execution',
  'inspection_failed',
  'compatibility_check_required',
])

export type SupabaseInvitationInspectionReason = z.infer<
  typeof supabaseInvitationInspectionReasonSchema
>

/**
 * Non-billable response data. The target stays request-only: it is used by
 * the server's preference/cooldown decision and never becomes browser data.
 */
export const supabaseSetupInvitationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('supabase_setup'),
    invitationId: z.string().uuid(),
    framework: z.enum(['nextjs', 'react-vite', 'nodejs']),
    surface: z.enum(['desktop_macos', 'desktop_linux']),
    angle: z.enum(['database', 'auth', 'storage']),
    setupReason: z.enum(['no_git_repository', 'no_committed_head']),
    expiresAt: z.number().int().positive(),
    /** Server-issued, user/workspace/campaign-bound telemetry capability. */
    attributionToken: z.string().min(1).max(1024).optional(),
  })
  .strict()

export type SupabaseSetupInvitationV1 = z.infer<
  typeof supabaseSetupInvitationV1Schema
>

/**
 * A non-billable discovery response. Acceptance and paid execution remain
 * separately gated; this response must not imply either is ready.
 */
export const supabaseSetupInvitationV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('supabase_setup'),
    invitationId: z.string().uuid(),
    framework: z.enum([
      'nextjs',
      'react-vite',
      'nodejs',
      'unknown',
      'unsupported',
    ]),
    surface: z.enum(['desktop_macos', 'desktop_linux']),
    angle: z.enum(['database', 'auth', 'storage']),
    setupReason: z.literal('compatibility_check_required'),
    expiresAt: z.number().int().positive(),
    /** Optional so older strict response readers remain compatible. */
    attributionToken: z.string().min(1).max(1024).optional(),
  })
  .strict()

export type SupabaseSetupInvitationV2 = z.infer<
  typeof supabaseSetupInvitationV2Schema
>

/**
 * The paid discovery experiment charges a single advertiser CPC when the user
 * starts the compatibility path. The opaque token is server-issued and bound
 * to the invitation; Desktop never derives or reuses it for another card.
 */
export const supabaseSetupInvitationV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    kind: z.literal('supabase_setup'),
    invitationId: z.string().uuid(),
    framework: z.enum([
      'nextjs',
      'react-vite',
      'nodejs',
      'unknown',
      'unsupported',
    ]),
    surface: z.enum(['desktop_macos', 'desktop_linux']),
    angle: z.enum(['database', 'auth', 'storage']),
    setupReason: z.literal('compatibility_check_required'),
    expiresAt: z.number().int().positive(),
    attributionToken: z.string().min(1).max(1024).optional(),
    billingToken: z.string().min(1).max(4096),
    experimentVersion: z.literal(SUPABASE_FORMAT_CPC_EXPERIMENT_VERSION),
  })
  .strict()

export type SupabaseSetupInvitationV3 = z.infer<
  typeof supabaseSetupInvitationV3Schema
>

/** Accept outstanding v1/v2 cards while new clients render paid v3 discovery cards. */
export const supabaseSetupInvitationSchema = z.union([
  supabaseSetupInvitationV1Schema,
  supabaseSetupInvitationV2Schema,
  supabaseSetupInvitationV3Schema,
])

export type SupabaseSetupInvitation = z.infer<
  typeof supabaseSetupInvitationSchema
>

/** UI-owned action text; the transport intentionally contains no URL or command. */
export const SUPABASE_SETUP_INVITATION_RECHECK_LABEL = 'Recheck setup'
