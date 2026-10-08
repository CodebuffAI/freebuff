/**
 * A compact summary of the terminal environment this CLI is running in, sent
 * as `x-freebuff-env` on session and ad requests and in `codebuff_metadata`.
 *
 * Only presence flags, a size, and fixed bucket names: never a raw environment
 * value, path, or process name. Built once per process; the two parts that
 * need I/O (ancestor process kinds, whether the terminal answered the colour
 * query) are filled in when they resolve and never block startup.
 *
 *   v1;in=1;out=1;tp=iterm;term=1;ct=1;sz=120x40;ci=0;ssh=0;l=1;p=shell;g=terminal;osc=1;tzo=0;px=none;tls=1;ca=0
 *
 * The one exception to "no raw value" is `stz`, the operating system's own
 * IANA zone, sent only when `TZ` overrides it.
 */
import { execFile } from 'child_process'
import { readFile, readlink } from 'fs/promises'

import {
  FREEBUFF_CLIENT_DESCRIPTOR_VERSION,
  FREEBUFF_CLIENT_ENV_HEADER,
  type CloudIdeBucket,
  type ProcessKindBucket,
  type TerminalProgramBucket,
} from '@codebuff/common/constants/freebuff-client-descriptor'
import { getCiEnv } from '@codebuff/common/env-ci'

import { IS_FREEBUFF } from './constants'
import { getCliEnv } from './env'

import type { CliEnv } from '../types/env'
import type { CiEnv } from '@codebuff/common/types/contracts/env'

const TERMINAL_PROGRAMS: Record<string, TerminalProgramBucket> = {
  apple_terminal: 'apple_terminal',
  'iterm.app': 'iterm',
  iterm2: 'iterm',
  vscode: 'vscode',
  ghostty: 'ghostty',
  wezterm: 'wezterm',
  warpterminal: 'warp',
  hyper: 'hyper',
  tmux: 'tmux',
  zed: 'zed',
  tabby: 'tabby',
  rio: 'rio',
  mintty: 'mintty',
  'jetbrains-jediterm': 'jetbrains',
  kitty: 'kitty',
  alacritty: 'alacritty',
}

export function bucketTerminalProgram(
  value: string | undefined,
): TerminalProgramBucket {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return 'none'
  return TERMINAL_PROGRAMS[normalized] ?? 'other'
}

const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'mksh',
  'tcsh',
  'csh',
  'nu',
  'elvish',
  'xonsh',
  'pwsh',
  'powershell',
  'cmd',
  'login',
])
const TERMINALS = new Set([
  'terminal',
  'iterm2',
  'ghostty',
  'wezterm',
  'wezterm-gui',
  'alacritty',
  'kitty',
  'warp',
  // Warp's macOS executable
  'stable',
  'hyper',
  'tabby',
  'konsole',
  'gnome-terminal',
  'gnome-terminal-server',
  // Linux truncates comm to 15 characters
  'gnome-terminal-',
  'xfce4-terminal',
  'mate-terminal',
  'lxterminal',
  'tilix',
  'terminator',
  'xterm',
  'urxvt',
  'rxvt',
  'st',
  'foot',
  'rio',
  'mintty',
  'windowsterminal',
  'openconsole',
  'conhost',
  'contour',
  'blackbox',
  'ptyxis',
  'ptyxis-agent',
])
const EDITORS = new Set([
  'code',
  'code-insiders',
  'cursor',
  'windsurf',
  'zed',
  'idea',
  'pycharm',
  'webstorm',
  'goland',
  'clion',
  'rider',
  'phpstorm',
  'rubymine',
  'datagrip',
  'fleet',
  'nvim',
  'vim',
  'emacs',
  'helix',
  'hx',
  'sublime_text',
])
const MULTIPLEXERS = new Set(['tmux', 'screen', 'zellij', 'byobu', 'abduco'])

/** Reduce a process basename (as `ps -o comm=` or /proc reports it) to a kind. */
export function bucketProcessName(
  rawName: string | undefined,
): ProcessKindBucket {
  if (!rawName) return 'unknown'
  // `ps` reports a full path on macOS and a login shell as `-zsh`.
  let name = rawName.trim()
  const slash = name.lastIndexOf('/')
  if (slash >= 0) name = name.slice(slash + 1)
  name = name
    .replace(/^-+/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase()
  if (!name) return 'unknown'
  if (SHELLS.has(name)) return 'shell'
  if (MULTIPLEXERS.has(name) || name.startsWith('tmux')) return 'mux'
  if (name === 'sshd' || name.startsWith('sshd-')) return 'sshd'
  if (name === 'node' || name === 'nodejs') return 'node'
  if (/^python[0-9.]*$/.test(name) || name === 'pypy' || name === 'pypy3')
    return 'python'
  if (name === 'bun') return 'bun'
  if (TERMINALS.has(name)) return 'terminal'
  if (EDITORS.has(name)) return 'editor'
  // Electron helpers: "Code Helper (Plugin)", "Cursor Helper", …
  if (/^(code|cursor|windsurf|zed|electron)( helper|$)/.test(name))
    return 'editor'
  return 'other'
}

export type ProcessInfo = { ppid: number | null; name: string | undefined }
export type ReadProcessInfo = (pid: number) => Promise<ProcessInfo | null>

const PROCESS_LOOKUP_TIMEOUT_MS = 1_000

/** `/proc/<pid>/stat` on Linux, `ps` elsewhere. Resolves null on any failure. */
export const readProcessInfo: ReadProcessInfo = async (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return null
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const open = stat.indexOf('(')
      const close = stat.lastIndexOf(')')
      if (open >= 0 && close > open) {
        const fields = stat.slice(close + 2).split(' ')
        const ppid = Number(fields[1])
        return {
          ppid: Number.isSafeInteger(ppid) ? ppid : null,
          name: stat.slice(open + 1, close),
        }
      }
    } catch {
      // fall through to ps
    }
  }
  return new Promise((resolve) => {
    try {
      execFile(
        'ps',
        ['-o', 'ppid=,comm=', '-p', String(pid)],
        {
          timeout: PROCESS_LOOKUP_TIMEOUT_MS,
          maxBuffer: 16 * 1024,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) return resolve(null)
          const line = String(stdout).trim().split('\n')[0]?.trim() ?? ''
          const match = /^(\d+)\s+(.+)$/.exec(line)
          if (!match) return resolve(null)
          resolve({ ppid: Number(match[1]), name: match[2] })
        },
      )
    } catch {
      resolve(null)
    }
  })
}

export type ProcessAncestry = {
  /** Our npm launcher is the direct parent (and was skipped over). */
  launcher: boolean
  parent: ProcessKindBucket
  grandparent: ProcessKindBucket
}

const UNKNOWN_ANCESTRY: ProcessAncestry = {
  launcher: false,
  parent: 'unknown',
  grandparent: 'unknown',
}

/**
 * The kinds of the first two ancestors, skipping our own npm launcher when it
 * is the direct parent. Never throws; anything it cannot read is `unknown`.
 */
export async function lookupProcessAncestry(params: {
  ppid: number
  launcherPid: string | undefined
  platform: NodeJS.Platform
  read?: ReadProcessInfo
}): Promise<ProcessAncestry> {
  const { ppid, launcherPid, platform, read = readProcessInfo } = params
  if (platform === 'win32') {
    return { launcher: false, parent: 'na', grandparent: 'na' }
  }
  try {
    const launcher = Boolean(launcherPid) && launcherPid === String(ppid)
    let parentPid: number | null = ppid
    if (launcher) {
      parentPid = (await read(ppid))?.ppid ?? null
    }
    if (parentPid === null) return { ...UNKNOWN_ANCESTRY, launcher }
    const parent = await read(parentPid)
    const grandparent =
      parent?.ppid !== null && parent?.ppid !== undefined
        ? await read(parent.ppid)
        : null
    return {
      launcher,
      parent: bucketProcessName(parent?.name),
      grandparent: bucketProcessName(grandparent?.name),
    }
  } catch {
    return UNKNOWN_ANCESTRY
  }
}

/** Where the proxy environment variables point. `loopback` = a proxy on this
 *  machine (127.0.0.0/8, ::1, localhost). */
export type ProxyBucket = 'none' | 'loopback' | 'remote'

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i

/** Reduce a proxy URL to where it points; never passes the URL through. */
export function bucketProxy(value: string | undefined): ProxyBucket {
  const raw = value?.trim()
  if (!raw) return 'none'
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    return LOOPBACK_HOST.test(url.hostname) ? 'loopback' : 'remote'
  } catch {
    return 'remote'
  }
}

/** The cloud IDE this process runs in, from the variables each one sets. */
export function cloudIdeOf(env: CliEnv): CloudIdeBucket {
  if (env.CODESPACES?.trim().toLowerCase() === 'true') return 'codespaces'
  if (env.GITPOD_WORKSPACE_ID?.trim()) return 'gitpod'
  if (env.CLOUD_SHELL?.trim().toLowerCase() === 'true') return 'cloudshell'
  if (env.CODER?.trim().toLowerCase() === 'true') return 'coder'
  return 'none'
}

function proxyBucketOf(env: CliEnv): ProxyBucket {
  const buckets = [
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
    env.ALL_PROXY,
    env.all_proxy,
  ].map(bucketProxy)
  if (buckets.includes('loopback')) return 'loopback'
  if (buckets.includes('remote')) return 'remote'
  return 'none'
}

const ZONE_NAME = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/

/** An IANA zone name from a zoneinfo path (`/var/db/timezone/zoneinfo/Asia/Kolkata`)
 *  or `/etc/timezone` contents; null for anything else. */
export function zoneFromZoneinfo(value: string | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  const marker = raw.lastIndexOf('zoneinfo/')
  const zone = marker >= 0 ? raw.slice(marker + 'zoneinfo/'.length) : raw
  return ZONE_NAME.test(zone) && zone.length <= 64 ? zone : null
}

export type ReadSystemTimeZone = () => Promise<string | null>

/**
 * The zone the operating system is set to, independent of `TZ`: the
 * `/etc/localtime` link target, else `/etc/timezone`. Null on Windows (no
 * file to read) and on any failure.
 */
export const readSystemTimeZone: ReadSystemTimeZone = async () => {
  if (process.platform === 'win32') return null
  try {
    const zone = zoneFromZoneinfo(await readlink('/etc/localtime'))
    if (zone) return zone
  } catch {
    // not a link (copied file) or missing
  }
  try {
    return zoneFromZoneinfo(await readFile('/etc/timezone', 'utf8'))
  } catch {
    return null
  }
}

export type ClientEnvironmentInputs = {
  env: CliEnv
  ciEnv: CiEnv
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  columns: number | undefined
  rows: number | undefined
}

export type TerminalColorReply = 'yes' | 'no' | 'na'

const flag = (value: unknown): '1' | '0' => (value ? '1' : '0')

function clampDimension(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(9999, Math.floor(value)))
}

/** Pure: the descriptor string for the given inputs. */
export function formatClientEnvironment(
  inputs: ClientEnvironmentInputs,
  ancestry: ProcessAncestry,
  colorReply: TerminalColorReply,
  systemZone: string | null = null,
): string {
  const { env, ciEnv } = inputs
  const tzOverride = Boolean(env.TZ?.trim())
  const ci =
    ciEnv.CI === 'true' || ciEnv.CI === '1' || ciEnv.GITHUB_ACTIONS === 'true'
  const fields: Array<[string, string]> = [
    ['in', flag(inputs.stdinIsTTY)],
    ['out', flag(inputs.stdoutIsTTY)],
    ['tp', bucketTerminalProgram(env.TERM_PROGRAM)],
    ['term', flag(env.TERM)],
    ['ct', flag(env.COLORTERM)],
    ['sz', `${clampDimension(inputs.columns)}x${clampDimension(inputs.rows)}`],
    ['ci', flag(ci)],
    ['ssh', flag(env.SSH_TTY || env.SSH_CONNECTION)],
    ['l', flag(ancestry.launcher)],
    ['p', ancestry.parent],
    ['g', ancestry.grandparent],
    ['osc', colorReply === 'yes' ? '1' : colorReply === 'no' ? '0' : 'na'],
    ['tzo', flag(tzOverride)],
    ['px', proxyBucketOf(env)],
    ['tls', env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === '0' ? '0' : '1'],
    ['ca', flag(env.NODE_EXTRA_CA_CERTS?.trim())],
    ['cde', cloudIdeOf(env)],
  ]
  const zone = tzOverride ? zoneFromZoneinfo(systemZone ?? undefined) : null
  if (zone) fields.push(['stz', zone])
  return [
    FREEBUFF_CLIENT_DESCRIPTOR_VERSION,
    ...fields.map(([k, v]) => `${k}=${v}`),
  ].join(';')
}

let inputs: ClientEnvironmentInputs | null = null
let ancestry: ProcessAncestry = UNKNOWN_ANCESTRY
let colorReply: TerminalColorReply = 'na'
let systemZone: string | null = null
let cached: string | null = null
let probe: Promise<void> | null = null

function readInputs(): ClientEnvironmentInputs {
  return {
    env: getCliEnv(),
    ciEnv: getCiEnv(),
    stdinIsTTY: Boolean(process.stdin?.isTTY),
    stdoutIsTTY: Boolean(process.stdout?.isTTY),
    columns: process.stdout?.columns,
    rows: process.stdout?.rows,
  }
}

/**
 * Start the one-time ancestor lookup. Safe to call more than once; the lookup
 * runs in the background and never throws or delays the caller.
 */
export function startClientEnvironmentProbe(
  read: ReadProcessInfo = readProcessInfo,
  readZone: ReadSystemTimeZone = readSystemTimeZone,
): Promise<void> {
  if (probe) return probe
  const env = getCliEnv()
  const ancestryLookup = lookupProcessAncestry({
    ppid: process.ppid,
    launcherPid: env.CODEBUFF_LAUNCHER_PID,
    platform: process.platform,
    read,
  }).then((result) => {
    ancestry = result
    cached = null
  })
  // Only when TZ overrides the system zone; otherwise the two are the same.
  const zoneLookup = env.TZ?.trim()
    ? readZone().then((zone) => {
        systemZone = zone
        cached = null
      })
    : Promise.resolve()
  probe = Promise.all([ancestryLookup, zoneLookup])
    .then(() => {})
    .catch(() => {})
  return probe
}

/** Record whether the terminal answered the startup colour query. */
export function noteTerminalColorReply(answered: boolean): void {
  colorReply = answered ? 'yes' : 'no'
  cached = null
}

/** The descriptor for this process. Synchronous and never throws. */
export function getClientEnvironmentDescriptor(): string {
  if (cached) return cached
  try {
    inputs ??= readInputs()
    cached = formatClientEnvironment(inputs, ancestry, colorReply, systemZone)
  } catch {
    cached = `${FREEBUFF_CLIENT_DESCRIPTOR_VERSION};err=1`
  }
  return cached
}

/** The descriptor as a request header, for Freebuff builds only. */
export function clientEnvironmentHeaders(): Record<string, string> {
  return IS_FREEBUFF
    ? { [FREEBUFF_CLIENT_ENV_HEADER]: getClientEnvironmentDescriptor() }
    : {}
}
