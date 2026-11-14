import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  PROGRAM_STATUS_APP,
  buildProgramStatusSequence,
  nextProgramStatusUpdate,
  reportProgramStatus,
} from '../program-status'

const ST = '\x1b\\'

function withTtyFile(run: (ttyPath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'program-status-'))
  const ttyPath = join(directory, 'tty')
  writeFileSync(ttyPath, '')

  try {
    run(ttyPath)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('program status', () => {
  test('builds the idle report for the running program', () => {
    expect(buildProgramStatusSequence('idle')).toBe(
      `\x1b]7501;state=idle:app=${PROGRAM_STATUS_APP}${ST}`,
    )
  })

  test('adds the blocked kind only while blocked', () => {
    expect(buildProgramStatusSequence('blocked', { kind: 'question' })).toBe(
      `\x1b]7501;state=blocked:app=${PROGRAM_STATUS_APP}:kind=question${ST}`,
    )
    expect(buildProgramStatusSequence('working', { kind: 'question' })).toBe(
      `\x1b]7501;state=working:app=${PROGRAM_STATUS_APP}${ST}`,
    )
  })

  test('builds clear reports', () => {
    expect(buildProgramStatusSequence('clear')).toBe(
      `\x1b]7501;state=clear:app=${PROGRAM_STATUS_APP}${ST}`,
    )
  })

  test('writes a report to a tty path', () => {
    withTtyFile((ttyPath) => {
      expect(reportProgramStatus('working', { ttyPath })).toBe(true)
      expect(readFileSync(ttyPath, 'utf8')).toBe(
        buildProgramStatusSequence('working'),
      )
    })
  })

  test('returns false when the terminal cannot be opened', () => {
    expect(
      reportProgramStatus('done', {
        ttyPath: '/path/that/does/not/exist',
      }),
    ).toBe(false)
  })

  test('reports idle before the first turn', () => {
    expect(
      nextProgramStatusUpdate({
        isChainInProgress: false,
        isAsking: false,
        wasWorking: false,
      }),
    ).toEqual({ update: { state: 'idle' }, wasWorking: false })
  })

  test('reports working for a running turn', () => {
    expect(
      nextProgramStatusUpdate({
        isChainInProgress: true,
        isAsking: false,
        wasWorking: false,
      }),
    ).toEqual({ update: { state: 'working' }, wasWorking: true })
  })

  test('reports blocked while a question waits for the user', () => {
    expect(
      nextProgramStatusUpdate({
        isChainInProgress: true,
        isAsking: true,
        wasWorking: true,
      }),
    ).toEqual({
      update: { state: 'blocked', kind: 'question' },
      wasWorking: true,
    })
  })

  test('returns to working after the question is answered', () => {
    expect(
      nextProgramStatusUpdate({
        isChainInProgress: true,
        isAsking: false,
        wasWorking: true,
      }),
    ).toEqual({ update: { state: 'working' }, wasWorking: true })
  })

  test('reports done only on the transition out of a turn', () => {
    expect(
      nextProgramStatusUpdate({
        isChainInProgress: false,
        isAsking: false,
        wasWorking: true,
      }),
    ).toEqual({ update: { state: 'done' }, wasWorking: false })
    expect(
      nextProgramStatusUpdate({
        isChainInProgress: false,
        isAsking: false,
        wasWorking: false,
      }),
    ).toEqual({ update: { state: 'idle' }, wasWorking: false })
  })
})
