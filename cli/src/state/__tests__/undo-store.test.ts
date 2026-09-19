import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getProjectDataDir, setCurrentChatId, setProjectRoot } from '../../project-files'
import {
  anchorSnapshot,
  listAnchors,
  patchSnapshot,
  releaseSnapshot,
  setSnapshotDirOverrideForTesting,
  trackSnapshot,
} from '../../utils/undo-snapshot'
import {
  loadUndoState,
  peekRedo,
  peekUndo,
  popRedo,
  popUndo,
  pushRedo,
  pushUndo,
  recordUndoEntry,
  sweepAnchors,
  undoToRecord,
} from '../undo-store'

const CHAT_ID = 'undo-store-test-chat'

let projectDir: string
let snapshotRoot: string

beforeAll(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'undo-store-proj-'))
  snapshotRoot = mkdtempSync(path.join(os.tmpdir(), 'undo-store-snapshots-'))
  setProjectRoot(projectDir)
  setCurrentChatId(CHAT_ID)
  // The journal hands snapshots to undo-snapshot, which needs a git project.
  setSnapshotDirOverrideForTesting(snapshotRoot)
  execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' })
})

// Each test starts from a clean journal for this chat.
beforeEach(() => {
  const chatDir = path.join(getProjectDataDir(), 'chats', CHAT_ID)
  rmSync(chatDir, { recursive: true, force: true })
  setCurrentChatId(CHAT_ID)
})

afterAll(() => {
  const chatDir = path.join(getProjectDataDir(), 'chats', CHAT_ID)
  rmSync(chatDir, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
  setSnapshotDirOverrideForTesting(undefined)
  rmSync(snapshotRoot, { recursive: true, force: true })
})

/** Run the cleanup job's gc now, instead of waiting out its 7-day grace. */
const pruneSnapshotRepo = (): void => {
  const [entry] = readdirSync(snapshotRoot)
  if (!entry) return
  execFileSync(
    'git',
    [
      '--git-dir',
      path.join(snapshotRoot, entry),
      '--work-tree',
      projectDir,
      'gc',
      '--quiet',
      '--prune=now',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
}

describe('recordUndoEntry', () => {
  test('records an entry and ignores empty ones', () => {
    recordUndoEntry(CHAT_ID, {
      hashBefore: 'abc123',
      files: ['a.txt', 'b.txt'],
      message: 'fix the bug',
    })
    const state = loadUndoState(CHAT_ID)
    expect(state.undoStack).toHaveLength(1)
    expect(state.undoStack[0]).toMatchObject({
      chatId: CHAT_ID,
      hashBefore: 'abc123',
      files: ['a.txt', 'b.txt'],
      message: 'fix the bug',
    })
    expect(peekUndo(CHAT_ID)?.hashBefore).toBe('abc123')

    // No hash or no files → nothing recorded.
    recordUndoEntry(CHAT_ID, { hashBefore: '', files: [], message: 'x' })
    recordUndoEntry(CHAT_ID, { hashBefore: 'def', files: [], message: 'x' })
    expect(loadUndoState(CHAT_ID).undoStack).toHaveLength(1)
  })

  test('clears the redo stack when a new entry arrives', () => {
    pushRedo(CHAT_ID, {
      id: 'r1',
      chatId: CHAT_ID,
      hashBefore: 'old',
      hashAfter: 'new',
      files: ['a.txt'],
      message: 'redo me',
      createdAt: new Date().toISOString(),
    })
    expect(peekRedo(CHAT_ID)).not.toBeNull()

    recordUndoEntry(CHAT_ID, {
      hashBefore: 'xyz',
      files: ['c.txt'],
      message: 'new turn',
    })
    expect(peekRedo(CHAT_ID)).toBeNull()
  })
})

describe('undo/redo stack operations', () => {
  test('popUndo returns the most recent record and persists', () => {
    recordUndoEntry(CHAT_ID, {
      hashBefore: 'first',
      files: ['one.txt'],
      message: 'first turn',
    })
    recordUndoEntry(CHAT_ID, {
      hashBefore: 'second',
      files: ['two.txt'],
      message: 'second turn',
    })

    const record = popUndo(CHAT_ID)
    expect(record?.hashBefore).toBe('second')
    expect(peekUndo(CHAT_ID)?.hashBefore).toBe('first')
    // Reload from disk to confirm the pop persisted.
    expect(loadUndoState(CHAT_ID).undoStack).toHaveLength(1)
  })

  test('pushUndo restores a record and popRedo cycles', () => {
    recordUndoEntry(CHAT_ID, {
      hashBefore: 'cycle-hash',
      files: ['x.txt'],
      message: 'cycle',
    })
    const record = popUndo(CHAT_ID)!
    pushRedo(CHAT_ID, { ...record, hashAfter: 'after-state' })

    const redoRecord = popRedo(CHAT_ID)
    expect(redoRecord?.hashBefore).toBe('cycle-hash')
    expect(redoRecord?.hashAfter).toBe('after-state')

    pushUndo(CHAT_ID, { ...redoRecord!, hashAfter: undefined })
    expect(peekUndo(CHAT_ID)?.hashBefore).toBe('cycle-hash')
  })

  test('returns null from empty stacks', () => {
    setCurrentChatId('empty-chat')
    expect(popUndo('empty-chat')).toBeNull()
    expect(popRedo('empty-chat')).toBeNull()
    setCurrentChatId(CHAT_ID)
  })
})

describe('a snapshot that is gone', () => {
  test('leaves the worktree alone instead of deleting what it cannot restore', async () => {
    const kept = path.join(projectDir, 'kept.txt')
    writeFileSync(kept, 'the user wrote this\n')
    const hash = await trackSnapshot(projectDir)
    expect(hash).toBeTruthy()

    // The turn edits the file and the journal records what to revert.
    writeFileSync(kept, 'the agent changed it\n')
    recordUndoEntry(CHAT_ID, {
      hashBefore: hash!,
      files: ['kept.txt'],
      message: 'a recorded turn',
    })

    // The snapshot is gone — pruned by the cleanup job, or a wiped config dir.
    // `checkout` then fails, and "not in the snapshot" must not be read as
    // "the turn created this file".
    rmSync(snapshotRoot, { recursive: true, force: true })

    const message = await undoToRecord(CHAT_ID, projectDir, peekUndo(CHAT_ID)!.id)

    expect(message).toBeNull()
    expect(existsSync(kept)).toBe(true)
    expect(readFileSync(kept, 'utf8')).toBe('the agent changed it\n')
  })
})

describe('snapshot anchors', () => {
  test('a recorded turn stays restorable after the cleanup job runs', async () => {
    const kept = path.join(projectDir, 'anchored.txt')
    writeFileSync(kept, 'the user wrote this\n')
    const hash = await trackSnapshot(projectDir)
    expect(hash).toBeTruthy()

    // The turn edits the file, and the snapshot index moves on with it.
    writeFileSync(kept, 'the agent changed it\n')
    await patchSnapshot(projectDir, hash!)
    recordUndoEntry(CHAT_ID, {
      hashBefore: hash!,
      files: ['anchored.txt'],
      message: 'a recorded turn',
    })
    pruneSnapshotRepo()

    const message = await undoToRecord(CHAT_ID, projectDir, peekUndo(CHAT_ID)!.id)

    expect(message).not.toBeNull()
    expect(readFileSync(kept, 'utf8')).toBe('the user wrote this\n')
  })

  test('the sweep drops the anchors of a chat whose journal is gone', async () => {
    writeFileSync(path.join(projectDir, 'swept.txt'), 'content\n')
    const hash = await trackSnapshot(projectDir)
    expect(anchorSnapshot(projectDir, 'abandoned-chat', hash!)).toBeTruthy()
    expect(listAnchors(projectDir)).toContainEqual({
      key: 'abandoned-chat',
      hash: hash!,
    })

    const { released } = sweepAnchors(projectDir)

    expect(released).toBeGreaterThan(0)
    expect(listAnchors(projectDir)).not.toContainEqual({
      key: 'abandoned-chat',
      hash: hash!,
    })
  })

  test('the sweep re-anchors an entry whose ref went missing', async () => {
    writeFileSync(path.join(projectDir, 'reanchor.txt'), 'content\n')
    const hash = await trackSnapshot(projectDir)
    recordUndoEntry(CHAT_ID, {
      hashBefore: hash!,
      files: ['reanchor.txt'],
      message: 'a recorded turn',
    })
    // Pretend the release path ran early, or its write was lost.
    expect(releaseSnapshot(projectDir, CHAT_ID, hash!)).toBe(true)
    expect(listAnchors(projectDir)).not.toContainEqual({
      key: CHAT_ID,
      hash: hash!,
    })

    sweepAnchors(projectDir)

    expect(listAnchors(projectDir)).toContainEqual({ key: CHAT_ID, hash: hash! })
  })
})

describe('corrupt file handling', () => {
  test('loads an empty state for a nonexistent chat', () => {
    expect(loadUndoState('never-existed').undoStack).toEqual([])
    expect(loadUndoState('never-existed').redoStack).toEqual([])
  })
})
