import { describe, expect, test } from 'bun:test'

import {
  readSponsoredOsPolicy,
  SPONSORED_OS_ON,
  SPONSORED_OS_SWITCHES,
  sponsoredOsExecutionCapable,
  sponsoredOsSwitchState,
  sponsoredSwitchedOs,
  sponsoredSwitchedOsForSurface,
} from './sponsored-os-policy'
import {
  readSponsoredWindowsPolicy,
  SPONSORED_WINDOWS_EXECUTION_SURFACE,
  SPONSORED_WINDOWS_ON,
  sponsoredWindowsExecutionCapable,
  sponsoredWindowsSwitchState,
} from './sponsored-windows'

const CLOSED = ['off', 'ON', 'On', 'true', '1', 'garbage', '', ' on ', 'on ']

describe('per-OS switches (COD-642 Windows, COD-655 Linux)', () => {
  test('one table: each switched OS names its own env knob and Desktop surface', () => {
    expect(SPONSORED_OS_SWITCHES).toEqual({
      windows: {
        env: 'FREEBUFF_SPONSORED_WINDOWS',
        surface: 'desktop_windows',
      },
      linux: { env: 'FREEBUFF_SPONSORED_LINUX', surface: 'desktop_linux' },
    })
  })

  test.each(['windows', 'linux'] as const)(
    '%s: only the exact value `on` opens it, and each switch reads only its own knob',
    (os) => {
      const name = SPONSORED_OS_SWITCHES[os].env
      const other = os === 'windows' ? 'linux' : 'windows'
      expect(readSponsoredOsPolicy(os, {})).toBeNull()
      expect(readSponsoredOsPolicy(os, { [name]: 'on' })).toBe(SPONSORED_OS_ON)
      for (const value of CLOSED)
        expect(readSponsoredOsPolicy(os, { [name]: value })).toBeNull()
      expect(
        readSponsoredOsPolicy(os, {
          [SPONSORED_OS_SWITCHES[other].env]: 'on',
        }),
      ).toBeNull()
    },
  )

  test('an unrecognised value is reported; unset, empty and off are not', () => {
    const seen: string[] = []
    const onUnrecognised = (value: string) => seen.push(value)
    for (const value of [undefined, '', 'off', 'on'])
      readSponsoredOsPolicy(
        'linux',
        { FREEBUFF_SPONSORED_LINUX: value },
        { onUnrecognised },
      )
    expect(seen).toEqual([])
    readSponsoredOsPolicy(
      'linux',
      { FREEBUFF_SPONSORED_LINUX: ' on ' },
      { onUnrecognised },
    )
    expect(seen).toEqual([' on '])
  })

  test('the switch state reads the same for every OS', () => {
    expect(sponsoredOsSwitchState(undefined)).toBe('off')
    expect(sponsoredOsSwitchState('off')).toBe('off')
    expect(sponsoredOsSwitchState('on')).toBe('on')
    expect(sponsoredOsSwitchState('ON')).toBe('unrecognised')
  })

  test('the execution capability must name THAT OS’s surface, available, with no reason', () => {
    const capability = (surface: string, status = 'available', reason?: string) => ({
      execution: { surface, status, ...(reason ? { reason } : {}) },
    })
    expect(sponsoredOsExecutionCapable('linux', capability('desktop_linux'))).toBe(true)
    expect(
      sponsoredOsExecutionCapable('windows', capability('desktop_windows')),
    ).toBe(true)
    for (const bad of [
      null,
      undefined,
      capability('desktop_macos'),
      capability('desktop_windows'),
      capability('cli_linux'),
      capability('desktop_linux', 'unavailable', 'bubblewrap_missing'),
      capability('desktop_linux', 'available', 'bubblewrap_missing'),
    ])
      expect(sponsoredOsExecutionCapable('linux', bad)).toBe(false)
  })

  test('a reported OS and a row surface map to the same switched OS; macOS and CLI to none', () => {
    expect(sponsoredSwitchedOs('windows')).toBe('windows')
    expect(sponsoredSwitchedOs('linux')).toBe('linux')
    for (const os of ['macos', null, undefined, 'Linux', 'wsl'])
      expect(sponsoredSwitchedOs(os)).toBeNull()
    expect(sponsoredSwitchedOsForSurface('desktop_windows')).toBe('windows')
    expect(sponsoredSwitchedOsForSurface('desktop_linux')).toBe('linux')
    for (const surface of ['desktop_macos', 'cli_linux', 'cli_wsl', null, undefined])
      expect(sponsoredSwitchedOsForSurface(surface)).toBeNull()
  })
})

describe('the Windows names are views of the per-OS policy, unchanged', () => {
  test('reader, state, constants and capability agree with the generic ones', () => {
    for (const value of [undefined, 'on', ...CLOSED]) {
      expect(
        readSponsoredWindowsPolicy({ FREEBUFF_SPONSORED_WINDOWS: value }),
      ).toBe(
        readSponsoredOsPolicy('windows', { FREEBUFF_SPONSORED_WINDOWS: value }),
      )
      expect(sponsoredWindowsSwitchState(value)).toBe(
        sponsoredOsSwitchState(value),
      )
    }
    expect(SPONSORED_WINDOWS_ON).toBe(SPONSORED_OS_ON)
    expect(SPONSORED_WINDOWS_EXECUTION_SURFACE).toBe('desktop_windows')
    const windows = {
      execution: { surface: 'desktop_windows', status: 'available' },
    }
    expect(sponsoredWindowsExecutionCapable(windows)).toBe(true)
    expect(
      sponsoredWindowsExecutionCapable({
        execution: { surface: 'desktop_linux', status: 'available' },
      }),
    ).toBe(false)
  })
})
