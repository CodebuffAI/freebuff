import { describe, test, expect } from 'bun:test'

// NOTE: deliberately no mock.module here — bun module mocks are process-wide
// and leak into other test files (e.g. stubbing utils/auth broke the
// credentials-storage integration tests in CI). The chat id helpers below
// never touch the config dir, so the real imports are safe.
import {
  getCurrentChatId,
  setCurrentChatId,
  startNewChat,
  setProjectRoot,
  getProjectDataDir,
} from '../project-files'
import { getConfigDir } from '../utils/config-dir'

describe('chat id lifecycle', () => {
  test('getCurrentChatId is stable across calls', () => {
    const first = getCurrentChatId()
    expect(getCurrentChatId()).toBe(first)
  })

  test('setCurrentChatId overrides the current chat id', () => {
    setCurrentChatId('resumed-chat-id')
    expect(getCurrentChatId()).toBe('resumed-chat-id')
  })

  test('startNewChat rotates to a fresh chat id', () => {
    setCurrentChatId('old-chat-id')

    const rotated = startNewChat()

    expect(rotated).not.toBe('old-chat-id')
    expect(getCurrentChatId()).toBe(rotated)
    // New ids are filesystem-safe ISO timestamps
    expect(rotated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/)
  })
})

describe('getProjectDataDir', () => {
  test('returns a path containing the project basename', () => {
    setProjectRoot('/tmp/my-project')
    const dataDir = getProjectDataDir()
    expect(dataDir).toContain('my-project')
    expect(dataDir).toContain('projects')
  })

  test('uses config-dir getConfigDir (not auth re-export)', () => {
    setProjectRoot('/tmp/test-repo')
    const dataDir = getProjectDataDir()
    // Should resolve via config-dir's getConfigDir without pulling in auth.ts
    const configDir = getConfigDir()
    expect(dataDir).toContain(configDir)
  })
})
