import { describe, expect, test } from 'bun:test'
import {
  isSponsoredCliExecutionSurface,
  sponsoredCapabilitySchema,
  sponsoredCliExecutionSurfaceForRequest,
  sponsoredDesktopExecutionSurfaceForPlatform,
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
  test('the wire carries desktop_windows (COD-642), but no Supabase wave admits it', () => {
    const windows = {
      ...capability,
      execution: {
        surface: 'desktop_windows' as const,
        status: 'available' as const,
      },
    }
    expect(sponsoredCapabilitySchema.safeParse(windows).success).toBe(true)
    // The Supabase format stays macOS/Linux: a `desktop_` prefix test would
    // otherwise have admitted Windows to every desktop wave.
    for (const mode of [...SUPABASE_FOUNDATION_MODES, 'on', undefined]) {
      expect(supabaseFoundationCapabilityEligible(windows, mode)).toBe(false)
      for (const framework of SUPABASE_FOUNDATION_RUNNABLE_FRAMEWORKS)
        expect(
          supabaseFoundationStackEligible(
            { framework, surface: 'desktop_windows' },
            mode,
          ),
        ).toBe(false)
    }
  })
  test('the stack half is the serve gate: it agrees with full admission on every wave, framework and surface', () => {
    const frameworks = sponsoredCapabilitySchema.shape.framework.options
    const surfaces = [
      'desktop_macos',
      'desktop_linux',
      'desktop_windows',
      'cli_wsl',
    ] as const
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

describe('the Desktop surface a process reports (COD-642)', () => {
  test('each OS names its own surface, and no other', () => {
    expect(sponsoredDesktopExecutionSurfaceForPlatform('darwin')).toBe(
      'desktop_macos',
    )
    expect(sponsoredDesktopExecutionSurfaceForPlatform('linux')).toBe(
      'desktop_linux',
    )
    expect(sponsoredDesktopExecutionSurfaceForPlatform('win32')).toBe(
      'desktop_windows',
    )
    expect(sponsoredDesktopExecutionSurfaceForPlatform('freebsd')).toBeNull()
  })
})

describe('the CLI execution surface a request proves', () => {
  const execution = (
    surface: string,
    status = 'available',
    reason?: string,
  ) => ({ execution: { surface, status, ...(reason ? { reason } : {}) } })

  test('macOS proves cli_macos; Linux proves cli_linux or cli_wsl', () => {
    expect(
      sponsoredCliExecutionSurfaceForRequest('macos', execution('cli_macos')),
    ).toBe('cli_macos')
    expect(
      sponsoredCliExecutionSurfaceForRequest('linux', execution('cli_linux')),
    ).toBe('cli_linux')
    // WSL reports `linux`; only the capability can tell it apart.
    expect(
      sponsoredCliExecutionSurfaceForRequest('linux', execution('cli_wsl')),
    ).toBe('cli_wsl')
  })

  test('nothing is proven by a mismatched OS, a Desktop surface, an unavailable run or no capability', () => {
    expect(
      sponsoredCliExecutionSurfaceForRequest('linux', execution('cli_macos')),
    ).toBeNull()
    expect(
      sponsoredCliExecutionSurfaceForRequest('macos', execution('cli_linux')),
    ).toBeNull()
    expect(
      sponsoredCliExecutionSurfaceForRequest(
        'macos',
        execution('desktop_macos'),
      ),
    ).toBeNull()
    expect(
      sponsoredCliExecutionSurfaceForRequest(
        'linux',
        execution('cli_linux', 'unavailable', 'bubblewrap_missing'),
      ),
    ).toBeNull()
    expect(
      sponsoredCliExecutionSurfaceForRequest(
        'linux',
        execution('cli_linux', 'available', 'bubblewrap_missing'),
      ),
    ).toBeNull()
    expect(
      sponsoredCliExecutionSurfaceForRequest('windows', execution('cli_wsl')),
    ).toBeNull()
    expect(sponsoredCliExecutionSurfaceForRequest('macos', null)).toBeNull()
    expect(sponsoredCliExecutionSurfaceForRequest(null, undefined)).toBeNull()
  })

  test('the CLI surfaces are exactly the schema’s cli_ members', () => {
    for (const surface of ['cli_macos', 'cli_linux', 'cli_wsl'])
      expect(isSponsoredCliExecutionSurface(surface)).toBe(true)
    for (const surface of ['desktop_macos', 'cli_chat', 'cli_windows', '', null])
      expect(isSponsoredCliExecutionSurface(surface)).toBe(false)
  })
})
