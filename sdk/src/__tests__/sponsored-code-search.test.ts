import { describe, expect, it } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  createSponsoredCodeSearchBroker,
  sponsoredRipgrepArgs,
} from '../tools/sponsored-sandbox'
import { codeSearch } from '../tools/code-search'
import { getBundledRgPath } from '../native/ripgrep'

/**
 * Sponsored `code_search` with FIXED ripgrep arguments, spawned directly
 * (COD-642).
 *
 * Kept apart from `sponsored-sandbox.test.ts` so it can run on Windows CI
 * (`smoke-windows-bash`): nothing here needs a shell or an OS sandbox. The
 * sandboxed macOS/Linux search is exercised by the contained test in that
 * suite.
 */

function workspace(): { root: string; runtime: string; parent: string } {
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sponsored-search-')),
  )
  const root = path.join(parent, 'worktree')
  const runtime = path.join(parent, 'runtime')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(runtime, { recursive: true })
  return { root, runtime, parent }
}

describe('sponsored code search: fixed arguments, no shell', () => {
  it('runs ripgrep only with the argv it builds, and appends the fixed flags last', () => {
    const { root, parent } = workspace()
    fs.mkdirSync(path.join(root, '.github'))
    try {
      expect(
        sponsoredRipgrepArgs(
          [
            '--no-config',
            '-n',
            '--json',
            '-i',
            '-g',
            '*.ts',
            '--',
            '-x',
            '.',
            '.github',
          ],
          root,
        ),
      ).toEqual([
        '--no-config',
        '-n',
        '--json',
        '-i',
        '-g',
        '*.ts',
        // After the caller's flags, so ripgrep's last-flag-wins makes them stick.
        '--no-follow',
        '--no-ignore-parent',
        '--no-ignore-global',
        '--',
        '-x',
        '.',
        '.github',
      ])
      for (const args of [
        ['-n', '--json', '--', 'x', '.'],
        ['--no-config', '-n', '--json', '--pre', 'cat', '--', 'x', '.'],
        ['--no-config', '-n', '--json', '--follow', '--', 'x', '.'],
        ['--no-config', '-n', '--json', '--ignore-file', 'x', '--', 'x', '.'],
        ['--no-config', '-n', '--json', '--', 'x', '/etc'],
        ['--no-config', '-n', '--json', '--', 'x', '..'],
        ['--no-config', '-n', '--json', 'x', '.'],
        ['--no-config', '-n', '--json', '--'],
      ]) {
        expect(() => sponsoredRipgrepArgs(args, root), args.join(' ')).toThrow()
      }
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('drops an included hidden directory that is a link, since ripgrep follows a named path', () => {
    const { root, parent } = workspace()
    const outside = path.join(parent, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(
      outside,
      path.join(root, '.github'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    try {
      expect(
        sponsoredRipgrepArgs(
          ['--no-config', '-n', '--json', '--', 'x', '.', '.github'],
          root,
        ).slice(-2),
      ).toEqual(['x', '.'])
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('checks the working directory before it reads anything under it', () => {
    // `sponsoredRipgrepArgs` lstats the hidden search roots under the cwd, so
    // the cwd has to be judged first. The argv here is ALSO refusable (`--pre`)
    // so the order is observable: the cwd refusal must be the one that lands.
    const { root, runtime, parent } = workspace()
    const outside = path.join(parent, 'outside')
    fs.mkdirSync(path.join(outside, '.github'), { recursive: true })
    const rgPath = getBundledRgPath(import.meta.url)
    try {
      for (const platform of [process.platform, 'win32' as const]) {
        const broker = createSponsoredCodeSearchBroker({
          workspaceRoot: root,
          runtimeDir: runtime,
          platform,
        })
        expect(
          () =>
            broker.start({
              executable: rgPath,
              args: [
                '--no-config',
                '-n',
                '--json',
                '--pre',
                'cat',
                '--',
                'x',
                '.',
                '.github',
              ],
              cwd: outside,
              env: {},
            }),
          platform,
        ).toThrow(/inside its own worktree/)
      }
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('runs ripgrep directly, with no shell and no sandbox, on Windows', async () => {
    // Windows has no OS sandbox and no `/bin/sh`, so a search there spawns the
    // bundled binary itself. Exercised on every OS by naming the platform,
    // since the direct spawn is the same code whatever binary it starts; on
    // Windows CI it starts the real `rg.exe`.
    const { root, runtime, parent } = workspace()
    const outside = path.join(parent, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'NEEDLE_OUTSIDE\n')
    fs.writeFileSync(
      path.join(root, 'inside.ts'),
      'export const NEEDLE = true\n',
    )
    try {
      const processBroker = createSponsoredCodeSearchBroker({
        workspaceRoot: root,
        runtimeDir: runtime,
        platform: 'win32',
      })
      const found = await codeSearch({
        projectPath: root,
        pattern: 'NEEDLE',
        flags: '-g *.ts',
        processBroker,
      })
      expect(JSON.stringify(found)).toContain('export const NEEDLE = true')
      expect(JSON.stringify(found)).not.toContain('NEEDLE_OUTSIDE')

      // The working directory is re-checked by the broker itself, not left to
      // the surface that called it.
      const refused = await codeSearch({
        projectPath: root,
        pattern: 'NEEDLE',
        cwd: outside,
        processBroker,
      })
      expect(JSON.stringify(refused)).toContain('inside its own worktree')
      expect(JSON.stringify(refused)).not.toContain('NEEDLE_OUTSIDE')

      // Nothing to stage for: the binary runs where it is installed.
      expect(
        fs.readdirSync(runtime).filter((name) => name.startsWith('rg-')),
      ).toEqual([])
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})
