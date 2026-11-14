import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sponsoredCliCapability } from '../sponsored-cli-capability'
import {
  createTrackedFilesCache,
  indexKey,
  sponsoredGitProbes,
} from '../sponsored-git-probe-cache'

import type { GitResult, GitRunner } from '../sponsored-git'
import type { SponsoredLocalContainment } from '@codebuff/common/ads/sponsored-local-execution'

const roots: string[] = []
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
)

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'cli-git-probe-cache-'))
  roots.push(root)
  return root
}

function run(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function repo(): string {
  const root = tempDir()
  run(root, 'init', '-q', '-b', 'main')
  run(root, 'config', 'user.email', 'test@example.com')
  run(root, 'config', 'user.name', 'Test')
  run(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'package.json'), '{}')
  run(root, 'add', 'package.json')
  run(root, 'commit', '-q', '-m', 'init')
  return root
}

/** Real git, counting each subcommand it is asked. */
function countingGit(): { git: GitRunner; asked: string[] } {
  const asked: string[] = []
  const git: GitRunner = async (args) => {
    asked.push(args.includes('ls-files') ? 'ls-files' : args[2])
    const result = spawnSync('git', args, { encoding: 'utf8' })
    return {
      exitCode: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }
  return { git, asked }
}

const ok = (stdout = ''): GitResult => ({ exitCode: 0, stdout, stderr: '' })
/** A clock past git's racy window, so a just-written index can key the cache. */
const settled = () =>
  createTrackedFilesCache({ now: () => Date.now() + 10_000 })
const lsCount = (asked: string[]) =>
  asked.filter((command) => command === 'ls-files').length

describe('createTrackedFilesCache', () => {
  const answer = (stdout: string, calls: { n: number }) => async () => {
    calls.n++
    return ok(stdout)
  }

  test('reuses an answer only for the same index path and key', async () => {
    const calls = { n: 0 }
    const cache = createTrackedFilesCache()
    const get = (path: string, key: string) =>
      cache.tracked('/repo', path, key, answer(`${calls.n + 1}`, calls))

    expect(get('/i', 'a').hit).toBe(false)
    const hit = get('/i', 'a')
    expect(hit.hit).toBe(true)
    expect((await hit.result).stdout).toBe('1')
    expect(get('/i', 'b').hit).toBe(false)
    expect(get('/other', 'b').hit).toBe(false)
    expect(calls.n).toBe(3)
  })

  test('expires after the TTL, counted from when the answer settled', async () => {
    let time = 0
    const calls = { n: 0 }
    const cache = createTrackedFilesCache({ ttlMs: 1_000, now: () => time })
    const get = () => cache.tracked('/repo', '/i', 'a', answer('x', calls))
    await get().result
    time = 999
    expect(get().hit).toBe(true)
    time = 1_000
    expect(get().hit).toBe(false)
  })

  test('drops an unused answer at its TTL', async () => {
    const calls = { n: 0 }
    const cache = createTrackedFilesCache({ ttlMs: 5 })
    await cache.tracked('/repo', '/i', 'a', answer('x', calls)).result
    await Bun.sleep(20)
    // `now` is real here, so only the timer can have cleared it if the
    // clock check were skipped; both must agree it is gone.
    expect(cache.tracked('/repo', '/i', 'a', answer('x', calls)).hit).toBe(
      false,
    )
  })

  test('shares one in-flight ls-files between concurrent callers', async () => {
    let calls = 0
    const cache = createTrackedFilesCache()
    const slow = async () => {
      calls++
      await Bun.sleep(5)
      return ok()
    }
    await Promise.all([
      cache.tracked('/repo', '/i', 'a', slow).result,
      cache.tracked('/repo', '/i', 'a', slow).result,
    ])
    expect(calls).toBe(1)
  })

  test('never keeps a failed or timed-out git, or a throw', async () => {
    const cache = createTrackedFilesCache()
    // bunGitRunner's timeout kills git: it resolves with 143, not -1.
    for (const exitCode of [143, -1, 128]) {
      await cache.tracked('/repo', '/i', 'a', async () => ({
        exitCode,
        stdout: '',
        stderr: '',
      })).result
      await Bun.sleep(0)
      expect(cache.tracked('/repo', '/i', 'a', async () => ok()).hit).toBe(
        false,
      )
      await Bun.sleep(0)
      cache.rememberIndexPath('/repo', null)
    }
    await cache
      .tracked('/repo', '/i', 'a', async () => {
        throw new Error('boom')
      })
      .result.catch(() => undefined)
    await Bun.sleep(0)
    expect(cache.tracked('/repo', '/i', 'a', async () => ok()).hit).toBe(false)
  })

  test('forgets a root without a work tree, and an answer for a moved index', async () => {
    const cache = createTrackedFilesCache()
    await cache.tracked('/repo', '/i', 'a', async () => ok()).result
    cache.rememberIndexPath('/repo', '/moved')
    expect(cache.indexPath('/repo')).toBe('/moved')
    expect(cache.tracked('/repo', '/i', 'a', async () => ok()).hit).toBe(false)

    cache.rememberIndexPath('/repo', null)
    expect(cache.indexPath('/repo')).toBeUndefined()
  })

  test('evicts the least recently used root, its file list with it', async () => {
    const cache = createTrackedFilesCache()
    await cache.tracked('/hot', '/i', 'a', async () => ok()).result
    for (let i = 0; i < 16; i++) {
      await cache.tracked(`/cold-${i}`, '/i', 'a', async () => ok()).result
      expect(cache.tracked('/hot', '/i', 'a', async () => ok()).hit).toBe(true)
    }
    expect(cache.indexPath('/cold-0')).toBeUndefined()
    expect(cache.tracked('/cold-0', '/i', 'a', async () => ok()).hit).toBe(
      false,
    )
  })
})

describe('indexKey', () => {
  test('is null for a missing index or one written within two seconds', () => {
    const root = repo()
    const index = join(root, '.git', 'index')
    expect(indexKey(join(root, 'missing'), Date.now() + 10_000)).toBeNull()
    expect(indexKey(index, Date.now())).toBeNull()
    expect(indexKey(index, Date.now() + 10_000)).not.toBeNull()
  })
})

describe('sponsoredGitProbes', () => {
  test('asks HEAD and origin live, and ls-files again only when the index changes', async () => {
    const root = repo()
    const { git, asked } = countingGit()
    const cache = settled()

    const first = await sponsoredGitProbes(root, git, cache)
    expect(first.inside.stdout).toBe('true\n')
    expect(first.tracked.stdout).toContain('package.json')
    const second = await sponsoredGitProbes(root, git, cache)
    const third = await sponsoredGitProbes(root, git, cache)
    expect(second.tracked).toEqual(first.tracked)
    expect(third.tracked).toEqual(first.tracked)
    expect(lsCount(asked)).toBe(1)
    expect(asked).toHaveLength(10)

    // A commit that stages nothing still moves HEAD, which is never cached.
    run(root, 'commit', '-q', '--allow-empty', '-m', 'second')
    const moved = await sponsoredGitProbes(root, git, cache)
    expect(moved.head.stdout.trim()).toBe(run(root, 'rev-parse', 'HEAD'))
    expect(moved.head.stdout).not.toBe(first.head.stdout)

    // Not a github.com URL: a global `insteadOf` may rewrite those.
    run(root, 'remote', 'add', 'origin', 'https://example.com/acme/app.git')
    const remote = await sponsoredGitProbes(root, git, cache)
    expect(remote.remote.stdout.trim()).toBe('https://example.com/acme/app.git')

    writeFileSync(join(root, 'new.ts'), 'x')
    run(root, 'add', 'new.ts')
    const staged = await sponsoredGitProbes(root, git, cache)
    expect(staged.tracked.stdout).toContain('new.ts')

    run(root, 'checkout', '-q', '-b', 'other')
    run(root, 'rm', '-q', '--cached', 'new.ts')
    const removed = await sponsoredGitProbes(root, git, cache)
    expect(removed.tracked.stdout).not.toContain('new.ts')
  })

  test('does not reuse an answer for an index written in the last two seconds', async () => {
    const root = repo()
    const { git, asked } = countingGit()
    const cache = createTrackedFilesCache()
    for (let i = 0; i < 3; i++) await sponsoredGitProbes(root, git, cache)
    expect(lsCount(asked)).toBe(3)
  })

  test('keys a linked worktree and a subdirectory on their own answers', async () => {
    const root = repo()
    const linked = join(tempDir(), 'linked')
    run(root, 'worktree', 'add', '-q', '-b', 'other', linked)
    writeFileSync(join(linked, 'only-linked.ts'), 'x')
    run(linked, 'add', 'only-linked.ts')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'a.ts'), 'x')
    run(root, 'add', 'sub/a.ts')

    const { git } = countingGit()
    const cache = settled()
    for (let i = 0; i < 3; i++) {
      const main = await sponsoredGitProbes(root, git, cache)
      const other = await sponsoredGitProbes(linked, git, cache)
      const sub = await sponsoredGitProbes(join(root, 'sub'), git, cache)
      expect(main.tracked.stdout).not.toContain('only-linked.ts')
      expect(other.tracked.stdout).toContain('only-linked.ts')
      expect(sub.tracked.stdout.trim()).toBe('a.ts')
    }
    expect(cache.indexPath(linked)).not.toBe(cache.indexPath(root))
    expect(cache.indexPath(join(root, 'sub'))).toBe(cache.indexPath(root))
  })

  test('never serves a reused list from an index git no longer names', async () => {
    const outer = repo()
    const root = join(outer, 'app')
    mkdirSync(root)
    const { git, asked } = countingGit()
    const cache = settled()
    // Keyed on the outer repository's index, found from the subdirectory.
    for (let i = 0; i < 3; i++) await sponsoredGitProbes(root, git, cache)
    expect(cache.indexPath(root)).toBe(join(outer, '.git', 'index'))
    const before = lsCount(asked)

    // The folder becomes its own repository; the outer index is untouched.
    run(root, 'init', '-q')
    writeFileSync(join(root, 'inner.ts'), 'x')
    run(root, 'add', 'inner.ts')
    const probes = await sponsoredGitProbes(root, git, cache)
    expect(probes.tracked.stdout.trim()).toBe('inner.ts')
    // The reused answer was thrown away and asked again, once.
    expect(lsCount(asked)).toBe(before + 1)
    expect(cache.indexPath(root)).toBe(join(root, '.git', 'index'))
    // The re-asked list was kept under the new index.
    await sponsoredGitProbes(root, git, cache)
    expect(lsCount(asked)).toBe(before + 1)
  })

  test('a timed-out work-tree check keeps what the root has learned', async () => {
    const root = repo()
    const { git: real } = countingGit()
    const cache = settled()
    await sponsoredGitProbes(root, real, cache)
    const path = cache.indexPath(root)
    expect(path).toBeDefined()
    const timedOut: GitRunner = async (args) =>
      args.includes('--is-inside-work-tree')
        ? { exitCode: 143, stdout: '', stderr: '' }
        : real(args)
    await sponsoredGitProbes(root, timedOut, cache)
    expect(cache.indexPath(root)).toBe(path)
  })

  test('outside a repository it remembers nothing', async () => {
    const { git } = countingGit()
    const cache = settled()
    const folder = tempDir()
    const probes = await sponsoredGitProbes(folder, git, cache)
    expect(probes.inside.exitCode).not.toBe(0)
    expect(cache.indexPath(folder)).toBeUndefined()
  })

  test('with no cache it asks all four questions every time', async () => {
    const root = repo()
    const { git, asked } = countingGit()
    await sponsoredGitProbes(root, git, null)
    await sponsoredGitProbes(root, git, null)
    expect(asked).toHaveLength(8)
    expect(lsCount(asked)).toBe(2)
  })

  test('a runner that rejects rejects the probe, with nothing left unhandled', async () => {
    const git: GitRunner = async (args) => {
      if (args.includes('remote')) throw new Error('spawn failed')
      return ok('true\n')
    }
    await expect(sponsoredGitProbes('/repo', git, settled())).rejects.toThrow(
      'spawn failed',
    )
  })
})

describe('sponsoredCliCapability with the tracked-files cache', () => {
  const mac = (): SponsoredLocalContainment => ({
    available: true,
    mechanism: 'sandbox-exec',
  })

  test('answers the same with and without the cache', async () => {
    const root = repo()
    run(root, 'remote', 'add', 'origin', 'git@github.com:acme/app.git')
    const { git, asked } = countingGit()
    const cache = settled()

    const uncached = await sponsoredCliCapability(
      root,
      git,
      'darwin',
      mac,
      null,
    )
    for (let i = 0; i < 3; i++)
      expect(
        await sponsoredCliCapability(root, git, 'darwin', mac, cache),
      ).toEqual(uncached)
    expect(uncached.capabilityInspection).toEqual({ status: 'available' })
    expect(lsCount(asked)).toBe(2)
  })

  test('an unborn repository is still no_committed_head', async () => {
    const root = tempDir()
    run(root, 'init', '-q')
    const { git } = countingGit()
    const result = await sponsoredCliCapability(
      root,
      git,
      'darwin',
      mac,
      settled(),
    )
    expect(result.capabilityInspection).toEqual({
      status: 'unavailable',
      reason: 'no_committed_head',
    })
  })

  test('a runner that rejects is still inspection_failed', async () => {
    const git: GitRunner = async () => {
      throw new Error('spawn failed')
    }
    const result = await sponsoredCliCapability(
      repo(),
      git,
      'darwin',
      mac,
      settled(),
    )
    expect(result.capabilityInspection).toEqual({
      status: 'unavailable',
      reason: 'inspection_failed',
    })
  })

  test('is not cached unless a cache is passed', async () => {
    const root = repo()
    const { git, asked } = countingGit()
    for (let i = 0; i < 3; i++)
      await sponsoredCliCapability(root, git, 'darwin', mac)
    expect(lsCount(asked)).toBe(3)
  })
})
