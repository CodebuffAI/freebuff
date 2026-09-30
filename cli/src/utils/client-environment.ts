/**
 * A compact summary of the terminal environment this CLI is running in, sent
 * as `x-freebuff-env` on session and ad requests and in `codebuff_metadata`.
 *
 * Only presence flags, a size, and fixed bucket names: never a raw environment
 * value, path, or process name. Built once per process; the two parts that
 * need I/O (ancestor process kinds, whether the terminal answered the colour
 * query) are filled in when they resolve and never block startup.
 *
 *   v1;in=1;out=1;tp=iterm;term=1;ct=1;sz=120x40;ci=0;ssh=0;l=1;p=shell;g=terminal;osc=1
 */
import { execFile } from 'child_process'
import { readFile } from 'fs/promises'

import {
  FREEBUFF_CLIENT_DESCRIPTOR_VERSION,
  FREEBUFF_CLIENT_ENV_HEADER,
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
  name = name.replace(/^-+/, '').replace(/\.exe$/i, '').toLowerCase()
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
): string {
  const { env, ciEnv } = inputs
  const ci =
    ciEnv.CI === 'true' || ciEnv.CI === '1' || ciEnv.GITHUB_ACTIONS === 'true'
  const fields: Array<[string, string]> = [
    ['in', flag(inputs.stdinIsTTY)],
    ['out', flag(inputs.stdoutIsTTY)],
    ['tp', bucketTerminalProgram(env.TERM_PROGRAM)],
    ['term', flag(env.TERM)],
    ['ct', flag(env.COLORTERM)],
    [
      'sz',
      `${clampDimension(inputs.columns)}x${clampDimension(inputs.rows)}`,
    ],
    ['ci', flag(ci)],
    ['ssh', flag(env.SSH_TTY || env.SSH_CONNECTION)],
    ['l', flag(ancestry.launcher)],
    ['p', ancestry.parent],
    ['g', ancestry.grandparent],
    ['osc', colorReply === 'yes' ? '1' : colorReply === 'no' ? '0' : 'na'],
  ]
  return [
    FREEBUFF_CLIENT_DESCRIPTOR_VERSION,
    ...fields.map(([k, v]) => `${k}=${v}`),
  ].join(';')
}

let inputs: ClientEnvironmentInputs | null = null
let ancestry: ProcessAncestry = UNKNOWN_ANCESTRY
let colorReply: TerminalColorReply = 'na'
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
): Promise<void> {
  if (probe) return probe
  probe = lookupProcessAncestry({
    ppid: process.ppid,
    launcherPid: getCliEnv().CODEBUFF_LAUNCHER_PID,
    platform: process.platform,
    read,
  })
    .then((result) => {
      ancestry = result
      cached = null
    })
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
    cached = formatClientEnvironment(inputs, ancestry, colorReply)
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

/** Test-only. */
export function resetClientEnvironmentForTest(): void {
  inputs = null
  ancestry = UNKNOWN_ANCESTRY
  colorReply = 'na'
  cached = null
  probe = null
}
