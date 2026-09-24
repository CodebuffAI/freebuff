import path from 'path'

import { describe, expect, test } from 'bun:test'

import { projectProfileSurface, resolveProjectKey } from '../project-profile'

const missing = async () => {
  throw new Error('ENOENT')
}

describe('resolveProjectKey', () => {
  test('uses an explicit key as is', async () => {
    expect(
      await resolveProjectKey({
        projectKey: 'web:abc',
        cwd: '/repo',
        readFile: missing,
      }),
    ).toBe('web:abc')
  })

  test('hashes the project root and never exposes the path', async () => {
    const key = await resolveProjectKey({
      cwd: '/Users/me/repo',
      readFile: missing,
    })
    expect(key).toMatch(/^local:[0-9a-f]{32}$/)
    expect(key).not.toContain('repo')
  })

  test('gives a worktree the key of its main repository', async () => {
    const main = await resolveProjectKey({
      cwd: '/Users/me/repo',
      readFile: missing,
    })
    const worktree = await resolveProjectKey({
      cwd: '/Users/me/worktrees/feature',
      readFile: async (filePath) => {
        expect(filePath).toBe(path.join('/Users/me/worktrees/feature', '.git'))
        return 'gitdir: /Users/me/repo/.git/worktrees/feature\n'
      },
    })
    expect(worktree).toBe(main)
  })

  test('returns nothing without a key or cwd', async () => {
    expect(await resolveProjectKey({ readFile: missing })).toBeUndefined()
  })
})

describe('projectProfileSurface', () => {
  test('reads the surface the host already reports', () => {
    expect(projectProfileSurface({ surface: 'cloud' })).toBe('cloud')
    expect(projectProfileSurface({ freebuff_multi_session: '1' })).toBe(
      'desktop',
    )
    expect(projectProfileSurface(undefined)).toBe('cli')
  })
})
