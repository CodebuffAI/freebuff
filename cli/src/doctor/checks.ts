import fs from 'fs'
import path from 'path'

import { finding, type DoctorFinding } from '@codebuff/common/doctor/types'
import type { DoctorRedactor } from '@codebuff/common/doctor/redact'
import { COMMON_LOG_SIGNATURES, logScanFindings, scanLogText } from '@codebuff/common/doctor/log-signatures'
import type { RunCommand } from '@codebuff/common/doctor/node/git'

/**
 * Checks only the CLI needs: how it is installed, what the shell runs when you type its name,
 * what the launcher left behind, and its own sign-in, history and crash files. The network,
 * clock, disk and git checks are the shared ones (`common/src/doctor/node`), as in Desktop.
 */

type Fs = Pick<typeof fs, 'existsSync' | 'readdirSync' | 'statSync' | 'readFileSync'>

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`

export function compareVersions(a: string, b: string) {
  const parts = (v: string) => v.split(/[.+-]/).map(n => Number.parseInt(n, 10)).map(n => (Number.isFinite(n) ? n : 0))
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

// ---------------------------------------------------------------- install

export function installFindings(input: {
  version: string
  latest: string | null
  launcherVersion: string | null
  packageName: string
}): DoctorFinding[] {
  const out: DoctorFinding[] = []
  if (input.version === 'dev') return out
  if (input.latest && compareVersions(input.latest, input.version) > 0)
    out.push(finding('install.outdated', 'warning', 'install', `${input.packageName} ${input.latest} is available (you have ${input.version})`,
      'Many problems are already fixed in the current version.',
      [`Quit ${input.packageName} and start it again: the launcher installs the update when it starts.`,
        `If it stays on ${input.version}, run \`npm install -g ${input.packageName}@latest\`.`]))
  else if (input.latest)
    out.push(finding('install.current', 'ok', 'install', `${input.packageName} is up to date`, `Version ${input.version}.`))
  if (input.launcherVersion && input.latest && compareVersions(input.latest, input.launcherVersion) > 0 && compareVersions(input.version, input.launcherVersion) > 0)
    out.push(finding('install.old-launcher', 'info', 'install', 'The npm launcher is older than the app it starts',
      `The launcher installed with npm (${input.launcherVersion}) never updates itself. Newer launchers recover from more update failures.`,
      [`Run \`npm install -g ${input.packageName}@latest\`.`]))
  return out
}

/** The binary the launcher downloads into the config folder: present, non-empty, runnable. */
export async function binaryFindings(input: { configDir: string; packageName: string; platform: string; redact: DoctorRedactor; fs?: Fs; run?: RunCommand }): Promise<DoctorFinding[]> {
  const files = input.fs ?? fs
  const binary = path.join(input.configDir, input.platform === 'win32' ? `${input.packageName}.exe` : input.packageName)
  let stats: fs.Stats
  try { stats = files.statSync(binary) } catch { return [] } // run from source or another install method
  if (!stats.size)
    return [finding('install.binary-empty', 'error', 'install', 'The downloaded app is empty',
      `${input.redact.path(binary)} has no content, usually from a download that was cut off.`,
      ['Delete that file and start the CLI again; the launcher downloads it again.'])]
  if (input.platform !== 'win32' && !(stats.mode & 0o111))
    return [finding('install.binary-not-executable', 'error', 'install', 'The downloaded app cannot be run',
      `${input.redact.path(binary)} is not marked as executable.`, [`Run \`chmod +x ${input.redact.path(binary)}\`, or delete it and start the CLI again.`])]
  if (input.platform === 'darwin' && input.run) {
    const quarantine = await input.run('xattr', ['-p', 'com.apple.quarantine', binary], { timeoutMs: 3_000 })
    if (quarantine.code === 0 && quarantine.stdout.trim())
      return [finding('install.binary-quarantined', 'warning', 'install', 'macOS has quarantined the downloaded app',
        'Gatekeeper may refuse to run a file marked as downloaded from the internet.',
        [`Run \`xattr -d com.apple.quarantine ${input.redact.path(binary)}\`.`])]
  }
  return []
}

/** Every file the shell could run for `name`, in PATH order. */
export function commandsOnPath(name: string, env: Record<string, string | undefined>, platform: string, files: Fs = fs) {
  const separator = platform === 'win32' ? ';' : ':'
  const dirs = (env.PATH ?? env.Path ?? '').split(separator).filter(Boolean)
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : ['']
  const found: string[] = []
  const seen = new Set<string>()
  const normalized = (dir: string) => (platform === 'win32' ? dir.toLowerCase() : dir).replace(/[\\/]+$/, '')
  let repeated = 0
  for (const dir of dirs) {
    const key = normalized(dir)
    if (seen.has(key)) { repeated++; continue }
    seen.add(key)
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext)
      try { if (files.statSync(candidate).isFile()) { found.push(candidate); break } } catch { /* not here */ }
    }
  }
  return { found, repeated }
}

export function shadowingFindings(name: string, onPath: { found: string[]; repeated: number }, redact: DoctorRedactor): DoctorFinding[] {
  const out: DoctorFinding[] = []
  const dirs = [...new Set(onPath.found.map(file => path.dirname(file)))]
  if (dirs.length > 1)
    out.push(finding('install.shadowed', 'warning', 'install', `${plural(dirs.length, 'copy', 'copies')} of \`${name}\` are on your PATH`,
      `Your shell runs the first one (${redact.path(onPath.found[0]!)}). Updating or reinstalling another copy changes nothing you can run.`,
      ['Remove the copies you do not use (for example `npm uninstall -g` from the other Node install, or delete the old file).', `Check with \`${process.platform === 'win32' ? 'where' : 'which -a'} ${name}\`.`]))
  if (onPath.repeated)
    out.push(finding('install.path-repeated', 'info', 'install', `${plural(onPath.repeated, 'folder')} appear${onPath.repeated === 1 ? 's' : ''} more than once on your PATH`,
      'Harmless, but it makes it harder to tell which install runs.', ['Remove the repeated entries from your shell profile.']))
  return out
}

// ---------------------------------------------------------------- launcher leftovers

const PID_DIR = /^\.download-temp-(\d+)$/

/** Superseded engine copies, interrupted downloads, and download folders whose process is gone. */
export function leftoverFindings(input: { configDir: string; now: number; isAlive: (pid: number) => boolean; fs?: Fs }): DoctorFinding[] {
  const files = input.fs ?? fs
  let names: string[]
  try { names = files.readdirSync(input.configDir) } catch { return [] }
  let oldCopies = 0
  let partial = 0
  let bytes = 0
  let stale = 0
  for (const name of names) {
    const full = path.join(input.configDir, name)
    let stats: fs.Stats
    try { stats = files.statSync(full) } catch { continue }
    if (/\.old\.\d+(?:\.\d+)?$/.test(name)) { oldCopies++; bytes += stats.size }
    else if (/\.(?:part|crdownload)$/.test(name) && input.now - stats.mtimeMs > 60 * 60_000) { partial++; bytes += stats.size }
    else {
      const pid = PID_DIR.exec(name)?.[1]
      if (pid && stats.isDirectory() && !input.isAlive(Number(pid))) stale++
    }
  }
  const out: DoctorFinding[] = []
  if (oldCopies || partial)
    out.push(finding('install.leftover-copies', 'info', 'install', `Old app copies and unfinished downloads use ${mb(bytes)}`,
      `${[oldCopies ? plural(oldCopies, 'replaced copy', 'replaced copies') : '', partial ? plural(partial, 'unfinished download') : ''].filter(Boolean).join(' and ')} are left in the CLI's folder from earlier updates. On Windows a copy still in use cannot be deleted until it exits.`,
      ['Quit every running copy of the CLI, then delete the files ending in `.old.<number>` or `.part` in its config folder.']))
  if (stale)
    out.push(finding('install.stale-download', 'info', 'install', `${plural(stale, 'download folder')} from a process that is gone`,
      'An update download was interrupted and its folder was left behind. The next update starts over.', ['Delete the `.download-temp-<number>` folders in the CLI\'s config folder.']))
  return out
}

// ---------------------------------------------------------------- sign-in

/** The credentials file's shape and permissions. The token itself is never read into a finding. */
export function authFindings(input: { configDir: string; platform: string; redact: DoctorRedactor; fs?: Fs; command: string }): DoctorFinding[] {
  const files = input.fs ?? fs
  const file = path.join(input.configDir, 'credentials.json')
  let text: string
  try { text = files.readFileSync(file, 'utf8') as string } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return [finding('auth.signed-out', 'info', 'auth', 'Not signed in', 'There is no saved sign-in on this computer.', [`Run \`${input.command} login\`.`])]
    return [finding('auth.unreadable', 'error', 'auth', 'The saved sign-in cannot be read',
      `${input.redact.path(file)} exists but could not be opened.`, ['Check that your user owns the file, or delete it and sign in again.'])]
  }
  let profiles: unknown[]
  try {
    const parsed = JSON.parse(text) as unknown
    profiles = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.values(parsed) : []
  } catch {
    return [finding('auth.corrupt', 'error', 'auth', 'The saved sign-in is damaged',
      `${input.redact.path(file)} is not valid JSON, so every request runs signed out.`, [`Delete it and run \`${input.command} login\`.`])]
  }
  const usable = profiles.some(p => p && typeof p === 'object' &&
    (typeof (p as { authToken?: unknown }).authToken === 'string' || (p as { tokenStore?: unknown }).tokenStore === 'keychain'))
  const out: DoctorFinding[] = usable
    ? [finding('auth.ok', 'ok', 'auth', 'A sign-in is saved', 'The saved sign-in file reads cleanly.')]
    : [finding('auth.empty', 'warning', 'auth', 'The saved sign-in has no account in it', 'The file exists but holds no usable sign-in.', [`Run \`${input.command} login\`.`])]
  if (input.platform !== 'win32') {
    try {
      if (files.statSync(file).mode & 0o077)
        out.push(finding('auth.permissions', 'warning', 'auth', 'Other users on this computer can read your sign-in',
          `${input.redact.path(file)} is readable beyond your own account.`, [`Run \`chmod 600 ${input.redact.path(file)}\`.`]))
    } catch { /* checked above */ }
  }
  return out
}

// ---------------------------------------------------------------- history, crashes, logs

/** Size of local history, newest log tail, and the last fatal crash the CLI recorded. */
export function historyFindings(input: { configDir: string; now: number; fs?: Fs; maxEntries?: number }): { findings: DoctorFinding[]; newestLog: string | null } {
  const files = input.fs ?? fs
  const projects = path.join(input.configDir, 'projects')
  let bytes = 0
  let unreadable = 0
  let newest: { file: string; mtime: number } | null = null
  let seen = 0
  const stack = [projects]
  while (stack.length && seen < (input.maxEntries ?? 20_000)) {
    const dir = stack.pop()!
    let names: string[]
    try { names = files.readdirSync(dir) } catch { if (dir !== projects) unreadable++; continue }
    for (const name of names) {
      seen++
      const full = path.join(dir, name)
      let stats: fs.Stats
      try { stats = files.statSync(full) } catch { unreadable++; continue }
      if (stats.isDirectory()) stack.push(full)
      else {
        bytes += stats.size
        if (name === 'log.jsonl' && (!newest || stats.mtimeMs > newest.mtime)) newest = { file: full, mtime: stats.mtimeMs }
      }
    }
  }
  const out: DoctorFinding[] = []
  if (unreadable)
    out.push(finding('history.unreadable', 'warning', 'state', `${plural(unreadable, 'history file')} cannot be read`,
      'Some saved chats cannot be opened, so `--continue` may not find them.', ['Check that your user owns the CLI\'s config folder.']))
  if (bytes > 2 * 1024 ** 3)
    out.push(finding('history.large', 'info', 'state', `Local history uses ${mb(bytes)}`,
      'Old chats are kept until you remove them.', ['Delete project folders you no longer need under the CLI\'s `projects` folder.']))
  try {
    const crash = JSON.parse(files.readFileSync(path.join(input.configDir, 'last-fatal-crash.json'), 'utf8') as string) as { errorName?: unknown; crashedAt?: unknown; crashedVersion?: unknown }
    const at = typeof crash.crashedAt === 'string' ? Date.parse(crash.crashedAt) : NaN
    if (!Number.isFinite(at) || input.now - at < 7 * 86_400_000)
      out.push(finding('crash.recent', 'warning', 'state', 'The CLI crashed recently',
        `The last run stopped on a fatal error${typeof crash.errorName === 'string' ? ` (${crash.errorName.slice(0, 60)})` : ''}${typeof crash.crashedVersion === 'string' ? ` in version ${crash.crashedVersion.slice(0, 20)}` : ''}.`,
        ['Update to the current version.', 'If it happens again, send this report to support.']))
  } catch { /* no crash recorded */ }
  return { findings: out, newestLog: newest?.file ?? null }
}

export function logFindings(file: string | null, files: Fs = fs): DoctorFinding[] {
  if (!file) return []
  let text: string
  try {
    const raw = files.readFileSync(file, 'utf8') as string
    text = raw.length > 512 * 1024 ? raw.slice(-512 * 1024) : raw
  } catch { return [] }
  return logScanFindings(scanLogText(text, COMMON_LOG_SIGNATURES), 'the most recent chat log')
}

// ---------------------------------------------------------------- Node and npm

/** The npm launcher runs on Node. Its version, and how many Node installs compete on PATH. */
export async function nodeFindings(input: { run: RunCommand; env: Record<string, string | undefined>; platform: string; fs?: Fs }): Promise<DoctorFinding[]> {
  const out: DoctorFinding[] = []
  const version = await input.run('node', ['--version'], { timeoutMs: 3_000 })
  if (!version.missing && version.code === 0) {
    const major = Number(/^v(\d+)/.exec(version.stdout.trim())?.[1])
    if (major && major < 16)
      out.push(finding('node.too-old', 'error', 'install', `Node ${version.stdout.trim()} is too old for the launcher`,
        'The npm launcher needs Node 16 or newer.', ['Install a current Node LTS from nodejs.org, then reinstall the CLI.']))
  }
  const nodes = commandsOnPath('node', input.env, input.platform, input.fs).found
  if (new Set(nodes.map(file => path.dirname(file))).size > 1)
    out.push(finding('node.several', 'info', 'install', `${plural(nodes.length, 'Node install')} on your PATH`,
      'Global packages installed with one Node are invisible to the other, which is a common reason an update "does nothing".',
      ['Use one Node install (or one version manager), and install the CLI with it.']))
  const registry = input.env.npm_config_registry ?? input.env.NPM_CONFIG_REGISTRY
  if (registry && !/registry\.npmjs\.org/.test(registry))
    out.push(finding('env.npm-registry', 'info', 'environment', 'npm uses a custom registry',
      'npm_config_registry points at a registry other than npmjs.org. If it mirrors slowly, installs and updates lag behind.', []))
  return out
}

export async function latestPublishedVersion(packageName: string, fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch) {
  try {
    const response = await fetcher(`https://registry.npmjs.org/${packageName}/latest`, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return null
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === 'string' && /^\d+\.\d+\.\d+/.test(body.version) ? body.version : null
  } catch { return null }
}

export function isPidAlive(pid: number) {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
