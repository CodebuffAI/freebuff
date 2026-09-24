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
    // `desktop_windows` only ever leaves the server behind
    // `FREEBUFF_SPONSORED_WINDOWS` (COD-642).
    surface: z.enum(['desktop_macos', 'desktop_linux', 'desktop_windows']),
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

export type GenericSetupInvitation = z.infer<
  typeof genericSetupInvitationSchema
>

export const GENERIC_SETUP_INVITATION_RECHECK_LABEL = 'Check compatibility'

/**
 * The first Desktop release whose parser knows `generic_setup` (0.0.124,
 * COD-598). An older build parses only the Supabase schema and drops a
 * generic invitation without a trace, so the server must not answer one.
 */
export const GENERIC_SETUP_INVITATION_MIN_DESKTOP_VERSION = [0, 0, 124] as const

/**
 * Request field `invitationReadyDiscoveryVersion`. `1` = this Desktop draws a
 * generic invitation on a READY-project discovery request too (the request
 * that names the Supabase campaign with no `invitationId`). Every release
 * before it accepts only a Supabase invitation there and drops a generic one,
 * so the server withholds it from them and the slot gets an ordinary ad.
 */
export const GENERIC_INVITATION_READY_DISCOVERY_VERSION = 1
