import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  anchorSnapshot,
  isSnapshotAvailable,
  isUndoAvailable,
  patchSnapshot,
  releaseSnapshot,
  restoreSnapshot,
  revertFiles,
  setSnapshotDirOverrideForTesting,
  trackSnapshot,
} from '../undo-snapshot'

let projectDir: string
let snapshotRoot: string
let plainDir: string

/** The journal entry the snapshots belong to; anchors are keyed by it. */
const SNAPSHOT_KEY = 'test-chat'

const gitInProject = (args: string[]): string =>
  execFileSync('git', args, {
    cwd: projectDir,
    encoding: 'utf8',
    // Keep expected stderr noise (e.g. the "ambiguous HEAD" probe) out of the
    // test output.
    stdio: ['ignore', 'pipe', 'ignore'],
  })

const readProjectFile = (file: string): string =>
  execFileSync('cat', [path.join(projectDir, file)], { encoding: 'utf8' })

/** The snapshot repo the fixture has initialized under the override root. */
const snapshotRepoDir = (): string => {
  const [entry] = readdirSync(snapshotRoot)
  if (!entry) throw new Error('no snapshot repo was initialized')
  return path.join(snapshotRoot, entry)
}

/** Run the cleanup job's gc now, instead of waiting out its 7-day grace. */
const pruneSnapshotRepo = (): void => {
  execFileSync(
    'git',
    [
      '--git-dir',
      snapshotRepoDir(),
      '--work-tree',
      projectDir,
      'gc',
      '--quiet',
      '--prune=now',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
}

beforeAll(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'undo-snapshot-proj-'))
  snapshotRoot = mkdtempSync(path.join(os.tmpdir(), 'undo-snapshot-store-'))
  plainDir = mkdtempSync(path.join(os.tmpdir(), 'undo-snapshot-plain-'))
  setSnapshotDirOverrideForTesting(snapshotRoot)
  // A real (but commit-less) git repository. write-tree does not need commits
  // or user identity, so this is all the fixture requires.
  execFileSync('git', ['init'], { cwd: projectDir })
})

afterAll(() => {
  setSnapshotDirOverrideForTesting(undefined)
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(snapshotRoot, { recursive: true, force: true })
  rmSync(plainDir, { recursive: true, force: true })
})

describe('isUndoAvailable', () => {
  test('is true for a git repository', () => {
    expect(isUndoAvailable(projectDir)).toBe(true)
  })

  test('is false for a directory without git', () => {
    expect(isUndoAvailable(plainDir)).toBe(false)
  })
})

describe('trackSnapshot', () => {
  test('returns null for a non-git directory', async () => {
    expect(await trackSnapshot(plainDir)).toBeNull()
  })

  test('returns a hash and detects modified, added, and deleted files', async () => {
    writeFileSync(path.join(projectDir, 'a.txt'), 'hello\n')
    writeFileSync(path.join(projectDir, 'c.txt'), 'keep me\n')
    const hash = await trackSnapshot(projectDir)
    expect(hash).toBeTruthy()

    // Modify a tracked-in-snapshot file, add a new file, delete another.
    writeFileSync(path.join(projectDir, 'a.txt'), 'hello world\n')
    writeFileSync(path.join(projectDir, 'b.txt'), 'new file\n')
    rmSync(path.join(projectDir, 'c.txt'))

    const changed = await patchSnapshot(projectDir, hash!)
    expect(changed.sort()).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })
})

describe('restoreSnapshot', () => {
  test('overwrites the worktree with the tracked state', async () => {
    writeFileSync(path.join(projectDir, 'restore.txt'), 'original\n')
    const hash = await trackSnapshot(projectDir)

    writeFileSync(path.join(projectDir, 'restore.txt'), 'changed by agent\n')

    const ok = await restoreSnapshot(projectDir, hash!)
    expect(ok).toBe(true)
    expect(readProjectFile('restore.txt')).toBe('original\n')
  })
})

describe('revertFiles', () => {
  test('restores a modified file and deletes a file created after the snapshot', async () => {
    writeFileSync(path.join(projectDir, 'revert.txt'), 'v1\n')
    const hash = await trackSnapshot(projectDir)

    writeFileSync(path.join(projectDir, 'revert.txt'), 'v2 by agent\n')
    writeFileSync(path.join(projectDir, 'agent-created.txt'), 'agent made this\n')

    const { restored, deleted } = await revertFiles(projectDir, hash!, [
      'revert.txt',
      'agent-created.txt',
    ])
    // revert.txt existed in the snapshot and is restored; agent-created.txt did
    // not exist in the snapshot (the agent created it) and is deleted.
    expect(restored).toEqual(['revert.txt'])
    expect(deleted).toEqual(['agent-created.txt'])
    expect(readProjectFile('revert.txt')).toBe('v1\n')
    expect(existsSync(path.join(projectDir, 'agent-created.txt'))).toBe(false)
  })
})

describe('a snapshot whose content is gone', () => {
  test('leaves the worktree alone when a blob the tree lists is gone', async () => {
    // Make sure the snapshot repo exists before reaching into it.
    await trackSnapshot(projectDir)

    // A tree that references a blob which exists nowhere: the tree survives,
    // its content does not. This is what borrowing the project's objects
    // looks like once the project collects the object it was lending.
    const missing = '0123456789abcdef0123456789abcdef01234567'
    const tree = execFileSync(
      'git',
      [
        '--git-dir',
        snapshotRepoDir(),
        '--work-tree',
        projectDir,
        'mktree',
        '--missing',
      ],
      {
        cwd: projectDir,
        encoding: 'utf8',
        input: `100644 blob ${missing}\torphan.txt\n`,
      },
    ).trim()
    expect(tree).toBeTruthy()

    writeFileSync(path.join(projectDir, 'orphan.txt'), 'the agent wrote this\n')

    const { restored, deleted } = await revertFiles(projectDir, tree, [
      'orphan.txt',
    ])
    // `git checkout` deletes a worktree file whose blob it cannot read, so
    // reverting against this tree would destroy the file instead of restoring
    // it. Nothing may be restored, nothing deleted, and the file must survive.
    expect(readProjectFile('orphan.txt')).toBe('the agent wrote this\n')
    expect(restored).toEqual([])
    expect(deleted).toEqual([])
    expect(existsSync(path.join(projectDir, 'orphan.txt'))).toBe(true)

    // And it must not be advertised as restorable either.
    expect(await isSnapshotAvailable(projectDir, tree)).toBe(false)
  })
})

describe('snapshot anchoring', () => {
  test('git keeps the anchored snapshot and collects the unanchored one', async () => {
    writeFileSync(path.join(projectDir, 'lifetime.txt'), 'before the turn\n')
    const held = await trackSnapshot(projectDir)
    expect(held).toBeTruthy()
    expect(anchorSnapshot(projectDir, SNAPSHOT_KEY, held!)).toBeTruthy()

    // Two more turns move the snapshot index on, so nothing in git points at
    // either tree any more.
    writeFileSync(path.join(projectDir, 'lifetime.txt'), 'after the turn\n')
    const unheld = await trackSnapshot(projectDir)
    expect(unheld).toBeTruthy()
    writeFileSync(path.join(projectDir, 'lifetime.txt'), 'and once more\n')
    await trackSnapshot(projectDir)
    pruneSnapshotRepo()

    // The anchored one survives; the one no journal holds is collected.
    expect(await isSnapshotAvailable(projectDir, held!)).toBe(true)
    expect(await isSnapshotAvailable(projectDir, unheld!)).toBe(false)

    // And the anchor is what holds it: drop it and git collects it too.
    expect(releaseSnapshot(projectDir, SNAPSHOT_KEY, held!)).toBe(true)
    pruneSnapshotRepo()
    expect(await isSnapshotAvailable(projectDir, held!)).toBe(false)
    expect(await restoreSnapshot(projectDir, held!)).toBe(false)
  })
})

describe('failed staging', () => {
  test('a failed git add does not hand back a hash', async () => {
    // A root user can read anything, so the fixture cannot fail the add there.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return

    // git refuses to index an unreadable file, but `write-tree` still returns
    // the tree of the stale index: a hash that looks valid and is not.
    const blocked = path.join(projectDir, 'blocked.txt')
    writeFileSync(blocked, 'unreadable\n')
    chmodSync(blocked, 0o000)
    try {
      expect(await trackSnapshot(projectDir)).toBeNull()
    } finally {
      chmodSync(blocked, 0o644)
      rmSync(blocked, { force: true })
    }
  })
})

describe('isolation from the real repository', () => {
  test('never stages or commits anything in the project git repo', async () => {
    // Fresh fixture area.
    writeFileSync(path.join(projectDir, 'isolated.txt'), 'content\n')
    await trackSnapshot(projectDir)
    writeFileSync(path.join(projectDir, 'isolated.txt'), 'content v2\n')
    await trackSnapshot(projectDir)

    // The real repo must have no staged changes and no commits of ours.
    const staged = gitInProject(['diff', '--cached', '--name-only']).trim()
    expect(staged).toBe('')
    expect(() => gitInProject(['rev-parse', 'HEAD'])).toThrow()
  })
})
