import os from 'os'
import path from 'path'

import { afterEach, describe, expect, test } from 'bun:test'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const { getConfigDir } = await import('../config-dir')

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
