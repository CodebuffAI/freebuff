import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getProjectDataDir, setCurrentChatId, setProjectRoot } from '../../project-files'
import {
  loadUndoState,
  peekRedo,
  peekUndo,
  popRedo,
  popUndo,
  pushRedo,
  pushUndo,
  recordUndoEntry,
} from '../undo-store'

const CHAT_ID = 'undo-store-test-chat'

let projectDir: string

beforeAll(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'undo-store-proj-'))
  setProjectRoot(projectDir)
  setCurrentChatId(CHAT_ID)
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
})

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

describe('corrupt file handling', () => {
  test('loads an empty state for a nonexistent chat', () => {
    expect(loadUndoState('never-existed').undoStack).toEqual([])
    expect(loadUndoState('never-existed').redoStack).toEqual([])
  })
})
