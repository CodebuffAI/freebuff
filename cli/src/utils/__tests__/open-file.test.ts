import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { openFileAtPath } from '../open-file'

import type { CliEnv } from '../../types/env'

// The editor command runs through `shell: true`; these use POSIX `sh`.
describe.skipIf(process.platform === 'win32')('openFileAtPath placeholders', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'open-file-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // A repo-controlled agent file name: shell metacharacters, a quote, and
  // `$&` / `$'` (special in String.replace replacement strings).
  const hostile = () =>
    path.join(dir, `a b';touch ${path.join(dir, 'pwned')};echo '$&$'c`)

  const run = async (editor: string, filePath: string) => {
    const out = path.join(dir, 'out')
    const env = {
      CODEBUFF_EDITOR: editor.replace('OUT', out),
    } as unknown as CliEnv
    const ok = await openFileAtPath(filePath, env)
    return { ok, out }
  }

  // Quoted forms too: a user's `code -g "%f"` must not hand the editor the
  // already-quoted path wrapped in a second pair of quotes.
  test.each(['%f', '{file}', '"%f"', "'%f'", '"{file}"'])(
    '%s passes the path as one literal argument and runs nothing else',
    async (placeholder) => {
      const filePath = hostile()
      const { ok, out } = await run(
        `sh -c 'printf %s "$1" > OUT' _ ${placeholder}`,
        filePath,
      )

      expect(ok).toBe(true)
      expect(readFileSync(out, 'utf8')).toBe(filePath)
      expect(existsSync(path.join(dir, 'pwned'))).toBe(false)
    },
  )

  test('a command separator in the file name does not run a second command', async () => {
    const filePath = path.join(dir, `a;touch ${path.join(dir, 'pwned')}`)
    const { ok } = await run(`true %f`, filePath)

    expect(ok).toBe(true)
    expect(existsSync(path.join(dir, 'pwned'))).toBe(false)
  })

  test('an editor without a placeholder still gets the quoted path appended', async () => {
    const filePath = hostile()
    const { ok, out } = await run(
      `sh -c 'printf %s "$1" > OUT' _`,
      filePath,
    )

    expect(ok).toBe(true)
    expect(readFileSync(out, 'utf8')).toBe(filePath)
    expect(existsSync(path.join(dir, 'pwned'))).toBe(false)
  })
})
