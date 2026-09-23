import { describe, expect, test } from 'bun:test'
import {
  sponsoredCapabilitySchema,
  SUPABASE_FOUNDATION_MODES,
  SUPABASE_FOUNDATION_RUNNABLE_FRAMEWORKS,
  supabaseFoundationCapabilityEligible,
  supabaseFoundationFrameworkRunnable,
  supabaseFoundationStackEligible,
  type SponsoredCapability,
} from './sponsored-capability'
const capability: SponsoredCapability = {
  schemaVersion: 2,
  target: {
    kind: 'workspace',
    workspaceId: '00000000-0000-4000-8000-000000000001',
  },
  framework: 'nextjs',
  packageManager: 'npm',
  hasSupabaseBoundary: false,
  hasCommittedDatabaseBoundary: false,
  hasGitRepository: true,
  hasCommittedHead: true,
  execution: { surface: 'desktop_macos', status: 'available' },
}
describe('foundation execution admission', () => {
  test('legacy and missing modes never expand audience', () => {
    for (const mode of [
      undefined,
      'off',
      'on',
      'agentic-pilot',
      'foundation-typo',
    ]) {
      expect(supabaseFoundationCapabilityEligible(capability, mode)).toBe(false)
    }
  })
  test('waves admit only their qualified surfaces and frameworks', () => {
    expect(
      supabaseFoundationCapabilityEligible(capability, 'foundation-mac'),
    ).toBe(true)
    const linux: SponsoredCapability = {
      ...capability,
      framework: 'react-vite',
      execution: { surface: 'desktop_linux', status: 'available' },
    }
    expect(supabaseFoundationCapabilityEligible(linux, 'foundation-mac')).toBe(
      false,
    )
    expect(
      supabaseFoundationCapabilityEligible(linux, 'foundation-desktop'),
    ).toBe(true)
    const cli: SponsoredCapability = {
      ...linux,
      execution: { surface: 'cli_wsl', status: 'available' },
    }
    expect(
      supabaseFoundationCapabilityEligible(cli, 'foundation-desktop'),
    ).toBe(false)
    expect(supabaseFoundationCapabilityEligible(cli, 'foundation-local')).toBe(
      true,
    )
  })
  test('unknown state or failed containment cannot become runnable', () => {
    for (const overrides of [
      { hasGitRepository: false },
      { hasCommittedHead: false },
      { framework: 'unknown' as const },
      {
        execution: {
          surface: 'desktop_linux' as const,
          status: 'unavailable' as const,
          reason: 'bubblewrap_missing' as const,
        },
      },
    ]) {
      expect(
        supabaseFoundationCapabilityEligible(
          { ...capability, ...overrides },
          'foundation-all',
        ),
      ).toBe(false)
    }
  })
  test('provider evidence is additive and missing remains unknown for older v2 clients', () => {
    const older = sponsoredCapabilitySchema.parse(capability)
    expect(older.hasCommittedAuthBoundary).toBeUndefined()
    expect(older.hasCommittedStorageBoundary).toBeUndefined()
    const current = sponsoredCapabilitySchema.parse({
      ...capability,
      hasCommittedAuthBoundary: false,
      hasCommittedStorageBoundary: true,
    })
    expect(current.hasCommittedAuthBoundary).toBe(false)
    expect(current.hasCommittedStorageBoundary).toBe(true)
    expect(
      sponsoredCapabilitySchema.safeParse({
        ...capability,
        hasCommittedAuthBoundary: 'unknown',
      }).success,
    ).toBe(false)
  })
  test('wire rejects paths, unsupported platforms, extra evidence and invalid identity', () => {
    expect(sponsoredCapabilitySchema.safeParse(capability).success).toBe(true)
    expect(
      sponsoredCapabilitySchema.safeParse({
        ...capability,
        target: { kind: 'workspace', workspaceId: '/Users/private/project' },
      }).success,
    ).toBe(false)
    expect(
      sponsoredCapabilitySchema.safeParse({
        ...capability,
        localPath: '/secret',
      }).success,
    ).toBe(false)
    expect(
      sponsoredCapabilitySchema.safeParse({
        ...capability,
        execution: { surface: 'windows', status: 'available' },
      }).success,
    ).toBe(false)
  })
  test('the stack half is the serve gate: it agrees with full admission on every wave, framework and surface', () => {
    const frameworks = sponsoredCapabilitySchema.shape.framework.options
    const surfaces = ['desktop_macos', 'desktop_linux', 'cli_wsl'] as const
    for (const mode of [...SUPABASE_FOUNDATION_MODES, 'on', undefined]) {
      for (const framework of frameworks) {
        for (const surface of surfaces) {
          expect(
            supabaseFoundationStackEligible({ framework, surface }, mode),
          ).toBe(
            supabaseFoundationCapabilityEligible(
              {
                ...capability,
                framework,
                execution: { surface, status: 'available' },
              },
              mode,
            ),
          )
        }
      }
    }
  })
  test('unknown and unsupported frameworks are never runnable', () => {
    expect([...SUPABASE_FOUNDATION_RUNNABLE_FRAMEWORKS]).toEqual([
      'nextjs',
      'react-vite',
      'nodejs',
    ])
    for (const framework of ['unknown', 'unsupported', 'vue', '']) {
      expect(supabaseFoundationFrameworkRunnable(framework)).toBe(false)
      expect(
        supabaseFoundationStackEligible(
          { framework, surface: 'desktop_macos' },
          'foundation-backend-desktop',
        ),
      ).toBe(false)
    }
  })
})
