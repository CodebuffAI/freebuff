import { describe, expect, test } from 'bun:test'

import {
  FREEBUCKS_TIMEZONE_HEADER,
  freebucksDeviceTimeZone,
  freebucksTimeZoneHeaders,
  isNonGeographicFreebucksTimeZone,
} from '../freebucks-timezone'

const local = { platform: 'darwin', env: {} }

describe('freebucksDeviceTimeZone', () => {
  test('reports the zone the runtime resolved', () => {
    expect(freebucksDeviceTimeZone({ ...local, zone: 'Africa/Lagos' })).toBe(
      'Africa/Lagos',
    )
    expect(
      freebucksDeviceTimeZone({ ...local, zone: 'America/New_York' }),
    ).toBe('America/New_York')
  })

  test('omits a zone the runtime could not tell, never falling back to UTC', () => {
    expect(freebucksDeviceTimeZone({ ...local, zone: undefined })).toBeNull()
    expect(freebucksDeviceTimeZone({ ...local, zone: '' })).toBeNull()
    expect(freebucksDeviceTimeZone({ ...local, zone: 'Etc/Unknown' })).toBeNull()
  })

  test('keeps UTC on a local machine that is set to UTC', () => {
    expect(freebucksDeviceTimeZone({ ...local, zone: 'UTC' })).toBe('UTC')
    expect(
      freebucksDeviceTimeZone({ ...local, zone: 'UTC', env: { TZ: 'UTC' } }),
    ).toBe('UTC')
    expect(
      freebucksDeviceTimeZone({ ...local, zone: 'UTC', env: { TZ: ':Etc/UTC' } }),
    ).toBe('UTC')
  })

  // Bun answers UTC for every TZ it cannot parse, whatever the OS zone is.
  test.each(['', 'GMT-1', 'UTC+3', ':/etc/localtime', 'Not/AZone'])(
    'omits the UTC Bun falls back to under TZ=%p',
    (tz) => {
      expect(
        freebucksDeviceTimeZone({ ...local, zone: 'UTC', env: { TZ: tz } }),
      ).toBeNull()
    },
  )

  test('a parsed TZ still reports its zone', () => {
    expect(
      freebucksDeviceTimeZone({
        ...local,
        zone: 'Asia/Calcutta',
        env: { TZ: 'Asia/Kolkata' },
      }),
    ).toBe('Asia/Calcutta')
  })

  test.each([
    { SSH_CONNECTION: '203.0.113.5 50000 198.51.100.7 22' },
    { SSH_CLIENT: '203.0.113.5 50000 22' },
    { SSH_TTY: '/dev/pts/0' },
    { CODESPACES: 'true' },
    { REMOTE_CONTAINERS: 'true' },
    { GITPOD_WORKSPACE_ID: 'ws-1' },
    { container: 'podman' },
  ])('omits a remote host default UTC (%p)', (env) => {
    expect(
      freebucksDeviceTimeZone({ platform: 'linux', zone: 'UTC', env }),
    ).toBeNull()
    expect(
      freebucksDeviceTimeZone({ platform: 'linux', zone: 'Etc/UTC', env }),
    ).toBeNull()
  })

  test('a remote host configured to a real zone still reports it', () => {
    expect(
      freebucksDeviceTimeZone({
        platform: 'linux',
        zone: 'Asia/Tokyo',
        env: { SSH_CONNECTION: '203.0.113.5 50000 198.51.100.7 22' },
      }),
    ).toBe('Asia/Tokyo')
  })

  test('omits the fixed offset Windows reports with DST adjustment off', () => {
    for (const zone of ['Etc/GMT-1', 'Etc/GMT+8', 'Etc/GMT-12']) {
      expect(
        freebucksDeviceTimeZone({ platform: 'win32', zone, env: {} }),
      ).toBeNull()
    }
    // Elsewhere an Etc zone is what the user configured.
    expect(
      freebucksDeviceTimeZone({ platform: 'linux', zone: 'Etc/GMT-1', env: {} }),
    ).toBe('Etc/GMT-1')
    expect(
      freebucksDeviceTimeZone({
        platform: 'win32',
        zone: 'Europe/Budapest',
        env: {},
      }),
    ).toBe('Europe/Budapest')
  })

  test('a browser (no process) reports what Intl resolved', () => {
    expect(freebucksDeviceTimeZone({ zone: 'Europe/Berlin' })).toBe(
      'Europe/Berlin',
    )
    expect(freebucksDeviceTimeZone({ zone: 'UTC' })).toBe('UTC')
  })
})

describe('freebucksTimeZoneHeaders', () => {
  test('sends the reported zone', () => {
    expect(
      freebucksTimeZoneHeaders({ ...local, zone: 'Asia/Tehran' }),
    ).toEqual({ [FREEBUCKS_TIMEZONE_HEADER]: 'Asia/Tehran' })
  })

  test('omits the header when the zone is unknown', () => {
    expect(freebucksTimeZoneHeaders({ ...local, zone: 'Etc/Unknown' })).toEqual(
      {},
    )
    expect(
      freebucksTimeZoneHeaders({
        platform: 'linux',
        zone: 'UTC',
        env: { SSH_TTY: '/dev/pts/1' },
      }),
    ).toEqual({})
  })

  test('defaults to this process', () => {
    const header = freebucksTimeZoneHeaders()[FREEBUCKS_TIMEZONE_HEADER]
    if (header !== undefined) {
      expect(header).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    }
  })
})

describe('isNonGeographicFreebucksTimeZone', () => {
  test.each([
    'UTC',
    'Etc/UTC',
    'GMT',
    'Zulu',
    'Etc/GMT-1',
    'Etc/GMT+12',
    'Etc/Unknown',
  ])('%s names no place', (zone) =>
    expect(isNonGeographicFreebucksTimeZone(zone)).toBe(true),
  )

  test.each([
    'Europe/London',
    'Africa/Abidjan',
    'Asia/Tehran',
    'America/New_York',
  ])('%s names a place, even at UTC+0', (zone) =>
    expect(isNonGeographicFreebucksTimeZone(zone)).toBe(false),
  )
})
