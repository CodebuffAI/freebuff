/**
 * Terminal title utilities using OSC (Operating System Command) escape sequences.
 *
 * OSC sequence format for setting title:
 * - `\x1b]0;${title}\x07` - Sets both window title and icon name
 * - `\x1b` is ESC, `]0;` starts the title command, `\x07` (BEL) ends it
 *
 * We write directly to /dev/tty to bypass OpenTUI's stdout capture,
 * similar to how clipboard.ts handles OSC52 sequences.
 */

import { IS_FREEBUFF } from './constants'
import { getCliEnv } from './env'
import { writeTerminalControlSync } from './terminal-io'

const MAX_TITLE_LENGTH = 60
const TITLE_PREFIX = IS_FREEBUFF ? 'Freebuff: ' : 'Codebuff: '
const OSC_TERMINATOR = '\x07' // BEL

type MultiplexerEnv = Pick<
  ReturnType<typeof getCliEnv>,
  'TMUX' | 'STY' | 'TERM'
>

function isInTmux(env: MultiplexerEnv): boolean {
  return Boolean(env.TMUX)
}

function isInScreen(env: MultiplexerEnv): boolean {
  if (env.STY) return true
  const term = env.TERM ?? ''
  return term.startsWith('screen') && !isInTmux(env)
}

/** Wrap an OSC sequence for tmux/screen passthrough, if one is in the way. */
export function wrapForMultiplexer(
  sequence: string,
  env: MultiplexerEnv,
): string {
  // tmux passthrough: wrap in DCS and double ESC characters
  if (isInTmux(env)) {
    const escaped = sequence.replace(/\x1b/g, '\x1b\x1b')
    return `\x1bPtmux;${escaped}\x1b\\`
  }

  // GNU screen passthrough: wrap in DCS
  if (isInScreen(env)) {
    return `\x1bP${sequence}\x1b\\`
  }

  return sequence
}

/**
 * Build the OSC title sequence with tmux/screen passthrough if needed
 */
function buildTitleSequence(title: string, env: MultiplexerEnv): string {
  return wrapForMultiplexer(`\x1b]0;${title}${OSC_TERMINATOR}`, env)
}

/**
 * Set the terminal window title.
 * Works on most modern terminal emulators, including through tmux and screen.
 *
 * @param title - The title to set (will be truncated if too long)
 */
export function setTerminalTitle(title: string): void {
  // Sanitize: remove control characters and newlines
  const sanitized = title.replace(/[\x00-\x1f\x7f]/g, ' ').trim()
  if (!sanitized) return

  // Truncate to reasonable length
  const maxInputLength = MAX_TITLE_LENGTH - TITLE_PREFIX.length
  const truncated =
    sanitized.length > maxInputLength
      ? sanitized.slice(0, maxInputLength - 1) + '…'
      : sanitized

  const fullTitle = `${TITLE_PREFIX}${truncated}`
  const env = getCliEnv()
  const sequence = buildTitleSequence(fullTitle, env)

  writeTerminalControlSync(sequence)
}

/**
 * Reset the terminal title to the default.
 * Call this when the CLI exits to restore the terminal to a clean state.
 */
export function resetTerminalTitle(): void {
  // Empty title resets to terminal's default behavior
  const env = getCliEnv()
  const sequence = buildTitleSequence('', env)
  writeTerminalControlSync(sequence)
}
