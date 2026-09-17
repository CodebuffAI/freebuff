import { z } from 'zod'

/** Non-billable, privacy-bounded lifecycle facts for a setup invitation. */
export const supabaseInvitationEventSchema = z.enum([
  'returned',
  'displayed',
  'clicked',
  'compatibility_ready',
  'compatibility_blocked',
  'setup_inspected',
  'setup_approved',
  'setup_declined',
  'setup_started',
  'setup_completed',
  'setup_failed',
  'proposal_linked',
])
export type SupabaseInvitationEvent = z.infer<typeof supabaseInvitationEventSchema>

/** Never carries local paths, command output, or arbitrary error strings. */
export const supabaseInvitationEventReasonSchema = z.enum([
  'git_root',
  'enclosing_repository',
  'no_repository',
  'git_unavailable',
  'unborn_repository',
  'broken_repository',
  'permission_denied',
  'timed_out',
  'unsafe_path',
  'other_incompatibility',
  'inspection_failed',
  'too_many_files',
])
export type SupabaseInvitationEventReason = z.infer<
  typeof supabaseInvitationEventReasonSchema
>

export const supabaseInvitationEventRequestSchema = z
  .object({
    eventId: z.string().uuid(),
    invitationId: z.string().uuid(),
    attributionToken: z.string().min(1).max(1024),
    event: supabaseInvitationEventSchema,
    /** Actual client build supplied by the authenticated transport. */
    clientVersion: z.string().min(1).max(64),
    attemptId: z.string().uuid().optional(),
    proposalId: z.string().min(1).max(256).optional(),
    reason: supabaseInvitationEventReasonSchema.optional(),
    /** Client event time is bounded against the signed retention window. */
    occurredAt: z.number().int().positive(),
  })
  .strict()
export type SupabaseInvitationEventRequest = z.infer<
  typeof supabaseInvitationEventRequestSchema
>
