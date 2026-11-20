import { describe, expect, test } from 'bun:test'

import {
  buildStatusSequence,
  reportProgramStatus,
  statusReportFor,
} from '../program-status'

const BEL = '\x1b\\'

describe('buildStatusSequence', () => {
  test('writes one report for working', () => {
    expect(buildStatusSequence({ state: 'working' }, {})).toBe(
      `\x1b]7501;state=working:app=freebuff${BEL}`,
    )
  })

  test('carries kind only with blocked', () => {
    expect(
      buildStatusSequence({ state: 'blocked', kind: 'question' }, {}),
    ).toBe(`\x1b]7501;state=blocked:kind=question:app=freebuff${BEL}`)
    expect(
      buildStatusSequence({ state: 'working', kind: 'question' }, {}),
    ).toBe(`\x1b]7501;state=working:app=freebuff${BEL}`)
  })

  test('wraps for tmux passthrough', () => {
    const sequence = buildStatusSequence(
      { state: 'blocked', kind: 'auth' },
      { TMUX: '/tmp/tmux-1000/default,123,0' },
    )
    // DCS wrapper, with the inner ESC doubled as tmux requires.
    expect(sequence.startsWith('\x1bPtmux;')).toBe(true)
    expect(sequence).toContain(']7501;state=blocked:kind=auth:app=freebuff')
    expect(sequence.endsWith(BEL)).toBe(true)
    expect(sequence).toContain('\x1b\x1b]7501')
  })

  test('wraps for screen passthrough', () => {
    const sequence = buildStatusSequence(
      { state: 'done' },
      { TERM: 'screen-256color' },
    )
    expect(sequence.startsWith('\x1bP')).toBe(true)
    expect(sequence).not.toContain('tmux;')
  })
})

describe('statusReportFor', () => {
  test('work in every form reports working', () => {
    for (const kind of [
      'streaming',
      'waiting',
      'retrying',
      'capacityWait',
    ] as const) {
      expect(statusReportFor(kind, 'ok', null)).toEqual({ state: 'working' })
    }
  })

  test('ask_user is the blocked question state', () => {
    expect(statusReportFor('paused', 'ok', 'working')).toEqual({
      state: 'blocked',
      kind: 'question',
    })
  })

  test('unreachable auth blocks, retrying auth does not', () => {
    expect(statusReportFor('connecting', 'unreachable', null)).toEqual({
      state: 'blocked',
      kind: 'auth',
    })
    expect(statusReportFor('connecting', 'retrying', null)).toEqual({
      state: 'working',
    })
  })

  test('a finished turn reports done exactly once, then idle', () => {
    expect(statusReportFor('idle', 'ok', 'working')).toEqual({ state: 'done' })
    expect(statusReportFor('idle', 'ok', 'done')).toEqual({ state: 'idle' })
    expect(statusReportFor('idle', 'ok', null)).toEqual({ state: 'idle' })
  })

  test('chrome-only states report nothing', () => {
    for (const kind of ['clipboard', 'ctrlC', 'reconnected'] as const) {
      expect(statusReportFor(kind, 'ok', 'idle')).toBeNull()
    }
  })
})

describe('reportProgramStatus', () => {
  test('returns false instead of throwing when there is no tty', () => {
    const written: string[] = []
    const ok = reportProgramStatus(
      { state: 'idle' },
      (s) => {
        written.push(s)
        return false
      },
      {},
    )
    expect(ok).toBe(false)
    expect(written).toHaveLength(1)
  })
})
