import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import path from 'path'

import { formatCwd, getRelativePath } from '../path-helpers'
import { setProjectRoot, tryGetProjectRoot } from '../../project-files'

import type { CliEnv } from '../../types/env'

describe('formatCwd', () => {
  test('returns empty string for undefined input', () => {
    expect(formatCwd(undefined)).toBe('')
  })

  test('replaces the home directory prefix with ~', () => {
    const env = { HOME: '/Users/foo' } as CliEnv
    expect(formatCwd('/Users/foo/project/src', env)).toBe('~/project/src')
  })

  test('leaves a path outside the home directory unchanged', () => {
    const env = { HOME: '/Users/foo' } as CliEnv
    expect(formatCwd('/opt/other/project', env)).toBe('/opt/other/project')
  })

  test('falls back to USERPROFILE when HOME is unset', () => {
    const env = { USERPROFILE: 'C:\\Users\\foo' } as CliEnv
    expect(formatCwd('C:\\Users\\foo\\project', env)).toBe(
      '~\\project',
    )
  })
})

describe('getRelativePath', () => {
  let originalProjectRoot: string | undefined

  beforeEach(() => {
    originalProjectRoot = tryGetProjectRoot()
  })

  afterEach(() => {
    if (originalProjectRoot !== undefined) {
      setProjectRoot(originalProjectRoot)
    }
  })

  test('returns an already-relative path unchanged, without consulting the project root', () => {
    expect(getRelativePath('src/utils/helper.ts')).toBe('src/utils/helper.ts')
  })

  test('resolves an absolute path relative to the project root when one is set', () => {
    setProjectRoot('/Users/foo/project')
    expect(getRelativePath('/Users/foo/project/src/utils/helper.ts')).toBe(
      path.join('src', 'utils', 'helper.ts'),
    )
  })

  test('falls back to returning the absolute path as-is when the project root is unavailable', () => {
    // Simulate "unset": setProjectRoot only accepts a string, so an empty
    // string is used as the falsy sentinel (matches how tryGetProjectRoot's
    // callers already treat it, see project-files.ts).
    setProjectRoot('')
    expect(getRelativePath('/Users/foo/project/src/utils/helper.ts')).toBe(
      '/Users/foo/project/src/utils/helper.ts',
    )
  })
})
