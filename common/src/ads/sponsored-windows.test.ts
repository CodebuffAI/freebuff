import { describe, expect, test } from 'bun:test'

import {
  SPONSORED_WINDOWS_CONTAINMENT,
  SPONSORED_WINDOWS_EXECUTION_SURFACE,
  SPONSORED_WINDOWS_ON,
  readSponsoredWindowsPolicy,
  sponsoredContainmentFunnelMetadata,
  sponsoredDesktopSurfaceMatchesOs,
  sponsoredExecutionContainment,
  sponsoredWindowsExecutionCapable,
  sponsoredWindowsSwitchState,
  throttledUnrecognisedSwitchReporter,
} from './sponsored-windows'

describe('FREEBUFF_SPONSORED_WINDOWS (COD-642), switch-only', () => {
  test('absent is the shipped position: closed', () => {
    expect(readSponsoredWindowsPolicy({})).toBeNull()
    expect(
      readSponsoredWindowsPolicy({ FREEBUFF_SPONSORED_WINDOWS: undefined }),
    ).toBeNull()
  })

  test('the exact value `on` opens it, with no campaign list to go with it', () => {
    const policy = readSponsoredWindowsPolicy({
      FREEBUFF_SPONSORED_WINDOWS: 'on',
    })
    expect(policy).toBe(SPONSORED_WINDOWS_ON)
    expect(policy).toEqual({ switch: 'on' })
    expect(Object.isFrozen(policy)).toBe(true)
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
      // Review nit on #3863: surrounding whitespace used to be trimmed, so
      // ` on ` opened Windows. It no longer does -- `on` means `on`.
      ' on ',
      'on ',
      ' on',
      '\ton',
    ]) {
      expect(
        readSponsoredWindowsPolicy({ FREEBUFF_SPONSORED_WINDOWS: value }),
      ).toBeNull()
    }
  })

  test('off, empty and unset read as off; anything else is unrecognised', () => {
    expect(sponsoredWindowsSwitchState(undefined)).toBe('off')
    expect(sponsoredWindowsSwitchState('')).toBe('off')
    expect(sponsoredWindowsSwitchState('off')).toBe('off')
    expect(sponsoredWindowsSwitchState('on')).toBe('on')
    for (const value of [' on ', 'ON', 'true', 'of', '  '])
      expect(sponsoredWindowsSwitchState(value)).toBe('unrecognised')
  })

  test('an unrecognised value is reported; on, off and unset are not', () => {
    const reported: string[] = []
    const onUnrecognised = (value: string) => reported.push(value)
    for (const value of [undefined, '', 'off', 'on'])
      readSponsoredWindowsPolicy(
        { FREEBUFF_SPONSORED_WINDOWS: value },
        { onUnrecognised },
      )
    expect(reported).toEqual([])
    expect(
      readSponsoredWindowsPolicy(
        { FREEBUFF_SPONSORED_WINDOWS: ' on ' },
        { onUnrecognised },
      ),
    ).toBeNull()
    expect(reported).toEqual([' on '])
  })
})

describe('throttledUnrecognisedSwitchReporter', () => {
  test('reports a value once per interval, and again when it changes', () => {
    let now = 0
    const lines: string[] = []
    const report = throttledUnrecognisedSwitchReporter(
      (quoted) => lines.push(quoted),
      { intervalMs: 1_000, now: () => now },
    )
    report('ON')
    report('ON')
    now = 999
    report('ON')
    expect(lines).toEqual(['"ON"'])
    report(' on ')
    expect(lines).toEqual(['"ON"', '" on "'])
    now = 2_500
    report(' on ')
    expect(lines).toEqual(['"ON"', '" on "', '" on "'])
  })

  test('quotes and bounds the value, so whitespace is visible and nothing long is logged', () => {
    const lines: string[] = []
    const report = throttledUnrecognisedSwitchReporter((quoted) =>
      lines.push(quoted),
    )
    report(`x${'y'.repeat(100)}`)
    expect(lines[0]).toBe(JSON.stringify(`x${'y'.repeat(31)}`))
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

describe('Windows execution capability (review finding 1)', () => {
  const capability = (execution: {
    surface: string
    status: string
    reason?: string
  }) => ({ execution })

  test('only a desktop_windows capability reporting available proves it', () => {
    expect(
      sponsoredWindowsExecutionCapable(
        capability({ surface: 'desktop_windows', status: 'available' }),
      ),
    ).toBe(true)
  })

  test('released Windows builds send none, and nothing else stands in for it', () => {
    for (const value of [
      null,
      undefined,
      capability({
        surface: 'desktop_windows',
        status: 'unavailable',
        reason: 'windows_no_containment',
      }),
      capability({
        surface: 'desktop_windows',
        status: 'available',
        reason: 'inspection_failed',
      }),
      capability({ surface: 'desktop_macos', status: 'available' }),
      capability({ surface: 'desktop_linux', status: 'available' }),
    ])
      expect(sponsoredWindowsExecutionCapable(value)).toBe(false)
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

  test('the accepted funnel row metadata is one shape for both producers (review finding 3)', () => {
    expect(sponsoredContainmentFunnelMetadata('floor')).toEqual({
      execution_surface: 'desktop_windows',
      containment: 'floor',
    })
    for (const value of [null, undefined, '', 'sandbox', 'FLOOR'])
      expect(sponsoredContainmentFunnelMetadata(value)).toBeNull()
  })
})
