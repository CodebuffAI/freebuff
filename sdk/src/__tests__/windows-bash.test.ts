// The finder runs on every Windows shell command, and the layouts below are all real installs we
// have to recognize. A layout missing from here is a Windows user for whom the app reports no bash
// while bash sits on their disk — which is indistinguishable, from their side, from a broken app.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  findWindowsBash,
  isGitBashAbsolutePath,
  parseRegistryPath,
  resetTranslationCache,
  translateGitBashPath,
  windowsBashCandidates,
} from '../tools/windows-bash'

let root: string

/** lays down a `<root>/<rel>/bin/bash.exe` and answers with the directory `rel` names */
function installGitAt(rel: string): string {
  const gitRoot = path.join(root, rel)
  fs.mkdirSync(path.join(gitRoot, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(gitRoot, 'bin', 'bash.exe'), '')
  return gitRoot
}

function touch(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), '')
  return path.join(dir, name)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'winbash-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('findWindowsBash', () => {
  it('uses the app bundle on a clean machine, including paths with spaces', () => {
    const bundled = installGitAt('Freebuff App/resources/git')
    expect(findWindowsBash({ PATH: '', FREEBUFF_GIT_DIR: bundled })).toBe(path.join(bundled, 'bin', 'bash.exe'))
    const override = touch(path.join(root, 'custom'), 'bash.exe')
    expect(findWindowsBash({ FREEBUFF_GIT_DIR: bundled, CODEBUFF_GIT_BASH_PATH: override })).toBe(override)
  })

  it('falls back to installed Git when the app bundle is missing', () => {
    const installed = installGitAt('Git')
    expect(findWindowsBash({ FREEBUFF_GIT_DIR: path.join(root, 'missing'), ProgramFiles: root })).toBe(path.join(installed, 'bin', 'bash.exe'))
  })

  it('prefers an explicit CODEBUFF_GIT_BASH_PATH over everything else', () => {
    const override = touch(path.join(root, 'custom'), 'bash.exe')
    const programFiles = installGitAt('ProgramFiles')
    expect(
      findWindowsBash({ CODEBUFF_GIT_BASH_PATH: override, ProgramFiles: programFiles }),
    ).toBe(override)
  })

  it('ignores a CODEBUFF_GIT_BASH_PATH left pointing at a bash that is gone', () => {
    const gitRoot = installGitAt('Git')
    expect(
      findWindowsBash({
        CODEBUFF_GIT_BASH_PATH: path.join(root, 'deleted', 'bash.exe'),
        ProgramFiles: root,
      }),
    ).toBe(path.join(gitRoot, 'bin', 'bash.exe'))
  })

  // the regression that made "it installed Git and still says bash is missing" reachable: the
  // installer's no-admin mode, and what an unelevated agent installing Git on the user's behalf gets
  it('finds a per-user install under %LOCALAPPDATA%\\Programs\\Git', () => {
    const gitRoot = installGitAt(path.join('AppData', 'Local', 'Programs', 'Git'))
    const found = findWindowsBash({ LOCALAPPDATA: path.join(root, 'AppData', 'Local') })
    expect(found).toBe(path.join(gitRoot, 'bin', 'bash.exe'))
  })

  it('finds a scoop install', () => {
    const gitRoot = installGitAt(path.join('scoop', 'apps', 'git', 'current'))
    expect(findWindowsBash({ USERPROFILE: root })).toBe(path.join(gitRoot, 'bin', 'bash.exe'))
  })

  // Windows does not have to live on C:, and the installer writes the real root into these vars
  it('honors a ProgramFiles that is not on C:', () => {
    const gitRoot = installGitAt('Git')
    expect(findWindowsBash({ ProgramFiles: root })).toBe(path.join(gitRoot, 'bin', 'bash.exe'))
  })

  // the installer's default option adds only `…\Git\cmd`, which holds git.exe and no bash.exe
  it('finds bash beside a git.exe that is on PATH', () => {
    const gitRoot = installGitAt(path.join('elsewhere', 'Git'))
    const cmdDir = path.join(gitRoot, 'cmd')
    touch(cmdDir, 'git.exe')
    expect(findWindowsBash({ PATH: cmdDir })).toBe(path.join(gitRoot, 'bin', 'bash.exe'))
  })

  // `…\Git\mingw64\bin\git.exe` is the other layout the installer can put on PATH
  it('walks two levels up from a mingw64 git.exe', () => {
    const gitRoot = installGitAt(path.join('elsewhere', 'Git'))
    const mingw = path.join(gitRoot, 'mingw64', 'bin')
    touch(mingw, 'git.exe')
    expect(findWindowsBash({ PATH: mingw })).toBe(path.join(gitRoot, 'bin', 'bash.exe'))
  })

  it('finds bash directly on PATH', () => {
    const dir = path.join(root, 'tools')
    const bash = touch(dir, 'bash.exe')
    expect(findWindowsBash({ PATH: dir })).toBe(bash)
  })

  // WSL's launcher exists whether or not a distro does, so it is never the bash we run
  it('never accepts the WSL or Store stubs', () => {
    const system32 = path.join(root, 'Windows', 'System32')
    const store = path.join(root, 'AppData', 'Local', 'Microsoft', 'WindowsApps')
    touch(system32, 'bash.exe')
    touch(store, 'bash.exe')
    // `() => null` throughout this file: without it the DEFAULT reader queries the real registry,
    // so on a Windows machine that has Git these assertions describe the host rather than the
    // fixture — the same non-hermeticity the hardcoded C: roots used to cause, by another route
    expect(
      findWindowsBash({ PATH: [system32, store].join(path.delimiter) }, () => null),
    ).toBeNull()
  })

  // The finder must be a function of the env it is given and nothing else. It was not: hardcoded
  // C:\Program Files roots meant that on a Windows machine WITH Git it answered that machine's own
  // install whatever env you handed it — which no caller can reason about, and which quietly turned
  // every fixture-based test here into a no-op on Windows. Caught by running these on a real runner.
  it('answers only from the environment it is given', () => {
    const real = installGitAt('Git')
    // an env naming a DIFFERENT root must not fall through to the host's own install
    expect(findWindowsBash({ ProgramFiles: path.join(root, 'empty') }, () => null)).toBeNull()
    // and the same env pointed at the fixture finds it
    expect(findWindowsBash({ ProgramFiles: root }, () => null)).toBe(
      path.join(real, 'bin', 'bash.exe'),
    )
  })

  // the drive-root layouts follow SystemDrive rather than assuming C:
  it('looks for drive-root installs on the drive Windows actually lives on', () => {
    const candidates = windowsBashCandidates({ SystemDrive: 'D:' })
    expect(candidates).toContain(path.join('D:', '\\', 'Git', 'bin', 'bash.exe'))
    expect(candidates.some((c) => c.startsWith('C:'))).toBe(false)
  })

  it('answers null when the machine genuinely has no bash', () => {
    expect(findWindowsBash({ PATH: path.join(root, 'empty') }, () => null)).toBeNull()
  })

  it('never returns a candidate twice', () => {
    const dir = path.join(root, 'tools')
    const candidates = windowsBashCandidates({
      PATH: [dir, dir].join(path.delimiter),
      ProgramFiles: 'C:\\Program Files',
    })
    expect(new Set(candidates).size).toBe(candidates.length)
  })

  // The registry is what finds an install in a directory nobody would guess — the case the
  // CODEBUFF_GIT_BASH_PATH escape hatch used to be the only answer for. Almost nobody sets that
  // variable, and almost everybody has Git somewhere; this closes the gap between those two facts.
  it('falls back to the install directory the registry records', () => {
    const gitRoot = installGitAt(path.join('Dev Tools', 'Git'))
    expect(findWindowsBash({ PATH: '' }, () => gitRoot)).toBe(
      path.join(gitRoot, 'bin', 'bash.exe'),
    )
  })

  // it costs a process spawn, so a machine that has Git anywhere normal must never pay for it
  it('never consults the registry when the filesystem already answered', () => {
    const gitRoot = installGitAt('Git')
    let asked = 0
    const found = findWindowsBash({ ProgramFiles: root }, () => (asked++, null))
    expect(found).toBe(path.join(gitRoot, 'bin', 'bash.exe'))
    expect(asked).toBe(0)
  })

  // an uninstall leaves the key behind; trusting it would claim a bash that is not on disk
  it('verifies the registry path rather than trusting it', () => {
    expect(findWindowsBash({ PATH: '' }, () => path.join(root, 'uninstalled'))).toBeNull()
  })

  // The guard that keeps every caller testable. The registry describes THIS machine, so the default
  // reader only fires for this machine's own env — otherwise the setup probe, the terminal panel
  // and the startup script would each need a seam of their own, and on a Windows host with Git
  // their tests would quietly describe the runner instead of their fixture. Found by running them
  // on one.
  it('consults the registry only alongside the environment it describes', () => {
    let asked = 0
    const reader = () => (asked++, null)
    // an explicit reader is always honoured — that is how the case above is testable at all
    findWindowsBash({ PATH: '' }, reader)
    expect(asked).toBe(1)
    // but the DEFAULT reader must not answer a question about some other, synthetic machine
    expect(findWindowsBash({ PATH: path.join(root, 'nowhere') })).toBeNull()
  })

  it('answers null when the registry knows nothing either', () => {
    expect(findWindowsBash({ PATH: '' }, () => null)).toBeNull()
  })

  // an offline network drive on PATH makes existsSync throw rather than answer false; one of those
  // must not take down every command on the machine
  it('survives an unreadable candidate path', () => {
    const dir = path.join(root, 'tools')
    const bash = touch(dir, 'bash.exe')
    expect(findWindowsBash({ PATH: ['\0bogus', dir].join(path.delimiter) })).toBe(bash)
  })
})

// `reg query` output is column-aligned with tabs or runs of spaces, and an install directory may
// itself contain spaces — so the value is the rest of the line, not the next whitespace-delimited
// token.
describe('parseRegistryPath', () => {
  it('reads a path containing spaces', () => {
    const out =
      '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows\r\n    InstallPath    REG_SZ    C:\\Dev Tools\\Git\r\n\r\n'
    expect(parseRegistryPath(out, 'InstallPath')).toBe('C:\\Dev Tools\\Git')
  })

  it('tolerates tab separators and strips a trailing slash', () => {
    expect(parseRegistryPath('\tInstallPath\tREG_SZ\tC:\\Git\\', 'InstallPath')).toBe('C:\\Git')
  })

  it('reads the uninstall entry’s differently named value', () => {
    expect(parseRegistryPath('  InstallLocation  REG_SZ  C:\\Git', 'InstallLocation')).toBe('C:\\Git')
  })

  it('answers null for a missing key, an error, or an empty value', () => {
    expect(
      parseRegistryPath('ERROR: The system was unable to find the specified registry key', 'InstallPath'),
    ).toBeNull()
    expect(parseRegistryPath('', 'InstallPath')).toBeNull()
    expect(parseRegistryPath('    InstallPath    REG_SZ    ', 'InstallPath')).toBeNull()
  })
})

describe('Git Bash path translation', () => {
  beforeEach(() => {
    resetTranslationCache()
  })

  it('recognizes MSYS absolute paths without claiming native UNC paths', () => {
    expect(isGitBashAbsolutePath('/tmp/file.txt')).toBe(true)
    expect(isGitBashAbsolutePath('/c/Users/Alice/file.txt')).toBe(true)
    expect(isGitBashAbsolutePath('//server/share/file.txt')).toBe(false)
    expect(isGitBashAbsolutePath('C:\\tmp\\file.txt')).toBe(false)
    expect(isGitBashAbsolutePath('src/file.txt')).toBe(false)
  })

  it('translates a drive-letter MSYS path without any lookup or spawn', () => {
    const neverFindBash = () => {
      throw new Error('must not look for bash')
    }
    expect(
      translateGitBashPath('/c/Users/me/repo/src/a.ts', {
        platform: 'win32',
        env: {},
        findBash: neverFindBash,
      }),
    ).toBe('C:\\Users\\me\\repo\\src\\a.ts')
    expect(
      translateGitBashPath('/D/work/file.txt', {
        platform: 'win32',
        env: {},
        findBash: neverFindBash,
      }),
    ).toBe('D:\\work\\file.txt')
  })

  it('spawns the cygpath.exe derived from the found bash, directly', () => {
    const bash = path.join(installGitAt('Git'), 'bin', 'bash.exe')
    const cygpath = touch(path.join(root, 'Git', 'usr', 'bin'), 'cygpath.exe')
    const calls: [string, string][] = []

    expect(
      translateGitBashPath('/tmp/file.txt', {
        platform: 'win32',
        env: {},
        findBash: () => bash,
        spawnCygpath: (cygpath, filePath) => {
          calls.push([cygpath, filePath])
          return {
            status: 0,
            stdout: 'C:\\Users\\Alice\\AppData\\Local\\Temp\\file.txt\n',
          }
        },
      }),
    ).toBe('C:\\Users\\Alice\\AppData\\Local\\Temp\\file.txt')
    expect(calls).toEqual([[cygpath, '/tmp/file.txt']])
  })

  it('spawns the cygpath.exe sitting beside a usr\\bin bash', () => {
    const bash = touch(path.join(root, 'Git', 'usr', 'bin'), 'bash.exe')
    const cygpath = touch(path.join(root, 'Git', 'usr', 'bin'), 'cygpath.exe')
    const calls: [string, string][] = []

    expect(
      translateGitBashPath('/tmp/sibling.txt', {
        platform: 'win32',
        env: {},
        findBash: () => bash,
        spawnCygpath: (cygpath, filePath) => {
          calls.push([cygpath, filePath])
          return { status: 0, stdout: 'C:\\Temp\\sibling.txt\n' }
        },
      }),
    ).toBe('C:\\Temp\\sibling.txt')
    expect(calls).toEqual([[cygpath, '/tmp/sibling.txt']])
  })

  it('skips the spawn and keeps the original path when no cygpath.exe exists', () => {
    const bash = touch(path.join(root, 'Git', 'bin'), 'bash.exe')
    let spawns = 0

    expect(
      translateGitBashPath('/tmp/no-cygpath.txt', {
        platform: 'win32',
        env: {},
        findBash: () => bash,
        spawnCygpath: () => {
          spawns++
          return { status: 0, stdout: 'C:\\Temp\\no-cygpath.txt\n' }
        },
      }),
    ).toBe('/tmp/no-cygpath.txt')
    expect(spawns).toBe(0)
  })

  it('reads only the last stdout line, so leading banner output is ignored', () => {
    expect(
      translateGitBashPath('/tmp/banner.txt', {
        platform: 'win32',
        env: {},
        findBash: () => path.join(root, 'Git', 'bin', 'bash.exe'),
        pathExists: () => true,
        spawnCygpath: () => ({
          status: 0,
          stdout:
            'conda environment activated\nNow using node v22.1.0\nC:\\Temp\\banner.txt\r\n',
        }),
      }),
    ).toBe('C:\\Temp\\banner.txt')
  })

  it('falls back to the original path on a non-zero exit even when stdout is non-empty', () => {
    expect(
      translateGitBashPath('/tmp/exit-code.txt', {
        platform: 'win32',
        env: {},
        findBash: () => path.join(root, 'Git', 'bin', 'bash.exe'),
        pathExists: () => true,
        spawnCygpath: () => ({
          status: 1,
          stdout: 'C:\\Temp\\exit-code.txt\n',
        }),
      }),
    ).toBe('/tmp/exit-code.txt')
  })

  it('spawns once per path and answers repeats from the cache', () => {
    let spawns = 0
    const dependencies = {
      platform: 'win32' as NodeJS.Platform,
      env: {},
      findBash: () => path.join(root, 'Git', 'bin', 'bash.exe'),
      pathExists: () => true,
      spawnCygpath: () => {
        spawns++
        return { status: 0, stdout: 'C:\\Temp\\repeat.txt\n' }
      },
    }
    expect(translateGitBashPath('/tmp/repeat.txt', dependencies)).toBe(
      'C:\\Temp\\repeat.txt',
    )
    expect(translateGitBashPath('/tmp/repeat.txt', dependencies)).toBe(
      'C:\\Temp\\repeat.txt',
    )
    expect(spawns).toBe(1)
  })

  it('leaves paths unchanged when translation does not apply or is unavailable', () => {
    const neverFindBash = () => {
      throw new Error('must not look for bash')
    }
    expect(
      translateGitBashPath('/tmp/file.txt', {
        platform: 'darwin',
        findBash: neverFindBash,
      }),
    ).toBe('/tmp/file.txt')
    expect(
      translateGitBashPath('C:\\tmp\\file.txt', {
        platform: 'win32',
        findBash: neverFindBash,
      }),
    ).toBe('C:\\tmp\\file.txt')
    expect(
      translateGitBashPath('/tmp/file.txt', {
        platform: 'win32',
        env: {},
        findBash: () => path.join(root, 'Git', 'bin', 'bash.exe'),
        pathExists: () => true,
        spawnCygpath: () => ({ status: 0, stdout: '' }),
      }),
    ).toBe('/tmp/file.txt')
  })
})
