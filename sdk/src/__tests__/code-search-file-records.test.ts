import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { PassThrough } from 'stream'

import { codeSearch } from '../tools/code-search'

import type { TerminalCommandBroker } from '../tools/run-terminal-command'

/**
 * `-l`, `-c` and friends print plain text even with `--json` ahead of them, so
 * these searches run the bundled ripgrep: a fixture would only repeat what we
 * assume it prints.
 */
describe('codeSearch: ripgrep modes that ignore --json', () => {
  let root: string

  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  }

  const search = async (
    pattern: string,
    flags?: string,
    options: Partial<Parameters<typeof codeSearch>[0]> = {},
  ) => {
    const [result] = await codeSearch({
      projectPath: root,
      pattern,
      flags,
      ...options,
    })
    return (result as { value: Record<string, string | undefined> }).value
  }

  /** The result's lines after the header, sorted: ripgrep's order is unstable. */
  const listed = (stdout: string | undefined) =>
    (stdout ?? '').split('\n').slice(1).sort()

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'code-search-modes-')))
    write('a.txt', 'needle\nneedle needle\nhay\n')
    write('b.txt', 'hay\n')
    write('sub/c.txt', 'needle\n')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  for (const flags of ['-l', '--files-with-matches', '-il', '-cl', '-c -l']) {
    it(`returns matching filenames for ${flags}`, async () => {
      const result = await search('needle', flags)
      expect(result.stdout!.split('\n')[0]).toBe('Found 2 matches')
      expect(listed(result.stdout)).toEqual(['./a.txt', './sub/c.txt'])
      expect(result.message).toBe('Exit code: 0')
    })
  }

  for (const flags of ['-c', '--count', '-ic', '-lc', '-l -c']) {
    it(`returns per-file counts for ${flags}`, async () => {
      const result = await search('needle', flags)
      expect(result.stdout!.split('\n')[0]).toBe('Found 3 matches')
      expect(listed(result.stdout)).toEqual(['./a.txt:2', './sub/c.txt:1'])
    })
  }

  it('counts every match for --count-matches', async () => {
    const result = await search('needle', '--count-matches')
    expect(result.stdout!.split('\n')[0]).toBe('Found 4 matches')
    expect(listed(result.stdout)).toEqual(['./a.txt:3', './sub/c.txt:1'])
  })

  it('lists the files with no match for --files-without-match', async () => {
    const result = await search('needle', '--files-without-match')
    expect(listed(result.stdout)).toEqual(['./b.txt'])
  })

  it('lists every file for --files, without taking the pattern for a path', async () => {
    const result = await search('needle', '--files -g *.txt')
    expect(listed(result.stdout)).toEqual(['./a.txt', './b.txt', './sub/c.txt'])
    expect(result.stderr).toBeUndefined()
    expect(result.message).toBe('Exit code: 0')
  })

  it('still searches when a later mode undoes --files', async () => {
    const result = await search('needle', '--files -c')
    expect(listed(result.stdout)).toEqual(['./a.txt:2', './sub/c.txt:1'])
  })

  it('keeps -L as --follow: full match results, not a file list', async () => {
    const result = await search('hay', '-L')
    expect(result.stdout).toContain('Found 2 matches')
    expect(result.stdout).toContain('Line 3: hay')
  })

  it('follows the last mode when --json comes after -l', async () => {
    const result = await search('needle', '-l --json')
    expect(result.stdout).toContain('Line 1: needle')
  })

  it('keeps a file name in the record even where ripgrep would drop it', async () => {
    expect(listed((await search('needle', '-c -I')).stdout)).toEqual([
      './a.txt:2',
      './sub/c.txt:1',
    ])
    // A `cwd` naming one file: ripgrep alone prints a bare count here.
    expect(
      listed((await search('needle', '-c', { cwd: 'a.txt' })).stdout),
    ).toEqual(['a.txt:2'])
    expect(
      listed((await search('needle', '-l', { cwd: 'a.txt' })).stdout),
    ).toEqual(['a.txt'])
  })

  for (const flags of [
    '--crlf -c',
    '--stats -c',
    '-0 -c',
    '--color always -c',
    '-p -c',
  ]) {
    it(`reads the same counts under ${flags}`, async () => {
      const result = await search('needle', flags)
      expect(listed(result.stdout)).toEqual(['./a.txt:2', './sub/c.txt:1'])
    })
  }

  it('reads a count ended by NUL under --null-data, where a file is one line', async () => {
    const result = await search('needle', '--null-data -c')
    expect(listed(result.stdout)).toEqual(['./a.txt:1', './sub/c.txt:1'])
  })

  for (const flags of ['--stats -l', '-0 -l', '--color always -l']) {
    it(`reads the same filenames under ${flags}`, async () => {
      const result = await search('needle', flags)
      expect(listed(result.stdout)).toEqual(['./a.txt', './sub/c.txt'])
    })
  }

  it('shows a file only once when --hidden reaches it from two search paths', async () => {
    write('.github/ci.yml', 'needle\n')
    const result = await search('needle', '-c --hidden')
    // Whichever search path ripgrep reached it from first names it.
    expect(
      listed(result.stdout)
        .map((line) => line.replace(/^\.\//, ''))
        .sort(),
    ).toEqual(['.github/ci.yml:1', 'a.txt:2', 'sub/c.txt:1'])
    expect(result.stdout!.split('\n')[0]).toBe('Found 4 matches')
  })

  // A colon in a file name is not legal on Windows.
  if (process.platform !== 'win32') {
    it('keeps colons in a path, in both record shapes', async () => {
      write('c:1:d.txt', 'needle\n')
      write('e:2', 'needle\nneedle\n')
      expect(listed((await search('needle', '-l')).stdout)).toEqual([
        './a.txt',
        './c:1:d.txt',
        './e:2',
        './sub/c.txt',
      ])
      expect(listed((await search('needle', '-c')).stdout)).toEqual([
        './a.txt:2',
        './c:1:d.txt:1',
        './e:2:2',
        './sub/c.txt:1',
      ])
    })

    it('keeps a newline in a path, in both record shapes', async () => {
      write('line\nbreak.txt', 'needle\n')
      expect((await search('needle', '-l')).stdout).toContain(
        './line\nbreak.txt',
      )
      expect((await search('needle', '-c')).stdout).toContain(
        './line\nbreak.txt:1',
      )
    })
  }

  it('reports no matches as exit 1 with no error, in the normal empty shape', async () => {
    for (const flags of ['-l', '-c']) {
      const result = await search('absent', flags)
      expect(result.stdout).toBe('Found 0 matches')
      expect(result.message).toBe('Exit code: 1')
      expect(result.errorMessage).toBeUndefined()
      expect(result.stderr).toBeUndefined()
    }
  })

  it('keeps a real ripgrep error apart from no matches', async () => {
    const result = await search('(', '-l')
    expect(result.message).toBe('Exit code: 2')
    expect(result.stderr).toContain('regex parse error')
  })

  it('never reveals a sensitive env file through a filename or count', async () => {
    write('.env', 'API_KEY=sk-needle\n')
    write('.env.local', 'API_KEY=sk-needle\n')
    write('.env.example', 'API_KEY=needle\n')
    for (const flags of ['-uu -l', '-uu -c', '-uu --count-matches']) {
      const { stdout } = await search('sk-needle|needle', flags)
      expect(stdout).toContain('.env.example')
      expect(stdout).not.toMatch(/\.env(\.local)?(:\d+)?(\n|$)/)
    }
    const files = await search('x', '-uu --files')
    expect(files.stdout).toContain('.env.example')
    expect(files.stdout).not.toMatch(/\.env(\.local)?(\n|$)/)
    const withoutMatch = await search('absent', '-uu --files-without-match')
    expect(withoutMatch.stdout).not.toMatch(/\.env(\.local)?(\n|$)/)
  })

  it('caps results at the global limit with the normal notice', async () => {
    for (let index = 0; index < 300; index++) {
      write(`many/${index}.txt`, 'pin\npin\n')
    }
    for (const flags of ['-l', '-c']) {
      const result = await search('pin', flags)
      expect(listed(result.stdout).filter(Boolean)).toHaveLength(251)
      expect(result.stdout).toContain(
        '[Global limit of 250 results reached.]',
      )
      expect(result.message).toBe(
        `Stopped early after ${flags === '-l' ? 250 : 500} match(es).`,
      )
    }
  })

  it('honours a lower global limit and the output size limit', async () => {
    const capped = await search('needle', '-l', { globalMaxResults: 1 })
    expect(capped.stdout).toContain('Found 1 matches')
    expect(capped.stdout).toContain('[Global limit of 1 results reached.]')
    const sized = await search('needle', '-l', { maxOutputStringLength: 4 })
    expect(sized.stdout).toContain('[Output size limit reached.]')
  })

  it('refuses flags that leave nothing to read, rather than report no matches', async () => {
    for (const flags of ['-q', '--type-list', '--version', '--help', '--no-json']) {
      const result = await search('needle', flags)
      expect(result.errorMessage).toContain('no search results to read')
      expect(result.stdout).toBeUndefined()
    }
  })
})

describe('codeSearch: plain records as they arrive', () => {
  const brokered = () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let finish!: (code: number | null) => void
    const processBroker: TerminalCommandBroker = {
      start: () => ({
        stdout,
        stderr,
        completion: new Promise((resolve) => {
          finish = resolve
        }),
        kill: () => {},
        isAlive: () => true,
      }),
    }
    return { stdout, processBroker, finish: (code: number) => finish(code) }
  }

  const value = (result: Awaited<ReturnType<typeof codeSearch>>) =>
    (result[0] as { value: Record<string, string> }).value

  it('keeps Windows separators and a record split across chunks', async () => {
    const { stdout, processBroker, finish } = brokered()
    const search = codeSearch({
      projectPath: '/test/project',
      pattern: 'needle',
      flags: '-c',
      processBroker,
    })
    for (const chunk of ['.\\src\\a.ts\x0012', '\r\n.\\b', '.ts\x00', '3\n']) {
      stdout.write(chunk)
      await new Promise((resolve) => setImmediate(resolve))
    }
    finish(0)
    expect(value(await search).stdout).toBe(
      'Found 15 matches\n.\\src\\a.ts:12\n.\\b.ts:3',
    )
  })

  it('refuses a Windows env path too', async () => {
    const { stdout, processBroker, finish } = brokered()
    const search = codeSearch({
      projectPath: '/test/project',
      pattern: 'needle',
      flags: '-l',
      processBroker,
    })
    stdout.write('.\\config\\.env\x00.\\a.ts\x00')
    await new Promise((resolve) => setImmediate(resolve))
    finish(0)
    expect(value(await search).stdout).toBe('Found 1 matches\n.\\a.ts')
  })

  it('returns what it has when the run is aborted', async () => {
    const { stdout, processBroker } = brokered()
    const controller = new AbortController()
    const search = codeSearch({
      projectPath: '/test/project',
      pattern: 'needle',
      flags: '-l',
      processBroker,
      signal: controller.signal,
    })
    stdout.write('./a.ts\x00')
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()
    expect(value(await search).stdout).toBe('Found 1 matches\n./a.ts')
  })
})
