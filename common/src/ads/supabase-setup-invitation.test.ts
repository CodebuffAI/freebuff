import { describe, expect, test } from 'bun:test'

import {
  supabaseInvitationInspectionReasonSchema,
  supabaseSetupInvitationCapabilitySchema,
  supabaseSetupInvitationSchema,
} from './supabase-setup-invitation'

const workspaceId = '00000000-0000-4000-8000-000000000001'

describe('Supabase setup invitation contracts', () => {
  test('accepts the bounded read-only request capability', () => {
    expect(
      supabaseSetupInvitationCapabilitySchema.safeParse({
        schemaVersion: 2,
        target: { kind: 'workspace', workspaceId },
        framework: 'react-vite',
        execution: { surface: 'desktop_linux', status: 'available' },
        setupReason: 'no_git_repository',
        providerEvidence: {
          database: 'missing',
          auth: 'unknown',
          storage: 'present',
        },
      }).success,
    ).toBe(true)
  })

  test('refuses a path, unsupported framework, or unavailable execution', () => {
    const base = {
      schemaVersion: 2,
      target: { kind: 'workspace', workspaceId },
      framework: 'nextjs',
      execution: { surface: 'desktop_macos', status: 'available' },
      setupReason: 'no_committed_head',
      providerEvidence: {
        database: 'missing',
        auth: 'missing',
        storage: 'missing',
      },
    }
    expect(
      supabaseSetupInvitationCapabilitySchema.safeParse({
        ...base,
        schemaVersion: 1,
      }).success,
    ).toBe(false)
    expect(
      supabaseSetupInvitationCapabilitySchema.safeParse({
        ...base,
        target: { kind: 'workspace', workspaceId: '/Users/private/project' },
      }).success,
    ).toBe(false)
    expect(
      supabaseSetupInvitationCapabilitySchema.safeParse({
        ...base,
        framework: 'unsupported',
      }).success,
    ).toBe(false)
    expect(
      supabaseSetupInvitationCapabilitySchema.safeParse({
        ...base,
        execution: { surface: 'desktop_macos', status: 'unavailable' },
      }).success,
    ).toBe(false)
  })

  test('accepts v3 discovery facts without treating readiness as proven', () => {
    const request = {
      schemaVersion: 3,
      target: { kind: 'workspace', workspaceId },
      framework: 'unknown',
      execution: { surface: 'desktop_macos', status: 'unchecked' },
      setupReason: 'compatibility_check_required',
      providerEvidence: {
        database: 'unknown',
        auth: 'unknown',
        storage: 'unknown',
      },
    }
    expect(supabaseSetupInvitationCapabilitySchema.safeParse(request).success).toBe(
      true,
    )
    expect(
      supabaseSetupInvitationCapabilitySchema.safeParse({
        ...request,
        execution: { surface: 'desktop_macos', status: 'available' },
      }).success,
    ).toBe(false)
  })

  test('accepts the v2 discovery response and bounded inspection reasons', () => {
    const response = {
      schemaVersion: 2,
      kind: 'supabase_setup',
      invitationId: '00000000-0000-4000-8000-000000000002',
      framework: 'unknown',
      surface: 'desktop_linux',
      angle: 'database',
      setupReason: 'compatibility_check_required',
      expiresAt: 1,
    }
    expect(supabaseSetupInvitationSchema.safeParse(response).success).toBe(true)
    expect(
      supabaseInvitationInspectionReasonSchema.safeParse(
        'unreadable_package_manifest',
      ).success,
    ).toBe(true)
    expect(
      supabaseInvitationInspectionReasonSchema.safeParse('/private/project').success,
    ).toBe(false)
  })

  test('accepts only the bounded v3 billing capability', () => {
    const response = {
      schemaVersion: 3,
      kind: 'supabase_setup',
      invitationId: '00000000-0000-4000-8000-000000000002',
      framework: 'nextjs',
      surface: 'desktop_linux',
      angle: 'database',
      setupReason: 'compatibility_check_required',
      expiresAt: 1,
      billingToken: 'opaque-token',
      experimentVersion: 'supabase_format_cpc_v1',
    }
    expect(supabaseSetupInvitationSchema.safeParse(response).success).toBe(true)
    expect(
      supabaseSetupInvitationSchema.safeParse({ ...response, billingToken: '' })
        .success,
    ).toBe(false)
    expect(
      supabaseSetupInvitationSchema.safeParse({ ...response, extra: 'forbidden' })
        .success,
    ).toBe(false)
  })

  test('keeps target, commands, and billing identifiers out of the response', () => {
    const response = {
      schemaVersion: 1,
      kind: 'supabase_setup',
      invitationId: '00000000-0000-4000-8000-000000000002',
      framework: 'nodejs',
      surface: 'desktop_macos',
      angle: 'database',
      setupReason: 'no_git_repository',
      expiresAt: 1,
    }
    expect(supabaseSetupInvitationSchema.safeParse(response).success).toBe(true)
    expect(
      supabaseSetupInvitationSchema.safeParse({
        ...response,
        target: workspaceId,
      }).success,
    ).toBe(false)
    expect(
      supabaseSetupInvitationSchema.safeParse({
        ...response,
        impUrl: 'bill-me',
      }).success,
    ).toBe(false)
  })
})
