import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  describeForeignPreload,
  foreignPreloadFrom,
  REFUSE_FOREIGN_PRELOAD,
} from '../preload-guard'

describe('foreignPreloadFrom', () => {
  test('finds a --preload outside the bundle', () => {
    expect(
      foreignPreloadFrom({ execArgv: ['--preload', '/tmp/hook.ts'] }),
    ).toBe('/tmp/hook.ts')
  })

  test('ignores a preload inside the compiled bundle', () => {
    expect(
      foreignPreloadFrom({
        execArgv: ['--preload', '/$bunfs/root/embedded.ts'],
      }),
    ).toBeNull()
  })

  test('finds the -r form', () => {
    expect(foreignPreloadFrom({ execArgv: ['-r', '/tmp/hook.js'] })).toBe(
      '/tmp/hook.js',
    )
  })

  test('finds the --require= form', () => {
    expect(
      foreignPreloadFrom({ execArgv: ['--require=/tmp/hook.js'] }),
    ).toBe('/tmp/hook.js')
  })

  test('ignores an empty flag value and an empty argv', () => {
    expect(foreignPreloadFrom({ execArgv: ['--preload=', '-e', 'x'] })).toBeNull()
    expect(foreignPreloadFrom({ execArgv: [] })).toBeNull()
  })

  test('finds a loaded module outside the bundle', () => {
    expect(
      foreignPreloadFrom({
        execArgv: [],
        loadedModules: ['/tmp/hook.ts', '/$bunfs/root/freebuff'],
      }),
    ).toBe('/tmp/hook.ts')
  })

  test('ignores loaded modules that are all inside the bundle', () => {
    expect(
      foreignPreloadFrom({
        execArgv: [],
        loadedModules: ['/$bunfs/root/freebuff', '/$bunfs/root/a.ts'],
      }),
    ).toBeNull()
  })

  test('ignores a module inside the working directory (a repo bunfig preload)', () => {
    // Bun reads `preload` from a bunfig.toml in cwd, so the CLI run inside a
    // user's own repository must not refuse on that repository's setup file.
    expect(
      foreignPreloadFrom({
        execArgv: [],
        loadedModules: ['/repo/setup.ts'],
        cwd: '/repo',
      }),
    ).toBeNull()
    expect(
      foreignPreloadFrom({
        execArgv: [],
        loadedModules: ['/repo/setup.ts'],
        cwd: '/repo/',
      }),
    ).toBeNull()
    // A sibling whose name merely starts with the cwd is NOT inside it.
    expect(
      foreignPreloadFrom({
        execArgv: [],
        loadedModules: ['/repository/setup.ts'],
        cwd: '/repo',
      }),
    ).toBe('/repository/setup.ts')
  })

  test('prefers the command line over the cache', () => {
    expect(
      foreignPreloadFrom({
        execArgv: ['--preload', '/tmp/from-argv.ts'],
        loadedModules: ['/tmp/from-cache.ts'],
      }),
    ).toBe('/tmp/from-argv.ts')
  })
})

describe('describeForeignPreload', () => {
  test('names the path and never claims a refusal this build did not make', () => {
    const message = describeForeignPreload('/tmp/hook.ts')
    expect(message).toContain('/tmp/hook.ts')
    expect(message).toContain('warning')
    expect(message).not.toContain('refused to start')
  })

  test('asks the user for nothing - no variable, no flag', () => {
    const message = describeForeignPreload('/tmp/hook.ts')
    expect(message).not.toContain('FREEBUFF_PRELOAD_GUARD')
    expect(message).not.toContain('enforce')
    expect(message).not.toContain('BUN_OPTIONS')
  })

  test('the build policy is a constant, not an environment lookup', () => {
    // Guards the decision itself: a runtime switch here is how the control ends
    // up unset on every machine that never read the release notes.
    expect(REFUSE_FOREIGN_PRELOAD).toBe(false)
  })
})

/**
 * The parser tests above feed `execArgv` by hand, so they prove the parser.
 * This one spawns a real Bun with `BUN_OPTIONS=--preload` and asserts the two
 * things the guard rests on: Bun runs the hook before the entry point, and it
 * reports the flag in `process.execArgv`. If a Bun release stops doing either,
 * the guard silently stops detecting and this test is what says so.
 */
describe('the BUN_OPTIONS channel', () => {
  test('a preload from BUN_OPTIONS runs and lands in execArgv', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preload-guard-'))
    const hook = path.join(dir, 'hook.ts')
    const ran = path.join(dir, 'hook-ran')
    const probe = path.join(dir, 'probe.ts')
    const guardModule = new URL('../preload-guard.ts', import.meta.url).href

    fs.writeFileSync(hook, `await Bun.write(${JSON.stringify(ran)}, 'yes')\n`)
    fs.writeFileSync(
      probe,
      [
        `const mod = await import(${JSON.stringify(guardModule)})`,
        'const found = mod.foreignPreloadFrom({ execArgv: process.execArgv })',
        'console.log(JSON.stringify({ argv: process.execArgv, found }))',
      ].join('\n'),
    )

    const run = (bunOptions: string) =>
      Bun.spawnSync([process.execPath, probe], {
        env: { ...process.env, BUN_OPTIONS: bunOptions },
        stdout: 'pipe',
        stderr: 'pipe',
      })

    try {
      const injected = run(`--preload ${hook}`)
      expect(injected.exitCode).toBe(0)
      expect(
        JSON.parse(injected.stdout.toString()) as {
          argv: string[]
          found: string | null
        },
      ).toEqual({ argv: ['--preload', hook], found: hook })
      expect(fs.existsSync(ran)).toBe(true)

      const clean = run('')
      expect(clean.exitCode).toBe(0)
      expect(
        (JSON.parse(clean.stdout.toString()) as { found: string | null }).found,
      ).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
