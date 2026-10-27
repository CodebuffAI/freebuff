import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  getMessageHistoryPath,
  loadMessageHistory,
  saveMessageHistory,
} from '../message-history'

describe('message history persistence', () => {
  let originalConfigDir: string | undefined
  let tempRoot: string

  // FREEBUFF_CONFIG_DIR, not HOME: os.homedir() ignores $HOME on macOS, so a
  // HOME override sent these writes to the developer's real config dir.
  beforeEach(() => {
    originalConfigDir = process.env.FREEBUFF_CONFIG_DIR
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-message-history-'))
    // Not created yet, so saveMessageHistory creates it.
    process.env.FREEBUFF_CONFIG_DIR = path.join(tempRoot, 'config')
  })

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.FREEBUFF_CONFIG_DIR
    } else {
      process.env.FREEBUFF_CONFIG_DIR = originalConfigDir
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  test('saves and loads history, replacing the previous file whole', () => {
    saveMessageHistory(['previous'])
    const historyPath = getMessageHistoryPath()
    const previous = fs.readFileSync(historyPath, 'utf8')
    let writes = 0
    const duringWrites: string[] = []

    saveMessageHistory(['first', 'second'], {
      ...fs,
      writeFileSync: (file, data, options) => {
        expect(path.dirname(String(file))).toBe(path.dirname(historyPath))
        fs.writeFileSync(file, data, options)
        writes++
        duringWrites.push(fs.readFileSync(historyPath, 'utf8'))
      },
    })

    expect(writes).toBe(1)
    expect(duringWrites).toEqual([previous])
    expect(loadMessageHistory()).toEqual(['first', 'second'])
    expect(fs.readdirSync(path.dirname(historyPath))).toEqual([
      'message-history.json',
    ])
  })

  test('round-trips empty history', () => {
    saveMessageHistory([])
    expect(loadMessageHistory()).toEqual([])
    expect(
      JSON.parse(fs.readFileSync(getMessageHistoryPath(), 'utf8')),
    ).toEqual([])
  })

  test('keeps only the latest 1000 messages', () => {
    const history = Array.from({ length: 1002 }, (_, i) => `message ${i}`)
    saveMessageHistory(history)
    expect(loadMessageHistory()).toEqual(history.slice(-1000))
  })

  test('a partial ENOSPC write preserves prior bytes and removes the temp file', () => {
    saveMessageHistory(['previous'])
    const historyPath = getMessageHistoryPath()
    const previous = fs.readFileSync(historyPath, 'utf8')
    let writes = 0

    expect(() =>
      saveMessageHistory(['replacement'], {
        ...fs,
        writeFileSync: (file) => {
          writes++
          fs.writeFileSync(file, '["partial')
          throw Object.assign(new Error('ENOSPC: no space left on device'), {
            code: 'ENOSPC',
          })
        },
      }),
    ).not.toThrow()

    expect(writes).toBe(1)
    expect(fs.readFileSync(historyPath, 'utf8')).toBe(previous)
    expect(loadMessageHistory()).toEqual(['previous'])
    expect(fs.readdirSync(path.dirname(historyPath))).toEqual([
      'message-history.json',
    ])
  })

  test('a rename failure preserves prior bytes and removes the temp file', () => {
    saveMessageHistory(['previous'])
    const historyPath = getMessageHistoryPath()
    const previous = fs.readFileSync(historyPath, 'utf8')
    let renames = 0

    expect(() =>
      saveMessageHistory(['replacement'], {
        ...fs,
        renameSync: () => {
          renames++
          throw Object.assign(new Error('EACCES: permission denied'), {
            code: 'EACCES',
          })
        },
      }),
    ).not.toThrow()

    expect(renames).toBe(1)
    expect(fs.readFileSync(historyPath, 'utf8')).toBe(previous)
    expect(fs.readdirSync(path.dirname(historyPath))).toEqual([
      'message-history.json',
    ])
  })

  test.skipIf(process.platform === 'win32')(
    'writes history owner-only and creates the config dir owner-only',
    () => {
      saveMessageHistory(['a private prompt'])
      const historyPath = getMessageHistoryPath()

      expect(fs.statSync(historyPath).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(historyPath)).mode & 0o777).toBe(0o700)
    },
  )
})
