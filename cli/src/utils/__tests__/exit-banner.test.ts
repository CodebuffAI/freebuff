import { describe, expect, test } from 'bun:test'

import {
  BRAND_NAME,
  CONTINUE_LABEL,
  LOCKUP_MIN_WIDTH,
  MARK_HEIGHT,
  MARK_MIN_WIDTH,
  SESSION_LABEL,
  WORDMARK_HEIGHT,
  buildExitBanner,
  exitBannerSupportsColor,
  frameExitBanner,
  renderWordmark,
} from '../exit-banner'

/**
 * Tests for the banner printed on the way out.
 *
 * It runs while the process tears down, with no renderer and no theme left, so
 * the only way to hold on to its behaviour is to keep the composition pure and
 * pin it here.
 */

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g
const stripAnsi = (text: string) => text.replace(ANSI_PATTERN, '')
const visibleWidth = (text: string) => [...stripAnsi(text)].length
const lines = (text: string) => stripAnsi(text).split('\n')

/** The value of a labelled row, and the column it starts at. */
const labelValue = (text: string, label: string) => {
  const line = lines(text).find((candidate) => candidate.includes(label))!
  const after = line.slice(line.indexOf(label) + label.length)
  const value = after.trimStart()
  return { value, column: line.length - value.length }
}

const CHAT_ID = '2026-09-15T10-53-36.839Z'
const COMMAND = `freebuff --continue ${CHAT_ID}`

const banner = (
  overrides: Partial<Parameters<typeof buildExitBanner>[0]> = {},
) =>
  buildExitBanner({
    cliName: 'freebuff',
    chatId: CHAT_ID,
    terminalWidth: 80,
    color: true,
    ...overrides,
  })

describe('buildExitBanner', () => {
  test('returns nothing when there is no session to come back to', () => {
    expect(banner({ chatId: '' })).toBeNull()
  })

  test('the command is the last line and is never clipped', () => {
    // It is the reason the banner exists: whatever else a narrow terminal
    // costs, the command has to arrive intact.
    for (const terminalWidth of [120, 80, 60, 40, 19]) {
      expect(
        lines(banner({ terminalWidth })!).at(-1)!.trimEnd().endsWith(COMMAND),
      ).toBe(true)
    }
  })

  test('the label column aligns Session and Continue', () => {
    const text = banner()!

    expect(labelValue(text, SESSION_LABEL).column).toBe(
      labelValue(text, CONTINUE_LABEL).column,
    )
    expect(labelValue(text, CONTINUE_LABEL).value).toBe(COMMAND)
  })

  test('a command that cannot sit beside its label falls back to the bare line', () => {
    // The labelled row spends 12 columns before the command, so a terminal too
    // narrow for that gets the command on its own — with nothing in front of it
    // to swallow it on paste.
    expect(banner({ terminalWidth: 80 })).toContain(CONTINUE_LABEL)

    const narrow = banner({ terminalWidth: 40 })!
    expect(narrow).not.toContain(CONTINUE_LABEL)
    expect(lines(narrow).at(-1)).toBe(COMMAND)
  })

  test('every escape it opens is closed', () => {
    const text = banner()!
    const resets = text.split('\u001b[0m').length - 1
    const opens = ['\u001b[1m', '\u001b[2m', '\u001b[92m'].reduce(
      (total, code) => total + (text.split(code).length - 1),
      0,
    )

    expect(opens).toBeGreaterThan(0)
    expect(resets).toBe(opens)
  })

  test('the mark fits whenever it is drawn', () => {
    // MARK_MIN_WIDTH is the smallest terminal that gets the mark, so the art
    // must never be wider than that or it would wrap on the way out.
    const markLines = lines(banner({ terminalWidth: MARK_MIN_WIDTH })!).filter(
      (line) => line.includes('█'),
    )

    expect(markLines.length).toBeGreaterThan(0)
    for (const line of markLines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(MARK_MIN_WIDTH)
    }
  })

  test('a narrow terminal drops the mark but keeps the command', () => {
    const text = banner({ terminalWidth: MARK_MIN_WIDTH - 1 })!

    expect(text).not.toContain('█')
    expect(lines(text).at(-1)).toBe(COMMAND)
  })

  test('without colour the layout is unchanged and nothing escapes', () => {
    const plain = banner({ color: false })!
    const colored = banner()!

    expect(plain).not.toContain('\u001b')
    expect(plain).toBe(stripAnsi(colored))
  })

  test('labels are dim and values are bold', () => {
    const text = banner()!

    expect(text).toContain(`\u001b[2m${SESSION_LABEL}`)
    expect(text).toContain(`\u001b[1m${CHAT_ID}`)
  })

  test('shows the session label when there is one', () => {
    const text = banner({ sessionLabel: 'Fix the status bar lanes' })!

    expect(labelValue(text, SESSION_LABEL).value).toBe(
      'Fix the status bar lanes',
    )
  })

  test('falls back to the id when there is no label', () => {
    for (const sessionLabel of [undefined, '', '   ']) {
      expect(labelValue(banner({ sessionLabel })!, SESSION_LABEL).value).toBe(
        CHAT_ID,
      )
    }
  })

  test('a long label is clipped to the terminal width', () => {
    const terminalWidth = 40
    const sessionRow = lines(
      banner({ terminalWidth, sessionLabel: 'x'.repeat(200) })!,
    ).find((line) => line.includes(SESSION_LABEL))!

    expect(sessionRow.endsWith('…')).toBe(true)
    expect(visibleWidth(sessionRow)).toBeLessThanOrEqual(terminalWidth)
  })

  test('an unusable width still composes instead of throwing', () => {
    for (const terminalWidth of [0, Number.NaN]) {
      expect(lines(banner({ terminalWidth })!).at(-1)).toContain('--continue')
    }
  })
})

describe('renderWordmark', () => {
  const width = (text: string) => [...renderWordmark(text)[0]!].length

  test('spells a name in three rows of one width', () => {
    const rows = renderWordmark('FREEBUFF')

    expect(rows).toHaveLength(WORDMARK_HEIGHT)
    expect(new Set(rows.map((row) => [...row].length)).size).toBe(1)
  })

  test('both brand names measure the same, so one layout serves both', () => {
    expect(width('CODEBUFF')).toBe(width('FREEBUFF'))
  })

  test('is case-insensitive', () => {
    expect(renderWordmark('freebuff')).toEqual(renderWordmark('FREEBUFF'))
  })

  test('a character it does not have leaves a blank, not a broken row', () => {
    // Degrading beats throwing: this runs while the process is exiting.
    expect([...renderWordmark('F?F')[0]!].slice(4, 7).join('')).toBe('   ')
    expect(width('F?F')).toBe(width('FFF'))
  })
})

describe('the lockup', () => {
  test('spells the brand beside the mark when the terminal is wide enough', () => {
    const rows = lines(banner({ terminalWidth: 80 })!)

    for (const brandRow of renderWordmark(BRAND_NAME)) {
      expect(rows.some((row) => row.includes(brandRow.trimEnd()))).toBe(true)
    }
  })

  test('the mark is a rectangle, so its border lines up', () => {
    // Hand-drawn art: one row out of step is invisible in review and obvious
    // on screen, so the canvas is pinned here.
    const rows = lines(banner({ terminalWidth: MARK_MIN_WIDTH })!).slice(
      0,
      MARK_HEIGHT,
    )

    expect(rows).toHaveLength(MARK_HEIGHT)
    expect(new Set(rows.map(visibleWidth)).size).toBe(1)
  })

  test('a terminal too narrow for the name keeps the mark alone', () => {
    const text = banner({ terminalWidth: LOCKUP_MIN_WIDTH - 1 })!

    // Only the wordmark draws half blocks, so their absence is the name
    // standing down — the mark stays, because the brand still has to show.
    expect(text).not.toContain('▀')
    expect(text).toContain('█')
  })

  test('no mark line is wider than the terminal it was drawn for', () => {
    // The command below the mark is exempt: it is never clipped, on purpose.
    for (const terminalWidth of [120, 80, LOCKUP_MIN_WIDTH, MARK_MIN_WIDTH]) {
      const markRows = lines(banner({ terminalWidth })!).filter(
        (row) => row.includes('█') || row.includes('▀'),
      )

      expect(markRows.length).toBeGreaterThan(0)
      for (const row of markRows) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(terminalWidth)
      }
    }
  })
})

describe('frameExitBanner', () => {
  test('breathes above and below, so it never touches the shell prompt', () => {
    expect(frameExitBanner('banner')).toBe('\nbanner\n\n')
  })
})

describe('exitBannerSupportsColor', () => {
  test('a plain interactive terminal is painted', () => {
    expect(exitBannerSupportsColor({ env: {}, isTty: true })).toBe(true)
  })

  test('a pipe never is', () => {
    expect(exitBannerSupportsColor({ env: {}, isTty: false })).toBe(false)
  })

  test('NO_COLOR opts out, even on a terminal', () => {
    expect(
      exitBannerSupportsColor({ env: { NO_COLOR: '1' }, isTty: true }),
    ).toBe(false)
  })

  test('an empty NO_COLOR is not an opt-out', () => {
    expect(
      exitBannerSupportsColor({ env: { NO_COLOR: '' }, isTty: true }),
    ).toBe(true)
  })

  test('a dumb terminal gets plain text', () => {
    expect(
      exitBannerSupportsColor({ env: { TERM: 'dumb' }, isTty: true }),
    ).toBe(false)
  })

  test('FORCE_COLOR wins, including through a pipe', () => {
    expect(
      exitBannerSupportsColor({ env: { FORCE_COLOR: '1' }, isTty: false }),
    ).toBe(true)
    expect(
      exitBannerSupportsColor({
        env: { FORCE_COLOR: '1', NO_COLOR: '1' },
        isTty: true,
      }),
    ).toBe(true)
  })

  test('FORCE_COLOR=0 turns colour off', () => {
    expect(
      exitBannerSupportsColor({ env: { FORCE_COLOR: '0' }, isTty: true }),
    ).toBe(false)
  })
})
