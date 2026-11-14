import { describe, expect, it } from 'bun:test'

import {
  codeSearchExecFlagRefusal,
  codeSearchOutputFormat,
} from '../code-search-flags'

const REFUSED: string[][] = [
  ['--pre', 'sh'],
  ['--pre=sh'],
  ['--pre='],
  ['--pre-glob', '*.ts'],
  ['--pre-glob=*.ts'],
  ['--hostname-bin', '/tmp/x'],
  ['--hostname-bin=/tmp/x'],
  ['--search-zip'],
  ['-z'],
  ['-uz'],
  ['-izu'],
  ['-i', '-g', '*.ts', '--pre', 'sh'],
  // Ripgrep reads this `-z` as the glob's value; refusing it costs nothing.
  ['-g', '-z'],
]

const ALLOWED: string[][] = [
  [],
  ['-i', '-w', '-F'],
  ['-A', '2', '-B', '3', '-C', '1', '-m', '5'],
  ['-g', '*.zip', '-t', 'ts', '-T', 'js'],
  ['--glob=*.tsz', '--type=ts'],
  // `z` after a value-taking short flag is that flag's value, not -z.
  ['-gz'],
  ['-ez'],
  ['--no-pre', '--no-search-zip'],
  ['--hyperlink-format=none', '--max-columns=200'],
  // Values that merely contain a denied name are not flags.
  ['-g', 'x --pre /bin/cat'],
  ['pre', 'search-zip'],
]

describe('codeSearchExecFlagRefusal', () => {
  for (const tokens of REFUSED) {
    it(`refuses ${JSON.stringify(tokens)}`, () => {
      expect(codeSearchExecFlagRefusal(tokens)).toContain(
        'makes ripgrep run another program',
      )
    })
  }

  it('names the refused flag', () => {
    expect(codeSearchExecFlagRefusal(['--pre=sh'])).toContain('--pre ')
    expect(codeSearchExecFlagRefusal(['-iuz'])).toContain('-z ')
  })

  for (const tokens of ALLOWED) {
    it(`allows ${JSON.stringify(tokens)}`, () => {
      expect(codeSearchExecFlagRefusal(tokens)).toBeNull()
    })
  }
})

describe('codeSearchOutputFormat', () => {
  // Each expectation was read off the bundled ripgrep 15.2.0.
  const FORMATS: [string[], 'json' | 'paths' | 'counts'][] = [
    [[], 'json'],
    [['-i', '-w', '-A', '2'], 'json'],
    // -L is --follow, not --files-without-match.
    [['-L'], 'json'],
    [['-l'], 'paths'],
    [['--files-with-matches'], 'paths'],
    [['--files-without-match'], 'paths'],
    [['-il'], 'paths'],
    [['-c'], 'counts'],
    [['--count'], 'counts'],
    [['--count-matches'], 'counts'],
    // The last mode wins, inside a cluster and across tokens.
    [['-lc'], 'counts'],
    [['-cl'], 'paths'],
    [['-c', '-l'], 'paths'],
    [['-l', '--json'], 'json'],
    [['--files-with-matches', '--count'], 'counts'],
    // A flag's value is not a flag.
    [['-e', '-c'], 'json'],
    [['-g', '-l'], 'json'],
    [['--glob', '-l'], 'json'],
    [['--regexp=-c', '-i'], 'json'],
    [['-gl'], 'json'],
    [['-ilg', '*.ts'], 'paths'],
    [['-ig', '-c'], 'json'],
    // Past `--` nothing is a flag.
    [['--', '-l'], 'json'],
  ]
  for (const [tokens, format] of FORMATS) {
    it(`reads ${JSON.stringify(tokens)} as ${format}`, () => {
      expect(codeSearchOutputFormat(tokens)).toEqual({
        format,
        listsFiles: false,
        refusal: null,
      })
    })
  }

  it('lists files only when --files is the last mode', () => {
    for (const tokens of [['--files'], ['-l', '--files'], ['--files', '-i']]) {
      expect(codeSearchOutputFormat(tokens)).toMatchObject({
        format: 'paths',
        listsFiles: true,
      })
    }
    expect(codeSearchOutputFormat(['--files', '-c'])).toMatchObject({
      format: 'counts',
      listsFiles: false,
    })
    expect(codeSearchOutputFormat(['--files', '--json'])).toMatchObject({
      format: 'json',
      listsFiles: false,
    })
  })

  for (const [tokens, flag] of [
    [['--type-list'], '--type-list'],
    [['--help'], '--help'],
    [['-h'], '-h'],
    [['--version'], '--version'],
    [['-V'], '-V'],
    [['--pcre2-version'], '--pcre2-version'],
    [['--generate', 'man'], '--generate'],
    [['--generate=man'], '--generate'],
    [['-q'], '-q'],
    [['-iq'], '-q'],
    [['--quiet', '-c'], '--quiet'],
    [['--no-json'], '--no-json'],
  ] as [string[], string][]) {
    it(`refuses ${JSON.stringify(tokens)}, which leaves nothing to read`, () => {
      expect(codeSearchOutputFormat(tokens).refusal).toContain(`flag ${flag} `)
    })
  }

  it('leaves a value that looks like a refused flag alone', () => {
    expect(codeSearchOutputFormat(['-e', '-q']).refusal).toBeNull()
    expect(codeSearchOutputFormat(['-gq']).refusal).toBeNull()
  })
})
