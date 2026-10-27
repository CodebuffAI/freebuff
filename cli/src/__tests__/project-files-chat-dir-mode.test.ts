import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, test } from 'bun:test'

import { ensureCliTestEnv } from './test-utils'

ensureCliTestEnv()

const { getCurrentChatDir, setCurrentChatId, setProjectRoot } = await import(
  '../project-files'
)

const originalConfigDir = process.env.FREEBUFF_CONFIG_DIR
let tempRoot = ''

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env.FREEBUFF_CONFIG_DIR
  } else {
    process.env.FREEBUFF_CONFIG_DIR = originalConfigDir
  }
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

// POSIX mode bits only; Windows has no owner/group/other split to assert.
describe.skipIf(process.platform === 'win32')('chat directory mode', () => {
  test('creates the chat directory and its parents owner-only', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-chat-dir-mode-'))
    const configDir = path.join(tempRoot, 'config')
    const project = path.join(tempRoot, 'my-project')
    // Not a git repo, so setProjectRoot writes no project marker.
    fs.mkdirSync(project)
    process.env.FREEBUFF_CONFIG_DIR = configDir
    setProjectRoot(project)
    setCurrentChatId('2026-10-26T00-00-00.000Z')

    const chatDir = getCurrentChatDir()

    expect(chatDir.startsWith(configDir)).toBe(true)
    for (
      let dir = chatDir;
      dir.length >= configDir.length;
      dir = path.dirname(dir)
    ) {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    }
  })
})
