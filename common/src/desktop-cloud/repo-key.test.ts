import { describe, expect, test } from 'bun:test'

import { repoKey, repoKeyFromRemote } from './repo-key'

describe('repoKeyFromRemote', () => {
  test('SSH and HTTPS spellings of one remote agree', () => {
    const expected = 'github.com/owner/repo'
    expect(repoKeyFromRemote('git@github.com:Owner/Repo.git')).toBe(expected)
    expect(repoKeyFromRemote('https://github.com/owner/repo')).toBe(expected)
    expect(repoKeyFromRemote('https://user:token@github.com/owner/repo.git/')).toBe(expected)
    expect(repoKeyFromRemote('ssh://git@github.com:22/owner/repo.git')).toBe(expected)
  })

  test('keeps the host and every path segment', () => {
    expect(repoKeyFromRemote('git@gitlab.com:group/sub/repo.git')).toBe('gitlab.com/group/sub/repo')
    expect(repoKeyFromRemote('git@gitlab.com:owner/repo.git')).not.toBe(repoKeyFromRemote('git@github.com:owner/repo.git'))
  })

  test('a path or file remote has no key', () => {
    expect(repoKeyFromRemote('/home/me/code/repo')).toBeNull()
    expect(repoKeyFromRemote('file:///home/me/code/repo')).toBeNull()
    expect(repoKeyFromRemote('C:\\code\\repo')).toBeNull()
    expect(repoKeyFromRemote('https://github.com/owner')).toBeNull()
    expect(repoKeyFromRemote('')).toBeNull()
  })
})

describe('repoKey', () => {
  test('a subfolder keys separately from the root', () => {
    expect(repoKey('github.com/o/r', '')).toBe('github.com/o/r')
    expect(repoKey('github.com/o/r', 'packages/web')).toBe('github.com/o/r:packages/web')
    expect(repoKey('github.com/o/r', 'packages\\web\\')).toBe('github.com/o/r:packages/web')
  })
})
