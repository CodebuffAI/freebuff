import { describe, expect, it } from 'bun:test'

import { codeSearchExecFlagRefusal } from '../code-search-flags'

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
