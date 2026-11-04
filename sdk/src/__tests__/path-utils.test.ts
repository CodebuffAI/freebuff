import { beforeEach, describe, expect, test } from 'bun:test'

import {
  findFileLookupKey,
  getProjectPathLookupKeys,
  resolveFilePathWithinProject,
} from '../tools/path-utils'
import { resetTranslationCache } from '../tools/windows-bash'

describe('resolveFilePathWithinProject', () => {
  test('normalizes relative paths to full and project-relative paths', () => {
    expect(resolveFilePathWithinProject('/repo', 'src/file.ts')).toEqual({
      fullPath: '/repo/src/file.ts',
      relativePath: 'src/file.ts',
    })
  })

  test('normalizes absolute paths inside the project', () => {
    expect(resolveFilePathWithinProject('/repo', '/repo/src/file.ts')).toEqual({
      fullPath: '/repo/src/file.ts',
      relativePath: 'src/file.ts',
    })
  })

  test('allows file names that start with two dots inside the project', () => {
    expect(resolveFilePathWithinProject('/repo', '/repo/..config')).toEqual({
      fullPath: '/repo/..config',
      relativePath: '..config',
    })
  })

  test('rejects paths outside the project', () => {
    expect(resolveFilePathWithinProject('/repo', '../outside.ts')).toBeNull()
    expect(resolveFilePathWithinProject('/repo', '/outside.ts')).toBeNull()
    expect(
      resolveFilePathWithinProject('/repo', '/repo-sibling/file.ts'),
    ).toBeNull()
  })
})

describe('getProjectPathLookupKeys', () => {
  test('returns the normalized relative key before the original absolute key', () => {
    expect(getProjectPathLookupKeys('/repo', '/repo/src/file.ts')).toEqual([
      'src/file.ts',
      '/repo/src/file.ts',
    ])
  })

  test('dedupes relative paths that are already normalized', () => {
    expect(getProjectPathLookupKeys('/repo', 'src/file.ts')).toEqual([
      'src/file.ts',
    ])
  })

  test('returns only the original key for paths outside the project', () => {
    expect(getProjectPathLookupKeys('/repo', '/outside.ts')).toEqual([
      '/outside.ts',
    ])
  })
})

describe('getProjectPathLookupKeys with Git Bash paths', () => {
  beforeEach(() => {
    resetTranslationCache()
  })

  test('keys an out-of-project MSYS path by its translated path as well', () => {
    expect(
      getProjectPathLookupKeys('/repo', '/tmp/probe.txt', {
        platform: 'win32',
        env: {},
        findBash: () => '/git/bin/bash.exe',
        pathExists: () => true,
        spawnCygpath: () => ({
          status: 0,
          stdout: '/msys-root/tmp/probe.txt\n',
        }),
      }),
    ).toEqual(['/msys-root/tmp/probe.txt', '/tmp/probe.txt'])
  })

  test('translates an MSYS drive path without any bash lookup and keys by the native path', () => {
    expect(
      getProjectPathLookupKeys('/Users/me/repo', '/c/Users/me/repo/src/a.ts', {
        platform: 'win32',
        env: {},
        findBash: () => {
          throw new Error('drive paths must not need bash')
        },
      }),
    ).toEqual(['C:\\Users\\me\\repo\\src\\a.ts', '/c/Users/me/repo/src/a.ts'])
  })
})

describe('findFileLookupKey', () => {
  test('an exact key wins', () => {
    const files = { 'src/a.ts': 'forward', 'src\\a.ts': 'back' }
    expect(findFileLookupKey(files, ['src/a.ts'])).toBe('src/a.ts')
  })

  test('a Windows computer answering a forward-slash read is still found', () => {
    // Cloud computes POSIX keys; Desktop on Windows keys the same file with backslashes.
    const files = { 'src\\game\\store.ts': 'export const store = 1' }
    const keys = getProjectPathLookupKeys('/workspace', 'src/game/store.ts')
    expect(findFileLookupKey(files, keys)).toBe('src\\game\\store.ts')
  })

  test.each([
    'C:\\Users\\me\\proj\\src\\game\\store.ts',
    'C:/Users/me/proj/src/game/store.ts',
    'c:\\users\\me\\proj\\src\\game\\store.ts',
    '/c/Users/me/proj/src/game/store.ts',
  ])(
    'an absolute path into a Windows computer finds its read from Cloud: %s',
    (filePath) => {
      const files = { 'src\\game\\store.ts': 'export const store = 1' }
      const keys = getProjectPathLookupKeys('C:\\Users\\me\\proj', filePath)
      expect(findFileLookupKey(files, keys)).toBe('src\\game\\store.ts')
    },
  )

  test('an absolute path outside a Windows computer project finds nothing', () => {
    const files = { 'src\\a.ts': 'x' }
    for (const filePath of ['C:\\Users\\me\\other\\src\\a.ts', 'D:\\src\\a.ts']) {
      const keys = getProjectPathLookupKeys('C:\\Users\\me\\proj', filePath)
      expect(findFileLookupKey(files, keys)).toBeUndefined()
    }
  })

  test('a different file is never matched', () => {
    expect(
      findFileLookupKey({ 'src\\other.ts': 'x' }, ['src/a.ts']),
    ).toBeUndefined()
    expect(findFileLookupKey({}, ['src/a.ts'])).toBeUndefined()
  })
})
