import { describe, expect, test } from 'bun:test'

import { shellMismatchHint } from '../shell-mismatch-hint'

const run = (
  platform: string,
  shell: 'bash' | 'powershell',
  command: string,
  stderr: string,
  exitCode: number | null = 1,
) => shellMismatchHint({ platform, shell, command, stderr, exitCode })
const bashWin = (command: string, stderr: string, exitCode?: number | null) =>
  run('win32', 'bash', command, stderr, exitCode)
const ps = (command: string, stderr: string, exitCode?: number | null) =>
  run('win32', 'powershell', command, stderr, exitCode)

describe('bash on Windows', () => {
  test('cmd.exe commands name the POSIX replacement', () => {
    expect(bashWin('dir', 'bash: dir: command not found')).toBe(
      'Hint: this terminal is bash on Windows, not cmd.exe; use ls instead of dir, and forward slashes in paths.',
    )
    expect(
      bashWin('findstr x', '/usr/bin/bash: line 1: findstr: command not found'),
    ).toContain('use grep instead of findstr')
  })

  test('cmdlets', () => {
    expect(
      bashWin('Get-ChildItem', 'bash: Get-ChildItem: command not found'),
    ).toContain('not PowerShell')
  })

  test('a backslash path bash ate, but not one it kept', () => {
    expect(
      bashWin(
        'cd C:\\Users\\me\\project && ls',
        'bash: cd: C:Usersmeproject: No such file or directory',
      ),
    ).toContain('forward slashes')
    expect(
      bashWin(
        "cat 'C:\\Users\\me\\missing.txt'",
        "cat: 'C:\\Users\\me\\missing.txt': No such file or directory",
      ),
    ).toBeUndefined()
  })

  test('a genuinely missing program gets no hint', () => {
    expect(bashWin('pnpm i', 'bash: pnpm: command not found')).toBeUndefined()
  })
})

describe('PowerShell host', () => {
  test.each([
    ['npm i && npm test', "The token '&&' is not a valid statement separator in this version.", 'it has no &&'],
    ['git status 2>/dev/null', "out-file : Could not find a part of the path 'C:\\dev\\null'.", '> $null'],
    ['rm -rf node_modules', "Remove-Item : A parameter cannot be found that matches parameter name 'rf'.", 'Remove-Item -Recurse -Force'],
    ['ls -la', "Get-ChildItem : A parameter cannot be found that matches parameter name 'la'.", 'take no POSIX flags'],
    ['npm test | tail -5', "tail : The term 'tail' is not recognized as the name of a cmdlet, function, script file, or operable program.", 'use Get-Content -Tail N instead of tail'],
    ['export A=1', "The term 'export' is not recognized as the name of a cmdlet", "$env:NAME = 'value'"],
    ['NODE_ENV=test npm test', "The term 'NODE_ENV=test' is not recognized as the name of a cmdlet", 'set variables with $env:NAME'],
  ])('%s', (command, stderr, expected) => {
    const hint = ps(command, stderr)
    expect(hint).toContain(expected)
    expect(hint).not.toMatch(/\bbash\b/)
    expect(hint!.length).toBeLessThan(160)
  })

  test('a missing program gets no hint', () => {
    expect(
      ps('pnpm i', "The term 'pnpm' is not recognized as the name of a cmdlet"),
    ).toBeUndefined()
  })
})

describe('never', () => {
  test('on a zero or missing exit code', () => {
    expect(bashWin('dir', 'bash: dir: command not found', 0)).toBeUndefined()
    expect(bashWin('dir', 'bash: dir: command not found', null)).toBeUndefined()
  })

  test('for bash on Linux or macOS', () => {
    for (const platform of ['linux', 'darwin'])
      expect(
        run(platform, 'bash', 'dir', 'bash: dir: command not found', 127),
      ).toBeUndefined()
  })
})
