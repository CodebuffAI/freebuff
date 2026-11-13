/**
 * Program Status Protocol (OSC 7501) reporting.
 *
 * Terminals such as Herdr treat a program as an agent only when it reports its
 * lifecycle through OSC 7501. We write directly to /dev/tty, like
 * terminal-title.ts, because OpenTUI captures stdout.
 *
 * Sequence: ESC ] 7501 ; state=<state>:app=<program>[:kind=<kind>] ESC \
 */

import { IS_FREEBUFF } from './constants'
import { writeTerminalControlSync } from './terminal-io'

export type ProgramStatusState =
  | 'idle'
  | 'working'
  | 'blocked'
  | 'done'
  | 'clear'

/** Only sent alongside `blocked`. */
export type BlockedKind = 'permission' | 'question'

export type ProgramStatusUpdate =
  | { state: 'idle' | 'working' | 'done' }
  | { state: 'blocked'; kind: BlockedKind }

export const PROGRAM_STATUS_APP = IS_FREEBUFF ? 'freebuff' : 'codebuff'

const OSC_7501 = '\x1b]7501;'
const OSC_TERMINATOR = '\x1b\\' // ST

/**
 * Decide the next report from the CLI's turn and prompt state.
 *
 * A turn that just ended reports `done`; only a CLI that has not worked yet
 * reports `idle`.
 */
export function nextProgramStatusUpdate(params: {
  isChainInProgress: boolean
  isAsking: boolean
  wasWorking: boolean
}): { update: ProgramStatusUpdate; wasWorking: boolean } {
  if (params.isAsking) {
    return { update: { state: 'blocked', kind: 'question' }, wasWorking: true }
  }
  if (params.isChainInProgress) {
    return { update: { state: 'working' }, wasWorking: true }
  }
  if (params.wasWorking) {
    return { update: { state: 'done' }, wasWorking: false }
  }
  return { update: { state: 'idle' }, wasWorking: false }
}

export function buildProgramStatusSequence(
  state: ProgramStatusState,
  options: { kind?: BlockedKind } = {},
): string {
  const fields = [`state=${state}`, `app=${PROGRAM_STATUS_APP}`]
  if (state === 'blocked' && options.kind) {
    fields.push(`kind=${options.kind}`)
  }
  return `${OSC_7501}${fields.join(':')}${OSC_TERMINATOR}`
}

/**
 * Report one state transition. Unknown terminals ignore OSC 7501, and a
 * non-interactive process has no /dev/tty, so failures are silent.
 */
export function reportProgramStatus(
  state: ProgramStatusState,
  options: { kind?: BlockedKind; ttyPath?: string } = {},
): boolean {
  return writeTerminalControlSync(
    buildProgramStatusSequence(state, { kind: options.kind }),
    options.ttyPath,
  )
}

export function reportIdle(): boolean {
  return reportProgramStatus('idle')
}

export function reportWorking(): boolean {
  return reportProgramStatus('working')
}

export function reportBlocked(kind: BlockedKind): boolean {
  return reportProgramStatus('blocked', { kind })
}

export function reportDone(): boolean {
  return reportProgramStatus('done')
}

/** Stop being an agent in terminals that track agents by status. */
export function reportClear(): boolean {
  return reportProgramStatus('clear')
}
