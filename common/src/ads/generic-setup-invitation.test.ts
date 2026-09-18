import { describe, expect, test } from 'bun:test'

import { genericSetupInvitationSchema } from './generic-setup-invitation'

const invitation = {
  schemaVersion: 1 as const,
  kind: 'generic_setup' as const,
  invitationId: '00000000-0000-4000-8000-000000000010',
  campaignId: 'campaign-1',
  advertiserName: 'Acme Monitoring',
  headline: 'Add error monitoring',
  body: 'A reviewed setup invitation. Nothing has started.',
  framework: 'unknown' as const,
  surface: 'desktop_macos' as const,
  setupReason: 'compatibility_check_required' as const,
  expiresAt: 2_000_000_000_000,
  policyVersion: 'generic-agentic-invitation-v1',
  decisionId: 'gai_testdecision',
}

describe('generic setup invitation contract', () => {
  test('accepts a campaign-bound discovery invitation', () => {
    expect(genericSetupInvitationSchema.safeParse(invitation).success).toBe(true)
  })

  test('refuses Supabase semantics, paths, and missing campaign identity', () => {
    expect(
      genericSetupInvitationSchema.safeParse({
        ...invitation,
        kind: 'supabase_setup',
        angle: 'database',
      }).success,
    ).toBe(false)
    expect(
      genericSetupInvitationSchema.safeParse({
        ...invitation,
        campaignId: '',
      }).success,
    ).toBe(false)
    expect(
      genericSetupInvitationSchema.safeParse({
        ...invitation,
        setupReason: 'windows_no_containment',
      }).success,
    ).toBe(false)
  })
})
