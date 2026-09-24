import { describe, expect, test } from 'bun:test'

import {
  SPONSORED_WINDOWS_CONTAINMENT,
  SPONSORED_WINDOWS_EXECUTION_SURFACE,
  readSponsoredWindowsPolicy,
  sponsoredDesktopSurfaceMatchesOs,
  sponsoredExecutionContainment,
  sponsoredWindowsAdmitsCampaign,
} from './sponsored-windows'
import { SUPABASE_FORMAT_DATABASE_PAIR } from './supabase-format-experiment'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('FREEBUFF_SPONSORED_WINDOWS (COD-642)', () => {
  test('absent is the shipped position: closed', () => {
    expect(readSponsoredWindowsPolicy({})).toBeNull()
    expect(
      readSponsoredWindowsPolicy({
        FREEBUFF_SPONSORED_WINDOWS_CAMPAIGN_IDS: A,
      }),
    ).toBeNull()
  })

  test('only the exact value `on` opens; every other value fails closed', () => {
    for (const value of [
      'off',
      'ON',
      'On',
      'true',
      '1',
      'yes',
      'enabled',
      'on,off',
      '',
      '   ',
    ]) {
      expect(
        readSponsoredWindowsPolicy({
          FREEBUFF_SPONSORED_WINDOWS: value,
          FREEBUFF_SPONSORED_WINDOWS_CAMPAIGN_IDS: A,
        }),
      ).toBeNull()
    }
    // Surrounding whitespace from a dashboard paste is not a different value.
    expect(
      readSponsoredWindowsPolicy({
        FREEBUFF_SPONSORED_WINDOWS: ' on ',
        FREEBUFF_SPONSORED_WINDOWS_CAMPAIGN_IDS: A,
      }),
    ).not.toBeNull()
  })

  test('on without an opt-in list serves nothing', () => {
    for (const list of [undefined, '', '  ']) {
      expect(
        readSponsoredWindowsPolicy({
          FREEBUFF_SPONSORED_WINDOWS: 'on',
          FREEBUFF_SPONSORED_WINDOWS_CAMPAIGN_IDS: list,
        }),
      ).toBeNull()
    }
  })

  test('a malformed list closes Windows rather than widening it', () => {
    for (const list of [
      '*',
      `*,${A}`,
      `${A},*`,
      `${A},`,
      `${A},,${B}`,
      'not-a-uuid',
      `${A},not-a-uuid`,
      // Version nibble 0 is not a UUID this repo mints.
      'aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa',
      Array.from(
        { length: 101 },
        (_, index) =>
          `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      ).join(','),
    ]) {
      expect(
        readSponsoredWindowsPolicy({
          FREEBUFF_SPONSORED_WINDOWS: 'on',
          FREEBUFF_SPONSORED_WINDOWS_CAMPAIGN_IDS: list,
        }),
      ).toBeNull()
    }
  })

  test('on with a list admits exactly the listed campaigns, case-insensitively', () => {
    const policy = readSponsoredWindowsPolicy({
      FREEBUFF_SPONSORED_WINDOWS: 'on',
      FREEBUFF_SPONSORED_WINDOWS_CAMPAIGN_IDS: ` ${A.toUpperCase()} , ${A} `,
    })
    expect(policy).not.toBeNull()
    expect([...policy!.campaignIds]).toEqual([A])
    expect(sponsoredWindowsAdmitsCampaign(policy, A)).toBe(true)
    expect(sponsoredWindowsAdmitsCampaign(policy, A.toUpperCase())).toBe(true)
    expect(sponsoredWindowsAdmitsCampaign(policy, B)).toBe(false)
    expect(sponsoredWindowsAdmitsCampaign(policy, '')).toBe(false)
    expect(sponsoredWindowsAdmitsCampaign(policy, undefined)).toBe(false)
    expect(Object.isFrozen(policy)).toBe(true)
  })

  test('no policy admits nothing', () => {
    for (const policy of [null, undefined])
      expect(sponsoredWindowsAdmitsCampaign(policy, A)).toBe(false)
  })
})

describe('Desktop OS pairing', () => {
  test('each OS pairs only with its own surface', () => {
    const options = { windows: true }
    expect(
      sponsoredDesktopSurfaceMatchesOs('desktop_macos', 'macos', options),
    ).toBe(true)
    expect(
      sponsoredDesktopSurfaceMatchesOs('desktop_linux', 'linux', options),
    ).toBe(true)
    expect(
      sponsoredDesktopSurfaceMatchesOs('desktop_windows', 'windows', options),
    ).toBe(true)
    for (const [surface, os] of [
      ['desktop_macos', 'windows'],
      ['desktop_linux', 'windows'],
      ['desktop_windows', 'macos'],
      ['desktop_windows', 'linux'],
      ['desktop_macos', 'linux'],
      ['desktop_linux', 'macos'],
      ['desktop_windows', null],
      ['cli_wsl', 'linux'],
    ] as const) {
      expect(sponsoredDesktopSurfaceMatchesOs(surface, os, options)).toBe(false)
    }
  })

  test('a consumer that does not serve Windows refuses it outright', () => {
    expect(
      sponsoredDesktopSurfaceMatchesOs('desktop_windows', 'windows', {
        windows: false,
      }),
    ).toBe(false)
    // ...and pairs macOS/Linux exactly as before.
    expect(
      sponsoredDesktopSurfaceMatchesOs('desktop_macos', 'macos', {
        windows: false,
      }),
    ).toBe(true)
    expect(
      sponsoredDesktopSurfaceMatchesOs('desktop_linux', 'linux', {
        windows: false,
      }),
    ).toBe(true)
  })
})

describe('containment', () => {
  test('Windows is the floor; every sandboxed or Cloud surface records none', () => {
    expect(SPONSORED_WINDOWS_EXECUTION_SURFACE).toBe('desktop_windows')
    expect(SPONSORED_WINDOWS_CONTAINMENT).toBe('floor')
    expect(sponsoredExecutionContainment('desktop_windows')).toBe('floor')
    for (const surface of [
      'desktop_macos',
      'desktop_linux',
      'cli_macos',
      'cli_linux',
      'cli_wsl',
      'web',
      'cloud',
      null,
      undefined,
    ])
      expect(sponsoredExecutionContainment(surface)).toBeNull()
  })
})

describe('Supabase never reaches Windows (COD-642 x COD-649)', () => {
  const OPT_IN = '11111111-1111-4111-8111-111111111111'
  const AUTH_AGENTIC = '22222222-2222-4222-8222-222222222222'
  const env = (ids: string[]) => ({
    FREEBUFF_SPONSORED_WINDOWS: 'on',
    FREEBUFF_SPONSORED_WINDOWS_CAMPAIGN_IDS: ids.join(','),
  })

  test('the fixed database pair is dropped from the list, and the rest still serve', () => {
    const policy = readSponsoredWindowsPolicy(
      env([SUPABASE_FORMAT_DATABASE_PAIR.agenticCampaignId, OPT_IN]),
    )
    expect(policy).not.toBeNull()
    expect(
      sponsoredWindowsAdmitsCampaign(
        policy,
        SUPABASE_FORMAT_DATABASE_PAIR.agenticCampaignId,
      ),
    ).toBe(false)
    expect(sponsoredWindowsAdmitsCampaign(policy, OPT_IN)).toBe(true)
  })

  test('a list of only Supabase ids opens nothing', () => {
    expect(
      readSponsoredWindowsPolicy(
        env([
          SUPABASE_FORMAT_DATABASE_PAIR.agenticCampaignId,
          SUPABASE_FORMAT_DATABASE_PAIR.displayCampaignId,
        ]),
      ),
    ).toBeNull()
  })

  test('env-configured pairs passed by the runtime are dropped too', () => {
    const policy = readSponsoredWindowsPolicy(env([AUTH_AGENTIC, OPT_IN]), {
      excludedCampaignIds: [AUTH_AGENTIC.toUpperCase()],
    })
    expect(sponsoredWindowsAdmitsCampaign(policy, AUTH_AGENTIC)).toBe(false)
    expect(sponsoredWindowsAdmitsCampaign(policy, OPT_IN)).toBe(true)
  })

  test('a hand-built policy still cannot admit the fixed database pair', () => {
    const policy = Object.freeze({
      campaignIds: new Set([SUPABASE_FORMAT_DATABASE_PAIR.agenticCampaignId]),
    })
    expect(
      sponsoredWindowsAdmitsCampaign(
        policy,
        SUPABASE_FORMAT_DATABASE_PAIR.agenticCampaignId,
      ),
    ).toBe(false)
  })
})
