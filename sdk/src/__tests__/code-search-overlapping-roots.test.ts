import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, test } from 'bun:test'

import { codeSearch } from '../tools/code-search'

test('counts each result once when JSON search roots overlap', async () => {
  const parent = realpathSync(tmpdir())
  const root = mkdtempSync(path.join(parent, 'code-search-overlap-'))
  try {
    mkdirSync(path.join(root, '.github'))
    writeFileSync(
      path.join(root, '.github', 'ci.yml'),
      'needle first\ncontext middle\nneedle last\n',
    )
    writeFileSync(path.join(root, 'visible.txt'), 'needle visible\n')

    const [result] = await codeSearch({
      projectPath: root,
      pattern: 'needle',
      flags: '--hidden -C 1',
      globalMaxResults: 4,
    })
    const { stdout, message } = (
      result as { value: { stdout: string; message: string } }
    ).value

    expect(stdout.split('\n')[0]).toBe('Found 3 matches')
    expect(message).toBe('Exit code: 0')
    for (const line of [
      'Line 1: needle first',
      'Line 2: context middle',
      'Line 3: needle last',
      'Line 1: needle visible',
    ]) {
      expect(stdout.split(line)).toHaveLength(2)
    }
  } finally {
    if (path.dirname(path.resolve(root)) !== parent) {
      throw new Error('Fixture escaped temp root')
    }
    rmSync(root, { recursive: true, force: true })
  }
})
