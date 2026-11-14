import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, test } from 'bun:test'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const { getConfigDir, tightenConfigDirMode } = await import('../config-dir')

const originalConfigDir = process.env.FREEBUFF_CONFIG_DIR

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env.FREEBUFF_CONFIG_DIR
  } else {
    process.env.FREEBUFF_CONFIG_DIR = originalConfigDir
  }
})

describe('getConfigDir', () => {
  test('uses an absolute FREEBUFF_CONFIG_DIR override', () => {
    const isolatedDir = path.join(os.tmpdir(), 'freebuff-cli-config-test')
    process.env.FREEBUFF_CONFIG_DIR = isolatedDir

    expect(getConfigDir()).toBe(isolatedDir)
  })

  test('rejects a relative FREEBUFF_CONFIG_DIR override', () => {
    process.env.FREEBUFF_CONFIG_DIR = 'relative-settings'

    expect(() => getConfigDir()).toThrow(
      'FREEBUFF_CONFIG_DIR must be an absolute path',
    )
  })
})

describe.skipIf(process.platform === 'win32')('tightenConfigDirMode', () => {
  let tempRoot = ''

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = ''
  })

  test('clamps an existing world-readable config dir to 0700', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-config-mode-'))
    const configDir = path.join(tempRoot, 'manicode')
    fs.mkdirSync(configDir)
    fs.chmodSync(configDir, 0o755)
    process.env.FREEBUFF_CONFIG_DIR = configDir

    tightenConfigDirMode()

    expect(fs.statSync(configDir).mode & 0o777).toBe(0o700)
  })

  test('does not create a missing config dir', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-config-mode-'))
    const configDir = path.join(tempRoot, 'missing')

    tightenConfigDirMode(configDir)

    expect(fs.existsSync(configDir)).toBe(false)
  })

  test('never throws, even when the config dir cannot be resolved', () => {
    process.env.FREEBUFF_CONFIG_DIR = 'relative-settings'

    expect(() => tightenConfigDirMode()).not.toThrow()
  })
})
