import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, test } from 'bun:test'

import { ensureCliTestEnv } from './test-utils'

ensureCliTestEnv()

const { getMostRecentChatDir, setProjectRoot } = await import(
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

describe('getMostRecentChatDir', () => {
  test('skips the newer directory this launch created for its log', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-recent-chat-'))
    const project = path.join(tempRoot, 'my-project')
    fs.mkdirSync(project)
    process.env.FREEBUFF_CONFIG_DIR = path.join(tempRoot, 'config')
    setProjectRoot(project)
    const chats = path.join(tempRoot, 'config', 'projects', 'my-project', 'chats')

    const saved = path.join(chats, '2026-11-23T21-36-17.439Z')
    fs.mkdirSync(saved, { recursive: true })
    fs.writeFileSync(path.join(saved, 'run-state.json'), '{}')
    fs.writeFileSync(path.join(saved, 'chat-messages.json'), '[]')
    const past = new Date(Date.now() - 60_000)
    for (const file of ['run-state.json', 'chat-messages.json']) {
      fs.utimesSync(path.join(saved, file), past, past)
    }

    const thisLaunch = path.join(chats, '2026-11-23T21-45-33.231Z')
    fs.mkdirSync(thisLaunch, { recursive: true })
    fs.writeFileSync(path.join(thisLaunch, 'log.jsonl'), '')

    expect(getMostRecentChatDir()).toBe(saved)
  })
})
