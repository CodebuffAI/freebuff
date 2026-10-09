// Where bash lives on a Windows machine. Every surface that needs a shell — the SDK's
// run_terminal_command, the Desktop terminal panel, the Desktop's per-workspace startup script —
// asks this module, so they can never disagree about whether this machine has bash.
//
// Agents are overwhelmingly trained on bash, so bash is what we run: PowerShell is a different
// language the model does not write well, and a POSIX command translated on the fly is a command
// that fails in a new way. Git for Windows ships a real bash, so "does this machine have bash" is
// in practice "did Git for Windows land anywhere we know to look".
//
// Looking in enough places is the whole job. An install that we fail to find is indistinguishable
// to the user from no install at all: they run the installer, we keep saying bash is missing, and
// the only conclusion available to them is that the app is broken.

import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import { getSystemProcessEnv } from '../env'

/**
 * The WSL launcher ships at C:\Windows\System32\bash.exe whether or not a distro is installed, and
 * the Microsoft Store stub does the same under WindowsApps, so neither directory can ever supply
 * our bash. WSL bash fails with cryptic errors when the VM is not running, on argument quoting and
 * on UTF-16 mismatches, and with no distro installed every single command comes back "Windows
 * Subsystem for Linux has no installed distributions."
 */
const EXCLUDED_PATH_PATTERNS = ['system32', 'windowsapps']

/**
 * `…\Git` roots we check directly, so a found install never depends on PATH being current.
 *
 * Every one is derived from the environment, with no hardcoded `C:\…` anywhere: Windows sets
 * ProgramFiles, SystemDrive and the rest on every machine, and the installer writes into those same
 * variables, so the literals bought nothing real. What they cost was determinism — they made this a
 * function of the host as well as its argument, so on a Windows machine that has Git it answered
 * `C:\Program Files\Git` no matter what env it was handed. That is unusable for a caller reasoning
 * about a specific environment, and it silently defeated every test that passed a fixture env.
 */
function gitRoots(env: NodeJS.ProcessEnv): string[] {
  const localAppData = env.LOCALAPPDATA
  const userProfile = env.USERPROFILE
  const programData = env.ProgramData ?? env.PROGRAMDATA
  // "C:" on almost every machine, but Windows genuinely does live on other volumes
  const systemDrive = env.SystemDrive ?? env.SYSTEMDRIVE
  return [
    env.ProgramFiles,
    env.ProgramW6432,
    env['ProgramFiles(x86)'],
  ]
    .filter((root): root is string => !!root)
    .map((root) => path.join(root, 'Git'))
    .concat(
      [
        // The installer's per-user mode, which is what a user without admin rights gets — and what
        // an agent installing Git on the user's behalf gets, since it is not elevated either. This
        // one is why "it installed Git and still says bash is missing" was reachable at all.
        localAppData && path.join(localAppData, 'Programs', 'Git'),
        // Scoop, per-user and global.
        env.SCOOP && path.join(env.SCOOP, 'apps', 'git', 'current'),
        userProfile && path.join(userProfile, 'scoop', 'apps', 'git', 'current'),
        env.SCOOP_GLOBAL && path.join(env.SCOOP_GLOBAL, 'apps', 'git', 'current'),
        programData && path.join(programData, 'scoop', 'apps', 'git', 'current'),
        // Chocolatey's git package installs Git for Windows proper (covered above), but its older
        // portable layouts land at the drive root.
        systemDrive && path.join(systemDrive, '\\', 'tools', 'git'),
        systemDrive && path.join(systemDrive, '\\', 'Git'),
      ].filter((root): root is string => !!root),
    )
}

function usablePathDirs(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH || env.Path || '')
    .split(path.delimiter)
    .filter(
      (dir) =>
        dir &&
        !EXCLUDED_PATH_PATTERNS.some((pattern) => dir.toLowerCase().includes(pattern)),
    )
}

/**
 * Every place a Git for Windows bash could be, in the order we would rather find it, deduped.
 *
 * The explicit roots come before PATH because they are the ones that stay correct: a GUI app
 * inherits the PATH that existed when it launched, so an install performed while the app is open is
 * invisible to PATH until a restart — and a user who just installed Git because we asked them to is
 * exactly who must not then be told to restart us.
 */
export function windowsBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const pathDirs = usablePathDirs(env)
  const candidates = [
    env.CODEBUFF_GIT_BASH_PATH,
    ...gitRoots(env).map((root) => path.join(root, 'bin', 'bash.exe')),
    ...pathDirs.flatMap((dir) => ['bash.exe', 'bash'].map((name) => path.join(dir, name))),
    // A git.exe on PATH with no bash beside it: the installer's default option adds only `…\Git\cmd`,
    // and `…\Git\mingw64\bin` is what the "use Git from the command prompt" option can add. Walking
    // up to the sibling `bin` is what finds bash for a relocated or per-user install whose own
    // directory we did not guess.
    ...pathDirs
      .filter((dir) => pathExists(path.join(dir, 'git.exe')))
      .flatMap((dir) => [
        path.join(path.dirname(dir), 'bin', 'bash.exe'),
        path.join(path.dirname(path.dirname(dir)), 'bin', 'bash.exe'),
      ]),
  ].filter((candidate): candidate is string => !!candidate)
  return [...new Set(candidates)]
}

/**
 * A path can be unreadable rather than absent — a network drive that is offline, a directory whose
 * ACL denies us — and on those `fs.existsSync` throws rather than answering false. Shared with the
 * Desktop, which asks the same question about the same installs.
 */
export function pathExists(candidate: string): boolean {
  try {
    return fs.existsSync(candidate)
  } catch {
    return false
  }
}

/**
 * Where the Git for Windows installer records the directory it actually used — the only source
 * that stays correct when the user picks a directory nobody would guess. `GitForWindows` is the
 * key Git writes for itself; the `Git_is1` uninstall entries are the Inno Setup ones, which survive
 * some installs that skip the former. HKCU covers the no-admin per-user install, and WOW6432Node
 * covers a 32-bit Git on 64-bit Windows.
 */
const GIT_REGISTRY_VALUES: readonly (readonly [key: string, value: string])[] = [
  ['HKLM\\SOFTWARE\\GitForWindows', 'InstallPath'],
  ['HKCU\\SOFTWARE\\GitForWindows', 'InstallPath'],
  ['HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows', 'InstallPath'],
  ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1', 'InstallLocation'],
  ['HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Git_is1', 'InstallLocation'],
]

/** `    InstallPath    REG_SZ    C:\Dev Tools\Git` — the value is the rest of the line, spaces and all. */
export function parseRegistryPath(stdout: string, value: string): string | null {
  const match = new RegExp(`^\\s*${value}\\s+REG_[A-Z_]+\\s+(.+)$`, 'im').exec(stdout)
  return match?.[1]?.trim().replace(/[\\/]+$/, '') || null
}

// `undefined` = not asked yet. Memoized because it costs a process spawn, and because the answer
// only changes when Git is installed or removed — an install performed while we are running lands
// in a directory the filesystem search above already covers, so it is found without this.
let cachedGitRegistryRoot: string | null | undefined

/**
 * Ask the registry where Git is. Only ever reached when every filesystem candidate missed, so on
 * the overwhelming majority of machines — including every one that has Git anywhere normal — this
 * never runs at all.
 */
function gitRootFromRegistry(): string | null {
  if (cachedGitRegistryRoot !== undefined) return cachedGitRegistryRoot
  cachedGitRegistryRoot = null
  if (process.platform !== 'win32') return null
  for (const [key, value] of GIT_REGISTRY_VALUES) {
    try {
      const probe = spawnSync('reg', ['query', key, '/v', value], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5_000,
      })
      const root = probe.stdout ? parseRegistryPath(probe.stdout, value) : null
      if (root) {
        cachedGitRegistryRoot = root
        return root
      }
    } catch {
      // no reg.exe, or a hive we may not read: simply not where this machine's Git is recorded
    }
  }
  return null
}

/**
 * The bash this machine will run, or null if it has none.
 *
 * The filesystem search is synchronous and unmemoized: it is a handful of `existsSync` probes, and
 * caching it is how an app comes to insist bash is missing minutes after the user installed it. The
 * registry is the last resort, consulted only when nothing on disk matched — it costs a spawn, and
 * it is the one thing that finds an install in a directory we would never guess. A registry entry
 * left behind by an uninstall cannot resurrect a bash: the path it names is verified like any other.
 */
export function findWindowsBash(
  env: NodeJS.ProcessEnv,
  registryRoot?: () => string | null,
): string | null {
  const found = windowsBashCandidates(env).find(pathExists)
  if (found) return found
  // The registry describes THIS machine, so by default it only answers alongside this machine's own
  // environment. A caller handing us a synthetic env is asking a hypothetical — "what would we find
  // for a machine that looks like this?" — and the host's Git is not part of that hypothetical. It
  // is also what keeps every caller testable: the setup probe, the terminal panel and the startup
  // script all pass an env straight through, so without this each would need a seam of its own, and
  // on a Windows machine with Git their tests would describe the runner rather than their fixture.
  const read =
    registryRoot ?? (env === getSystemProcessEnv() ? gitRootFromRegistry : () => null)
  const root = read()
  const candidate = root ? path.join(root, 'bin', 'bash.exe') : null
  return candidate && pathExists(candidate) ? candidate : null
}

function listDirectory(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** `app-3.4.10` before `app-3.4.9`: numeric per segment, newest first. */
function compareAppVersionsDescending(a: string, b: string): number {
  const parts = (name: string) => name.slice('app-'.length).split('.').map((n) => Number(n) || 0)
  const [left, right] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Every place a Git for Windows `git.exe` could be when PATH has none, in the order we would rather
 * find it. Same roots as bash, for the same reason: a GUI app launched from the Start menu carries
 * the PATH from when Explorer started, so a Git installed since is on disk but not on our PATH.
 *
 * GitHub Desktop is last. It bundles a complete Git it never puts on PATH, and it is how plenty of
 * people who have never typed `git` came to have a cloned folder at all — the exact user who opens
 * that folder in Freebuff and is told git is missing. Newest bundled version first.
 */
export function windowsGitCandidates(
  env: NodeJS.ProcessEnv,
  readDir: (dir: string) => string[] = listDirectory,
): string[] {
  const githubDesktop = env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, 'GitHubDesktop')
    : null
  const bundled = githubDesktop
    ? readDir(githubDesktop)
        .filter((name) => /^app-\d/.test(name))
        .sort(compareAppVersionsDescending)
        .map((name) =>
          path.join(githubDesktop, name, 'resources', 'app', 'git', 'cmd', 'git.exe'),
        )
    : []
  return [
    ...new Set([
      ...gitRoots(env).map((root) => path.join(root, 'cmd', 'git.exe')),
      ...bundled,
    ]),
  ]
}

/**
 * The git.exe a Windows machine has outside PATH, or null. Like `findWindowsBash`, the filesystem
 * is searched first and the registry only when it missed, and only for this machine's own env.
 */
export function findWindowsGit(
  env: NodeJS.ProcessEnv,
  registryRoot?: () => string | null,
): string | null {
  const found = windowsGitCandidates(env).find(pathExists)
  if (found) return found
  const read =
    registryRoot ?? (env === getSystemProcessEnv() ? gitRootFromRegistry : () => null)
  const root = read()
  const candidate = root ? path.join(root, 'cmd', 'git.exe') : null
  return candidate && pathExists(candidate) ? candidate : null
}

type CygpathSpawnResult = {
  status: number | null
  stdout: string
}

export type WindowsShellPathDependencies = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  findBash?: (env: NodeJS.ProcessEnv) => string | null
  spawnCygpath?: (cygpath: string, filePath: string) => CygpathSpawnResult
  pathExists?: (candidate: string) => boolean
}

/** Git Bash paths start with one slash; two slashes already name a native Windows UNC path. */
export function isGitBashAbsolutePath(filePath: string): boolean {
  return /^\/(?!\/)/.test(filePath)
}

function spawnCygpath(cygpath: string, filePath: string): CygpathSpawnResult {
  return spawnSync(cygpath, ['-w', '--', filePath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
  })
}

function findCygpath(
  bash: string,
  exists: (candidate: string) => boolean,
): string | null {
  const candidates = [
    path.join(path.dirname(path.dirname(bash)), 'usr', 'bin', 'cygpath.exe'),
    path.join(path.dirname(bash), 'cygpath.exe'),
  ]
  return candidates.find(exists) ?? null
}

function runCygpath(
  spawn: (cygpath: string, filePath: string) => CygpathSpawnResult,
  cygpath: string,
  filePath: string,
): string | null {
  try {
    const result = spawn(cygpath, filePath)
    if (result.status !== 0) return null
    return result.stdout.trim().split(/\r?\n/).pop()?.trim() || null
  } catch {
    return null
  }
}

const MSYS_DRIVE_PATTERN = /^\/([a-z])\//i

const translatedPathCache = new Map<string, string>()

export function resetTranslationCache(): void {
  translatedPathCache.clear()
}

/** Translate an MSYS path before a native Windows file API sees it. */
export function translateGitBashPath(
  filePath: string,
  dependencies: WindowsShellPathDependencies = {},
): string {
  const platform = dependencies.platform ?? process.platform
  if (platform !== 'win32' || !isGitBashAbsolutePath(filePath)) return filePath

  if (MSYS_DRIVE_PATTERN.test(filePath)) {
    return `${filePath.charAt(1).toUpperCase()}:\\${filePath.slice(3).replace(/\//g, '\\')}`
  }

  const cached = translatedPathCache.get(filePath)
  if (cached !== undefined) return cached

  const env = dependencies.env ?? getSystemProcessEnv()
  const bash = (dependencies.findBash ?? findWindowsBash)(env)
  if (!bash) return filePath

  const cygpath = findCygpath(bash, dependencies.pathExists ?? pathExists)
  if (!cygpath) return filePath

  const translated = runCygpath(
    dependencies.spawnCygpath ?? spawnCygpath,
    cygpath,
    filePath,
  )
  if (translated === null) return filePath
  translatedPathCache.set(filePath, translated)
  return translated
}

/**
 * What a Windows user sees when we genuinely cannot find a bash. Installing is the answer for
 * almost everyone; the environment variable is deliberately last, because we search the standard
 * install locations, PATH, and the registry before ever reaching this, so a user who has Git
 * should never be reading it.
 */
export function createWindowsBashNotFoundError(): Error {
  return new Error(
    `Bash is required but was not found on this Windows system.

Install Git for Windows, which includes it: https://git-scm.com/download/win
Or, from a terminal: winget install --id Git.Git --exact --source winget

If you already have Git installed somewhere unusual and we did not find it, point
us at it directly by setting CODEBUFF_GIT_BASH_PATH to its bash.exe. Example:
   set CODEBUFF_GIT_BASH_PATH=C:\\path\\to\\Git\\bin\\bash.exe`,
  )
}
