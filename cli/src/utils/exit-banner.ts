import { IS_FREEBUFF } from './constants'

/**
 * The banner a user reads on the way out, after the renderer is gone.
 *
 * Everything here is a plain string with ANSI escapes: no OpenTUI, no theme,
 * nothing from React. It can therefore only depend on what is still observable
 * during exit — the terminal width and whether colour is welcome — which is
 * also what makes it testable at all, since the process is already tearing
 * down by the time it runs.
 */

const ANSI_RESET = '\u001b[0m'
const ANSI_BOLD = '\u001b[1m'
const ANSI_DIM = '\u001b[2m'
/**
 * The acid green the login screen paints its logo shadow with (#9EFC62),
 * rounded to the 16-colour palette so it renders anywhere a theme colour would.
 */
const ANSI_ACCENT = '\u001b[92m'

/** The label column, wide enough for the longest label we print. */
const LABEL_WIDTH = 10
const INDENT = '  '
const ELLIPSIS = '…'

/** Row labels, aligned in one column the way opencode's exit banner does it. */
export const SESSION_LABEL = 'Session'
export const CONTINUE_LABEL = 'Continue'

/** The brand, spelled the way the login wordmark does. */
export const BRAND_NAME = IS_FREEBUFF ? 'FREEBUFF' : 'CODEBUFF'

/**
 * The mark: a terminal window — the thing the product actually is. Seven rows
 * of height against sixteen of width, with the prompt and its cursor on the
 * third line, where a shell that just opened would show them. Drawn as a
 * string literal so the whole banner stays a pure function of width and
 * colour, with nothing left to load at exit time.
 */
const MARK_LINES = [
  '╭──────────────╮',
  '│              │',
  '│ $ █          │',
  '│              │',
  '│              │',
  '│              │',
  '╰──────────────╯',
]
/** How many rows the mark costs, which is what the name is laid out against. */
export const MARK_HEIGHT = MARK_LINES.length
const MARK_WIDTH = Math.max(...MARK_LINES.map((line) => [...line].length))
/** The narrowest terminal that gets the mark is one that can hold it. */
export const MARK_MIN_WIDTH = MARK_WIDTH

/**
 * A three-row wordmark in the half-block style compact terminal banners use —
 * pagga's shapes: a full block for a vertical stroke, an upper or lower half
 * block for a horizontal one. Only the letters the two brand names need, so
 * both a Freebuff and a Codebuff build spell themselves.
 */
const WORDMARK_GLYPHS: Record<string, readonly [string, string, string]> = {
  B: ['█▀▄', '█▀▄', '▀▀ '],
  C: ['█▀▀', '█  ', '▀▀▀'],
  D: ['█▀▄', '█ █', '▀▀ '],
  E: ['█▀▀', '█▀▀', '▀▀▀'],
  F: ['█▀▀', '█▀▀', '▀  '],
  O: ['█▀█', '█ █', '▀▀▀'],
  R: ['█▀▄', '█▀▄', '▀ ▀'],
  U: ['█ █', '█ █', '▀▀▀'],
}

const WORDMARK_BLANK = '   '
/** How tall the wordmark is, which is also how many rows of text it costs. */
export const WORDMARK_HEIGHT = 3
/** Air between the mark and the name, so the two never read as one glyph. */
const WORDMARK_GAP = 3
/**
 * The name sits in the middle of the mark's spare rows. The difference is even,
 * so the split lands whole: two rows of air above the name, two below.
 */
const WORDMARK_TOP_PAD = Math.floor((MARK_HEIGHT - WORDMARK_HEIGHT) / 2)

const BRAND_ROWS = renderWordmark(BRAND_NAME)
const BRAND_WIDTH = Math.max(...BRAND_ROWS.map((row) => [...row].length))
/** The narrowest terminal that gets the name beside the mark. */
export const LOCKUP_MIN_WIDTH = MARK_WIDTH + WORDMARK_GAP + BRAND_WIDTH

/** The window's own frame, painted as accent green. */
const MARK_CHROME = new Set(['╭', '╮', '╰', '╯', '─', '│'])
/** The prompt and its cursor, painted as solid blocks. */
const MARK_SOLIDS = new Set(['█', '$'])

export type ExitBannerColorEnv = Record<string, string | undefined>

/**
 * Whether the banner may paint itself, following the conventions the rest of
 * the terminal world settled on: `FORCE_COLOR` wins, `NO_COLOR` opts out
 * (https://no-color.org/), a `dumb` terminal gets plain text, and a pipe is
 * never painted because whatever consumes it did not ask for escapes.
 */
export function exitBannerSupportsColor({
  env,
  isTty,
}: {
  env: ExitBannerColorEnv
  isTty: boolean
}): boolean {
  if (env.FORCE_COLOR !== undefined) {
    return env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0'
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.TERM === 'dumb') return false
  return isTty
}

export type ExitBannerInput = {
  /** How this CLI is launched, so the printed command is a runnable one. */
  cliName: string
  /** The conversation to come back to. */
  chatId: string
  /**
   * Human label for that conversation — its first prompt. Omitted when the
   * chat has nothing to show, in which case the id stands in for it.
   */
  sessionLabel?: string | undefined
  terminalWidth: number
  color: boolean
}

/**
 * Compose the banner, or null when there is no session to come back to.
 *
 * The mark is a terminal window, labels sit in a dim column and values are
 * bold — the shape opencode's exit banner uses.
 */
export function buildExitBanner({
  cliName,
  chatId,
  sessionLabel,
  terminalWidth,
  color,
}: ExitBannerInput): string | null {
  if (!chatId) return null

  const width =
    Number.isFinite(terminalWidth) && terminalWidth > 0 ? terminalWidth : 80
  // Named `wrap` rather than `paint` on purpose: the module-level `paint`
  // takes (text, color) and would otherwise be shadowed here, silently
  // style-rounding a boolean into the string it was meant to colour.
  const wrap = (code: string, text: string) =>
    color ? `${code}${text}${ANSI_RESET}` : text
  const row = (label: string, value: string) =>
    `${INDENT}${wrap(ANSI_DIM, label.padEnd(LABEL_WIDTH))}${wrap(ANSI_BOLD, value)}`

  const label = clip(
    (sessionLabel ?? '').trim() || chatId,
    width - INDENT.length - LABEL_WIDTH,
  )
  const command = `${cliName} --continue ${chatId}`
  // The command is the reason this banner exists, so it is never clipped: it
  // gets a labelled row when that row fits, and the bare line — nothing to
  // swallow it on paste — when the terminal is too narrow for one.
  const commandFitsInLabelColumn =
    width >= INDENT.length + LABEL_WIDTH + command.length

  const lines: string[] = []
  if (width >= LOCKUP_MIN_WIDTH) {
    lines.push(...renderLockup(color), '')
  } else if (width >= MARK_MIN_WIDTH) {
    lines.push(...MARK_LINES.map((line) => paint(line, color)), '')
  }

  lines.push(row(SESSION_LABEL, label))
  lines.push(
    commandFitsInLabelColumn
      ? row(CONTINUE_LABEL, command)
      : wrap(ANSI_BOLD, command),
  )

  return lines.join('\n')
}

/**
 * The banner plus the breathing room it needs: a blank line above and below,
 * so it never touches the last line of the conversation nor the shell prompt
 * that returns right after it.
 */
export function frameExitBanner(banner: string): string {
  return `\n${banner}\n\n`
}

/**
 * Spell `text` in the half-block wordmark, one string per row, all the same
 * width. A character the table does not have leaves a blank rather than
 * throwing, so an unexpected brand name degrades instead of crashing an exit.
 */
export function renderWordmark(text: string): string[] {
  const glyphs = [...text.toUpperCase()].map(
    (char) => WORDMARK_GLYPHS[char] ?? null,
  )

  return Array.from({ length: WORDMARK_HEIGHT }, (_, row) =>
    glyphs.map((glyph) => glyph?.[row] ?? WORDMARK_BLANK).join(' '),
  )
}

/** The mark with the name beside it, both on the mark's rows. */
function renderLockup(color: boolean): string[] {
  return MARK_LINES.map((markLine, index) => {
    const brandRow = BRAND_ROWS[index - WORDMARK_TOP_PAD]
    // Trailing blanks are dropped before painting, so a painted space cannot
    // outlive the layout that put it there.
    const gap = brandRow
      ? ' '.repeat(MARK_WIDTH - [...markLine].length + WORDMARK_GAP)
      : ''
    return paint(`${markLine}${gap}${brandRow ?? ''}`.trimEnd(), color)
  })
}

/**
 * Theme-independent ANSI for both halves of the lockup: the window's chrome
 * and the wordmark's bars in accent green, the cursor and the prompt in bold,
 * so the mark and the name share one palette.
 */
function paint(text: string, color: boolean): string {
  if (!color) return text
  return [...text]
    .map((char) => {
      if (MARK_SOLIDS.has(char)) return `${ANSI_BOLD}${char}${ANSI_RESET}`
      if (MARK_CHROME.has(char) || char === '▀' || char === '▄') {
        return `${ANSI_ACCENT}${char}${ANSI_RESET}`
      }
      return char
    })
    .join('')
}

/** Keep a label inside the terminal, counting cells rather than bytes. */
function clip(text: string, max: number): string {
  if (max <= 0) return ''
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}${ELLIPSIS}`
}
