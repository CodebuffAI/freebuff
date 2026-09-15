import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sponsoredCliCapability } from '../sponsored-cli-capability'

import type { GitRunner } from '../sponsored-worktree'
import type { SponsoredLocalContainment } from '@codebuff/common/ads/sponsored-local-execution'

const roots: string[] = []
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
)

function project(pkg: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'cli-sponsored-capability-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
  return root
}

function git(
  options: { remote?: string; head?: boolean; files?: string[] } = {},
): GitRunner {
  return async (args) => {
    if (args.includes('--is-inside-work-tree'))
      return { exitCode: 0, stdout: 'true\n', stderr: '' }
    if (args.includes('remote'))
      return options.remote === undefined
        ? { exitCode: 2, stdout: '', stderr: '' }
        : { exitCode: 0, stdout: `${options.remote}\n`, stderr: '' }
    if (args.includes('ls-files'))
      return {
        exitCode: 0,
        stdout: (options.files ?? ['package.json']).join('\n'),
        stderr: '',
      }
    if (args.includes('HEAD^{commit}'))
      return options.head === false
        ? { exitCode: 1, stdout: '', stderr: '' }
        : { exitCode: 0, stdout: 'abc\n', stderr: '' }
    throw new Error(`unexpected ${args.join(' ')}`)
  }
}

const mac = (): SponsoredLocalContainment => ({
  available: true,
  mechanism: 'sandbox-exec',
})
const linux = (): SponsoredLocalContainment => ({
  available: true,
  mechanism: 'bubblewrap',
})

describe('sponsoredCliCapability', () => {
  test('reports only v2-safe facts for a remote Next.js project', async () => {
    const root = project({
      packageManager: 'bun@1.3.0',
      dependencies: { next: '16.0.0', '@supabase/ssr': '1.0.0' },
      secret: 'local-only',
    })
    const result = await sponsoredCliCapability(
      root,
      git({
        remote: 'git@github.com:acme/app.git',
        files: ['package.json', 'bun.lock', 'supabase/migrations/1.sql'],
      }),
      'darwin',
      mac,
    )
    expect(result).toEqual({
      sponsoredCapability: {
        schemaVersion: 2,
        target: { kind: 'repo', repoFullName: 'acme/app' },
        framework: 'nextjs',
        packageManager: 'bun',
        hasSupabaseBoundary: true,
        hasCommittedDatabaseBoundary: true,
        hasGitRepository: true,
        hasCommittedHead: true,
        execution: { surface: 'cli_macos', status: 'available' },
      },
      capabilityInspection: { status: 'available' },
    })
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain('local-only')
  })

  test('uses an existing UUID marker for a no-remote project without creating one', async () => {
    const root = project({ dependencies: { vite: '6.0.0', react: '19.0.0' } })
    mkdirSync(join(root, '.freebuff'))
    writeFileSync(
      join(root, '.freebuff', 'project-id'),
      '00000000-0000-4000-8000-000000000000\n',
    )
    const result = await sponsoredCliCapability(root, git(), 'linux', linux)
    expect(result.sponsoredCapability).toMatchObject({
      target: {
        kind: 'workspace',
        workspaceId: '00000000-0000-4000-8000-000000000000',
      },
      framework: 'react-vite',
      execution: { surface: 'cli_linux', status: 'available' },
    })
  })

  test('refuses before an offer when the source or containment is not actionable', async () => {
    const root = project({ dependencies: { express: '5.0.0' } })
    const head = await sponsoredCliCapability(
      root,
      git({ remote: 'https://github.com/acme/api.git', head: false }),
      'darwin',
      mac,
    )
    const windows = await sponsoredCliCapability(root, git(), 'win32', mac)
    expect(head.capabilityInspection).toEqual({
      status: 'unavailable',
      reason: 'no_committed_head',
    })
    expect(windows.capabilityInspection).toEqual({
      status: 'unavailable',
      reason: 'windows_no_containment',
    })
  })

  test('does not mislabel Vue or Svelte Vite projects as React or Node', async () => {
    const root = project({ dependencies: { vite: '6.0.0', vue: '3.0.0' } })
    const result = await sponsoredCliCapability(
      root,
      git({ remote: 'https://github.com/acme/vue.git' }),
      'darwin',
      mac,
    )
    expect(result.sponsoredCapability?.framework).toBe('unsupported')
  })
})
