import { z } from 'zod'

/**
 * Read-only Desktop facts used to decide whether a setup invitation may be
 * returned. This is deliberately not a sponsored-execution capability: it
 * proves neither a committed checkout nor a runnable paid task.
 */
export const supabaseSetupInvitationCapabilitySchema = z
  .object({
    schemaVersion: z.literal(1),
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

export type SupabaseSetupInvitationCapabilityV1 = z.infer<
  typeof supabaseSetupInvitationCapabilitySchema
>

/**
 * Non-billable response data. The target stays request-only: it is used by
 * the server's preference/cooldown decision and never becomes browser data.
 */
export const supabaseSetupInvitationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('supabase_setup'),
    invitationId: z.string().uuid(),
    framework: z.enum(['nextjs', 'react-vite', 'nodejs']),
    surface: z.enum(['desktop_macos', 'desktop_linux']),
    angle: z.enum(['database', 'auth', 'storage']),
    setupReason: z.enum(['no_git_repository', 'no_committed_head']),
    expiresAt: z.number().int().positive(),
  })
  .strict()

export type SupabaseSetupInvitationV1 = z.infer<
  typeof supabaseSetupInvitationSchema
>

/** UI-owned action text; the transport intentionally contains no URL or command. */
export const SUPABASE_SETUP_INVITATION_RECHECK_LABEL = 'Recheck setup'
