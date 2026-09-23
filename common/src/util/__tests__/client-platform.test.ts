import { expect, test } from 'bun:test'
import { clientPlatformProperties } from '../client-platform'

test('mobile attribution is per request and missing/invalid origins stay unknown', () => {
  expect(clientPlatformProperties('ios')).toEqual({ client_platform: 'ios' })
  expect(clientPlatformProperties('android')).toEqual({ client_platform: 'android' })
  for (const value of [undefined, null, '', 'browser', 'ios, android', {}, 1]) {
    expect(clientPlatformProperties(value)).toEqual({})
  }
  expect(clientPlatformProperties('ios')).toEqual({ client_platform: 'ios' })
})
