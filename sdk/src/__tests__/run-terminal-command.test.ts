import { describe, expect, test } from 'bun:test'

import { findWindowsBash } from '../tools/run-terminal-command'

function existsOnly(paths: string[]) {
  const existingPaths = new Set(paths.map((path) => path.toLowerCase()))
  return (path: string) => existingPaths.has(path.toLowerCase())
}

describe('findWindowsBash', () => {
  test('finds Git Bash installed by Scoop under USERPROFILE', () => {
    const scoopBash = String.raw`C:\Users\dev\scoop\apps\git\current\bin\bash.exe`

    expect(
      findWindowsBash(
        { USERPROFILE: String.raw`C:\Users\dev`, PATH: '' },
        existsOnly([scoopBash]),
      ),
    ).toBe(scoopBash)
  })

  test('finds Git Bash installed by Scoop under SCOOP_GLOBAL', () => {
    const scoopBash = String.raw`C:\ProgramData\scoop\apps\git\current\usr\bin\bash.exe`

    expect(
      findWindowsBash(
        {
          SCOOP_GLOBAL: String.raw`C:\ProgramData\scoop`,
          USERPROFILE: String.raw`C:\Users\dev`,
          PATH: '',
        },
        existsOnly([scoopBash]),
      ),
    ).toBe(scoopBash)
  })

  test('prefers non-WSL bash in PATH over WSL bash', () => {
    const gitBash = String.raw`C:\Tools\Git\bin\bash.exe`
    const wslBash = String.raw`C:\Windows\System32\bash.exe`

    expect(
      findWindowsBash(
        {
          PATH: String.raw`C:\Windows\System32;C:\Tools\Git\bin`,
        },
        existsOnly([gitBash, wslBash]),
      ),
    ).toBe(gitBash)
  })
})
