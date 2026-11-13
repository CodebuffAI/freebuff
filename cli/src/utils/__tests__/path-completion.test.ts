import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

import { getPathCompletion } from '../path-completion'

function twoDirectoryTempDir(): string {
  const base = mkdtempSync(path.join(tmpdir(), 'path-completion-'))
  mkdirSync(path.join(base, 'alpha'))
  mkdirSync(path.join(base, 'alpine'))
  return base
}

describe('getPathCompletion', () => {
  test('lists inside a directory whose path ends in the native separator', () => {
    const base = twoDirectoryTempDir()
    expect(getPathCompletion(base + path.sep)).toBe(path.join(base, 'alp'))
  })

  const testOnWindows = process.platform === 'win32' ? test : test.skip

  testOnWindows(
    'treats a forward slash as a directory separator on Windows',
    () => {
      // before this, `C:/Users/foo/` was read as the partial name `foo` in
      // `C:/Users`, so tab completion returned the directory already typed
      const base = twoDirectoryTempDir()
      const forward = base.replaceAll(path.sep, '/')
      expect(getPathCompletion(forward + '/')).toBe(path.join(base, 'alp'))
    },
  )
})
