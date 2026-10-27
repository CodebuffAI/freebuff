import { expect, test } from 'bun:test'
import { messageSentSurface, mobileClientPlatform, workspaceClientPlatform } from '../client-platform'

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
