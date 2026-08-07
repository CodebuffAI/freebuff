import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  isUndoAvailable,
  patchSnapshot,
  restoreSnapshot,
  revertFiles,
  setSnapshotDirOverrideForTesting,
  trackSnapshot,
} from '../undo-snapshot'

let projectDir: string
let snapshotRoot: string
let plainDir: string

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
