import { readFileSync, type StatsFs } from 'node:fs'
import { mkdtemp, readdir, rm, statfs as statfsAsync } from 'node:fs/promises'
import { cpus, freemem, tmpdir, totalmem } from 'node:os'
import { join, sep } from 'node:path'
import { finding, type DoctorFinding } from '../types'
import type { DoctorRedactor } from '../redact'
import { LEARN_MORE } from '../help'

// ---------------------------------------------------------------- disk

const LOW_DISK_BYTES = 2 * 1024 ** 3
const CRITICAL_DISK_BYTES = 512 * 1024 ** 2

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`

export async function diskFinding(label: string, dir: string, redact: DoctorRedactor,
  statfs: (path: string) => Promise<Pick<StatsFs, 'bavail' | 'bsize'>> | Pick<StatsFs, 'bavail' | 'bsize'> = statfsAsync): Promise<DoctorFinding> {
  let free: number
  try {
    const stats = await statfs(dir)
    free = Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return finding('disk.unknown', 'info', 'disk', `Could not read free space for ${label}`, `The drive holding ${redact.path(dir)} did not report its free space.`)
  }
  if (free < CRITICAL_DISK_BYTES)
    return finding('disk.critical', 'error', 'disk', `Almost no disk space left (${gb(free)})`,
      `The drive holding ${label} has ${gb(free)} free. Chats, worktrees and updates fail or are left half written when it fills.`,
      ['Free up several gigabytes on this drive (empty the trash, remove old downloads or unused node_modules folders).', 'Restart Freebuff.'])
  if (free < LOW_DISK_BYTES)
    return finding('disk.low', 'warning', 'disk', `Disk space is low (${gb(free)})`,
      `The drive holding ${label} has ${gb(free)} free. Worktrees and dependency installs need room.`, ['Free up a few gigabytes on this drive.'])
  return finding('disk.ok', 'ok', 'disk', 'Enough disk space', `${gb(free)} free on the drive holding ${label}.`)
}

// ---------------------------------------------------------------- synced folders

const SYNC_PROVIDERS: Array<[RegExp, string]> = [
  [/(?:^|[\\/])OneDrive(?: - [^\\/]+)?(?:[\\/]|$)/i, 'OneDrive'],
  [/(?:^|[\\/])Dropbox(?: \([^\\/]+\))?(?:[\\/]|$)/i, 'Dropbox'],
  [/(?:^|[\\/])(?:Google Drive|GoogleDrive-[^\\/]+|My Drive)(?:[\\/]|$)/i, 'Google Drive'],
  [/[\\/]Library[\\/]Mobile Documents[\\/]|(?:^|[\\/])iCloud ?Drive(?:[\\/]|$)/i, 'iCloud Drive'],
  [/(?:^|[\\/])Box(?: Sync)?(?:[\\/]|$)|[\\/]Library[\\/]CloudStorage[\\/]Box-/i, 'Box'],
  [/[\\/]Library[\\/]CloudStorage[\\/](?:OneDrive|Dropbox|GoogleDrive)/i, 'a cloud storage provider'],
]

/** The sync client that owns a path, or null. Recognises the default folder names only. */
export function syncProviderFor(path: string): string | null {
  for (const [pattern, name] of SYNC_PROVIDERS) if (pattern.test(path)) return name
  return null
}

// ---------------------------------------------------------------- temp

export async function tempDirFinding(dir = tmpdir(), redact?: DoctorRedactor): Promise<DoctorFinding> {
  try {
    const probe = await mkdtemp(join(dir, 'freebuff-doctor-'))
    await rm(probe, { recursive: true, force: true })
    return finding('temp.ok', 'ok', 'system', 'The temporary folder is writable', 'Freebuff can create temporary files.')
  } catch {
    return finding('temp.unwritable', 'error', 'system', 'The temporary folder is not writable',
      `Freebuff could not create a file in ${redact ? redact.path(dir) : 'the temporary folder'}. Installs, downloads and tools that need scratch space fail.`,
      ['Check that TMPDIR, TEMP or TMP points at a folder that exists and that you can write to.', 'Free up disk space if the drive is full.'])
  }
}

// ---------------------------------------------------------------- architecture and memory

/** macOS on Apple silicon running an x64 build under Rosetta: slower, and native modules mismatch. */
export function architectureFinding(platform = process.platform, arch = process.arch, cpuModel = cpus()[0]?.model ?? '',
  translated?: boolean): DoctorFinding | null {
  const rosetta = translated ?? (platform === 'darwin' && arch === 'x64' && /Apple/i.test(cpuModel))
  if (rosetta)
    return finding('system.rosetta', 'warning', 'system', 'Running the Intel build on an Apple silicon Mac',
      'This copy of Freebuff runs under Rosetta translation. It is slower, and tools it starts may not match your Mac.',
      ['Download Freebuff again from freebuff.com and choose the Apple silicon build.'])
  if (platform === 'win32' && arch === 'ia32')
    return finding('system.32-bit', 'error', 'system', 'A 32-bit runtime is in use', 'Freebuff needs a 64-bit system and runtime.', ['Install the 64-bit version.'])
  return null
}

export function memoryFinding(free = freemem(), total = totalmem()): DoctorFinding | null {
  if (total > 0 && free / total < 0.05 && free < 1024 ** 3)
    return finding('system.memory-low', 'warning', 'system', `Memory is almost full (${gb(free)} free)`,
      'With this little memory left, Freebuff and the tools it runs can be killed or freeze.', ['Close apps you are not using, then try again.'])
  return null
}

// ---------------------------------------------------------------- file watchers

export function watcherLimitFinding(platform = process.platform, read: (path: string) => string = path => readFileSync(path, 'utf8')): DoctorFinding | null {
  if (platform !== 'linux') return null
  try {
    const watches = Number(read('/proc/sys/fs/inotify/max_user_watches').trim())
    if (Number.isFinite(watches) && watches < 65_536)
      return finding('system.inotify-low', 'warning', 'system', `The file-watch limit is low (${watches})`,
        'Linux limits how many folders one user can watch. Large projects exceed a low limit, and file changes then go unnoticed (or tools fail with ENOSPC).',
        ['Raise it: `echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/60-freebuff.conf && sudo sysctl --system`.'],
        { learnMore: LEARN_MORE.linuxInotify })
  } catch { /* not exposed in this container */ }
  return null
}

// ---------------------------------------------------------------- Windows path length

/** Counts files under `roots` whose full path passes Windows' 260-character limit. Bounded. */
export async function longPathFinding(roots: string[], platform = process.platform, maxEntries = 20_000,
  list: (dir: string) => Promise<Array<{ name: string; isDirectory(): boolean }>> | Array<{ name: string; isDirectory(): boolean }> = dir => readdir(dir, { withFileTypes: true })): Promise<DoctorFinding | null> {
  if (platform !== 'win32') return null
  let seen = 0
  let over = 0
  const stack = [...roots]
  while (stack.length && seen < maxEntries) {
    const dir = stack.pop()!
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try { entries = await list(dir) } catch { continue }
    for (const entry of entries) {
      seen++
      const full = `${dir}${sep}${entry.name}`
      if (full.length >= 260) over++
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') stack.push(full)
    }
  }
  if (!over) return null
  return finding('system.long-paths', 'warning', 'system', `${over} file path${over === 1 ? ' is' : 's are'} longer than Windows allows by default`,
    'Paths over 260 characters fail in many Windows tools unless long paths are enabled.',
    ['Enable long paths: run `git config --global core.longpaths true`, and turn on "Enable Win32 long paths" in Group Policy (or the LongPathsEnabled registry value).', 'Keep projects in a short folder such as C:\\code.'],
    { learnMore: LEARN_MORE.windowsLongPaths })
}
