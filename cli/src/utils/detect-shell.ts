import { execFileSync } from 'child_process'

import { getCliEnv } from './env'

import type { CliEnv } from '../types/env'

type KnownShell =
  | 'bash'
  | 'zsh'
  | 'fish'
  | 'cmd.exe'
  | 'powershell'
  | 'unknown'

type ShellName = KnownShell | string

let cachedShell: ShellName | null = null

const SHELL_ALIASES: Record<string, KnownShell> = {
  bash: 'bash',
  zsh: 'zsh',
  fish: 'fish',
  cmd: 'cmd.exe',
  'cmd.exe': 'cmd.exe',
  pwsh: 'powershell',
  powershell: 'powershell',
  'powershell.exe': 'powershell',
}

export function detectShell(env: CliEnv = getCliEnv()): ShellName {
  if (cachedShell) {
    return cachedShell
  }

  const detected =
    detectFromEnvironment(env) ?? detectViaParentProcessInspection() ?? 'unknown'
  cachedShell = detected
  return detected
}

function detectFromEnvironment(env: CliEnv): ShellName | null {
  const candidates: Array<string | undefined> = []

  if (process.platform === 'win32') {
    candidates.push(env.COMSPEC, env.SHELL)
  } else {
    candidates.push(env.SHELL)
  }

  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate)
    if (normalized) {
      return normalized
    }
  }

  return null
}

function detectViaParentProcessInspection(): ShellName | null {
  try {
    if (process.platform === 'win32') {
      const parentProcess = execFileSync(
        'wmic',
        ['process', 'get', 'ParentProcessId,CommandLine'],
        { stdio: 'pipe' },
      )
        .toString()
        .toLowerCase()

      if (parentProcess.includes('powershell')) return 'powershell'
      if (parentProcess.includes('cmd.exe')) return 'cmd.exe'
    } else {
      // Arguments, not a command line: `execSync` would hand this string to a
      // shell, so `${process.ppid}` would be shell-parsed rather than passed.
      // `process.ppid` is always a number today, which is why this is a change
      // of shape rather than a fix for a live exploit.
      const parentProcess = execFileSync(
        'ps',
        ['-p', String(process.ppid), '-o', 'comm='],
        { stdio: 'pipe' },
      )
        .toString()
        .trim()
      const normalized = normalizeCandidate(parentProcess)
      if (normalized) return normalized
    }
  } catch {
    // Ignore inspection errors
  }

  return null
}

function normalizeCandidate(value?: string | null): ShellName | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const lower = trimmed.toLowerCase()
  const parts = lower.split(/[/\\]/)
  const last = parts.pop() ?? lower
  const base = last.endsWith('.exe') ? last.slice(0, -4) : last

  if (SHELL_ALIASES[base]) {
    return SHELL_ALIASES[base]
  }

  if (SHELL_ALIASES[last]) {
    return SHELL_ALIASES[last]
  }

  if (base.endsWith('sh')) {
    return base
  }

  return null
}
