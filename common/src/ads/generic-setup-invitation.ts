import { z } from 'zod'

/**
 * Non-billable discovery invitation for a reviewed generic advertiser offer.
 * This is not a sponsored-execution capability and must not imply Accept is
 * ready. Copy comes from the reviewed creative; do not invent product facts.
 */
export const genericSetupInvitationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('generic_setup'),
    invitationId: z.string().uuid(),
    campaignId: z.string().min(1).max(128),
    advertiserName: z.string().min(1).max(200),
    headline: z.string().min(1).max(200),
    body: z.string().min(1).max(2_000),
    cta: z.string().min(1).max(80).optional(),
    framework: z.enum([
      'nextjs',
      'react-vite',
      'nodejs',
      'unknown',
      'unsupported',
    ]),
    surface: z.enum(['desktop_macos', 'desktop_linux']),
    setupReason: z.enum([
      'no_git_repository',
      'no_committed_head',
      'compatibility_check_required',
    ]),
    expiresAt: z.number().int().positive(),
    policyVersion: z.string().min(1).max(80),
    decisionId: z.string().min(1).max(80),
  })
  .strict()

export type GenericSetupInvitation = z.infer<typeof genericSetupInvitationSchema>

export const GENERIC_SETUP_INVITATION_RECHECK_LABEL = 'Check compatibility'
