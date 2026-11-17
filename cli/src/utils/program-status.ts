import { wrapForMultiplexer } from './terminal-title'

/** OSC 7501 program status. https://www.superlogical.com/rex/docs/build/program-status */
export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error'
export type BlockedKind = 'permission' | 'question' | 'auth'

export type StatusReport = {
  state: ProgramState
  kind?: BlockedKind
}

type MultiplexerEnv = Parameters<typeof wrapForMultiplexer>[1]
type WriteControl = (sequence: string) => boolean

const APP = 'freebuff'
// ST, not BEL: a BEL inside a tmux passthrough can close the DCS early.
const TERMINATOR = '\x1b\\'

/** One report per state transition. `kind` is only meaningful with `blocked`. */
export function buildStatusSequence(
  report: StatusReport,
  env: MultiplexerEnv,
): string {
  const pairs = [`state=${report.state}`]
  if (report.state === 'blocked' && report.kind) {
    pairs.push(`kind=${report.kind}`)
  }
  pairs.push(`app=${APP}`)
  return wrapForMultiplexer(`\x1b]7501;${pairs.join(':')}${TERMINATOR}`, env)
}

export function reportProgramStatus(
  report: StatusReport,
  write: WriteControl,
  env: MultiplexerEnv,
): boolean {
  return write(buildStatusSequence(report, env))
}

/** The state the CLI derives for its own UI, see `status-indicator-state.ts`. */
export type IndicatorKind =
  | 'idle'
  | 'clipboard'
  | 'ctrlC'
  | 'connecting'
  | 'retrying'
  | 'capacityWait'
  | 'waiting'
  | 'streaming'
  | 'reconnected'
  | 'paused'

/**
 * Map the CLI's own indicator onto a report. `null` means "no change worth
 * reporting": transient chrome, or a repeat of what is already showing.
 */
export function statusReportFor(
  kind: IndicatorKind,
  authStatus: 'ok' | 'retrying' | 'unreachable',
  previous: ProgramState | null,
): StatusReport | null {
  switch (kind) {
    case 'streaming':
    case 'waiting':
    case 'retrying':
    case 'capacityWait':
      return { state: 'working' }
    case 'connecting':
      // Still retrying is work; unreachable means it needs credentials.
      return authStatus === 'unreachable'
        ? { state: 'blocked', kind: 'auth' }
        : { state: 'working' }
    case 'paused':
      // ask_user is active: the one blocked-on-question state the CLI has.
      return { state: 'blocked', kind: 'question' }
    case 'idle':
      return previous === 'working' ? { state: 'done' } : { state: 'idle' }
    default:
      return null
  }
}
