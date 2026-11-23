import { expect, test } from 'bun:test'
import { messageSentSurface, mobileClientPlatform, phoneUserAgent, workspaceClientPlatform } from '../client-platform'

test('only ios and android are native platforms; anything else stays unknown', () => {
  expect(mobileClientPlatform('ios')).toBe('ios')
  expect(mobileClientPlatform('android')).toBe('android')
  for (const value of [undefined, null, '', 'browser', 'desktop', 'ios, android', {}, 1]) {
    expect(mobileClientPlatform(value)).toBeUndefined()
  }
})

test('a native send reports its platform as the surface; any other keeps its own', () => {
  expect(messageSentSurface('chat', 'ios')).toBe('ios')
  expect(messageSentSurface('desktop', 'android')).toBe('android')
  expect(messageSentSurface('cloud', 'desktop')).toBe('cloud')
  expect(messageSentSurface('web', undefined)).toBe('web')
})

test('workspace attribution accepts explicit desktop without changing mobile-only callers', () => {
  expect(workspaceClientPlatform('desktop')).toBe('desktop')
  expect(workspaceClientPlatform('ios')).toBe('ios')
  expect(workspaceClientPlatform('android')).toBe('android')
  for (const value of [undefined, null, 'Electron', 'web', 'desktop,ios', {}])
    expect(workspaceClientPlatform(value)).toBeUndefined()
})

test('a phone is the iOS app, the Android app or a phone browser; Desktop, Macs and iPads are not', () => {
  for (const ua of [
    'Freebuff/17 CFNetwork/3826.500.131 Darwin/24.4.0',
    'okhttp/4.12.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  ])
    expect(phoneUserAgent(ua)).toBe(true)
  for (const ua of [
    undefined,
    null,
    '',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Freebuff/0.0.212 Chrome/138.0.0.0 Electron/37.2.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  ])
    expect(phoneUserAgent(ua)).toBe(false)
})
