import { describe, expect, test } from 'bun:test'

import {
  beginUndoTurn,
  filesRestored,
  filesTakenBack,
  isLatestUndoTurn,
  newerTurnCount,
} from '../undo-guards'

import type { UndoRecord } from '../undo-store'

const record = (id: string): UndoRecord => ({
  id,
  chatId: 'undo-guards-chat',
  hashBefore: `hash-${id}`,
  // Every turn also touches a file another turn touched, so the union is the
  // thing under test rather than "all files happen to be distinct".
  files: [`${id}.ts`, 'shared.ts'],
  message: id,
  createdAt: '2026-01-01T00:00:00.000Z',
})

// The picker's list: newest first.
const newestFirst = [record('c'), record('b'), record('a')]

describe('filesTakenBack / filesRestored', () => {
  test('an undo touches the selected turn and every newer one', () => {
    expect(filesTakenBack(newestFirst, 'c')).toEqual(['c.ts', 'shared.ts'])
    expect(filesTakenBack(newestFirst, 'a')).toEqual([
      'c.ts',
      'shared.ts',
      'b.ts',
      'a.ts',
    ])
  })

  test('lists a file once however many turns touched it', () => {
    expect(
      filesTakenBack(newestFirst, 'a').filter((file) => file === 'shared.ts'),
    ).toHaveLength(1)
  })

  test('is empty for an id the list does not hold', () => {
    expect(filesTakenBack(newestFirst, 'gone')).toEqual([])
  })

  test('a redo brings back the turns its undo had reverted', () => {
    const redoable: UndoRecord = {
      ...record('x'),
      restored: [record('r1'), record('r2')],
    }
    expect(filesRestored(redoable)).toEqual([
      'r1.ts',
      'shared.ts',
      'r2.ts',
    ])
  })

  test('a redo without carried turns falls back to its own files', () => {
    expect(filesRestored(record('only'))).toEqual(['only.ts', 'shared.ts'])
  })
})

describe('newerTurnCount', () => {
  test('counts the entries newer than the selected one', () => {
    expect(newerTurnCount(newestFirst, 'c')).toBe(0)
    expect(newerTurnCount(newestFirst, 'b')).toBe(1)
    expect(newerTurnCount(newestFirst, 'a')).toBe(2)
  })

  test('is zero when there is nothing newer to take with it', () => {
    expect(newerTurnCount([record('only')], 'only')).toBe(0)
    expect(newerTurnCount([], 'a')).toBe(0)
  })

  test('is zero for an id the list does not hold', () => {
    expect(newerTurnCount(newestFirst, 'gone')).toBe(0)
  })
})

describe('beginUndoTurn / isLatestUndoTurn', () => {
  test('a turn that starts and finishes alone may record', () => {
    const stamp = beginUndoTurn('guards-alone')
    expect(isLatestUndoTurn('guards-alone', stamp)).toBe(true)
  })

  test('a turn whose run outlives the next one may not record', () => {
    // Esc releases the chain lock before the interrupted run's `finally`, so
    // the next turn starts while the interrupted one is still diffing.
    const interrupted = beginUndoTurn('guards-raced')
    const next = beginUndoTurn('guards-raced')
    expect(isLatestUndoTurn('guards-raced', interrupted)).toBe(false)
    expect(isLatestUndoTurn('guards-raced', next)).toBe(true)
  })

  test('stamps are per chat, so another chat cannot invalidate a turn', () => {
    const mine = beginUndoTurn('guards-chat-a')
    const other = beginUndoTurn('guards-chat-b')
    expect(isLatestUndoTurn('guards-chat-a', mine)).toBe(true)
    expect(isLatestUndoTurn('guards-chat-b', other)).toBe(true)
    expect(isLatestUndoTurn('guards-chat-b', mine)).toBe(false)
  })
})
