import { describe, expect, test } from 'bun:test'

import { createTestCliEnv } from '../../testing/env'
import {
  bucketProcessName,
  bucketTerminalProgram,
  formatClientEnvironment,
  lookupProcessAncestry,
  type ProcessInfo,
  readProcessInfo,
} from '../client-environment'

import type { CiEnv } from '@codebuff/common/types/contracts/env'

const noCi: CiEnv = {
  CI: undefined,
  GITHUB_ACTIONS: undefined,
  RENDER: undefined,
  IS_PULL_REQUEST: undefined,
  CODEBUFF_GITHUB_TOKEN: undefined,
  CODEBUFF_API_KEY: undefined,
}

describe('bucketTerminalProgram', () => {
  test('maps known programs and never passes free text through', () => {
    expect(bucketTerminalProgram('iTerm.app')).toBe('iterm')
    expect(bucketTerminalProgram('Apple_Terminal')).toBe('apple_terminal')
    expect(bucketTerminalProgram('vscode')).toBe('vscode')
    expect(bucketTerminalProgram('WarpTerminal')).toBe('warp')
    expect(bucketTerminalProgram(undefined)).toBe('none')
    expect(bucketTerminalProgram('  ')).toBe('none')
    expect(bucketTerminalProgram('my-secret-terminal;x=1')).toBe('other')
  })
})

describe('bucketProcessName', () => {
  test.each([
    ['/bin/zsh', 'shell'],
    ['-zsh', 'shell'],
    ['bash', 'shell'],
    ['tmux: server', 'mux'],
    ['/usr/sbin/sshd', 'sshd'],
    ['sshd-session', 'sshd'],
    ['/Applications/iTerm.app/Contents/MacOS/iTerm2', 'terminal'],
    ['gnome-terminal-', 'terminal'],
    ['Code Helper (Plugin)', 'editor'],
    ['node', 'node'],
    ['/usr/local/bin/node', 'node'],
    ['python3.12', 'python'],
    ['bun', 'bun'],
    ['launchd', 'other'],
    ['', 'unknown'],
    [undefined, 'unknown'],
  ] as const)('%p -> %p', (name, bucket) => {
    expect(bucketProcessName(name)).toBe(bucket)
  })
})

function fakeTable(table: Record<number, ProcessInfo>) {
  return async (pid: number) => table[pid] ?? null
}

describe('lookupProcessAncestry', () => {
  test('reads parent and grandparent kinds', async () => {
    const ancestry = await lookupProcessAncestry({
      ppid: 10,
      launcherPid: undefined,
      platform: 'darwin',
      read: fakeTable({
        10: { ppid: 20, name: '-zsh' },
        20: { ppid: 1, name: 'iTerm2' },
      }),
    })
    expect(ancestry).toEqual({
      launcher: false,
      parent: 'shell',
      grandparent: 'terminal',
    })
  })

  test('skips our own launcher when it is the direct parent', async () => {
    const ancestry = await lookupProcessAncestry({
      ppid: 10,
      launcherPid: '10',
      platform: 'linux',
      read: fakeTable({
        10: { ppid: 20, name: 'node' },
        20: { ppid: 30, name: 'python3' },
        30: { ppid: 1, name: 'bash' },
      }),
    })
    expect(ancestry).toEqual({
      launcher: true,
      parent: 'python',
      grandparent: 'shell',
    })
  })

  test('does not treat a stale launcher pid as the launcher', async () => {
    const ancestry = await lookupProcessAncestry({
      ppid: 10,
      launcherPid: '99',
      platform: 'linux',
      read: fakeTable({ 10: { ppid: 20, name: 'node' } }),
    })
    expect(ancestry.launcher).toBe(false)
    expect(ancestry.parent).toBe('node')
    expect(ancestry.grandparent).toBe('unknown')
  })

  test('a failing lookup is unknown, never a throw', async () => {
    const ancestry = await lookupProcessAncestry({
      ppid: 10,
      launcherPid: undefined,
      platform: 'darwin',
      read: async () => {
        throw new Error('ps: not found')
      },
    })
    expect(ancestry).toEqual({
      launcher: false,
      parent: 'unknown',
      grandparent: 'unknown',
    })
  })

  test('a lookup that returns nothing is unknown', async () => {
    const ancestry = await lookupProcessAncestry({
      ppid: 10,
      launcherPid: undefined,
      platform: 'darwin',
      read: async () => null,
    })
    expect(ancestry.parent).toBe('unknown')
  })

  test('Windows is not looked up', async () => {
    let calls = 0
    const ancestry = await lookupProcessAncestry({
      ppid: 10,
      launcherPid: undefined,
      platform: 'win32',
      read: async () => {
        calls++
        return null
      },
    })
    expect(calls).toBe(0)
    expect(ancestry).toEqual({
      launcher: false,
      parent: 'na',
      grandparent: 'na',
    })
  })
})

describe('readProcessInfo', () => {
  test('never throws, and rejects nonsense pids without spawning', async () => {
    expect(await readProcessInfo(-1)).toBeNull()
    expect(await readProcessInfo(Number.NaN)).toBeNull()
    // The real lookup may or may not be available on the runner; it must
    // resolve either way.
    const self = await readProcessInfo(process.pid)
    if (self) expect(typeof self.name).toBe('string')
  })
})

describe('formatClientEnvironment', () => {
  test('renders flags and buckets only', () => {
    const out = formatClientEnvironment(
      {
        env: createTestCliEnv({
          TERM_PROGRAM: 'iTerm.app',
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          SSH_TTY: undefined,
          SSH_CONNECTION: undefined,
        }),
        ciEnv: noCi,
        stdinIsTTY: true,
        stdoutIsTTY: true,
        columns: 120,
        rows: 40,
      },
      { launcher: true, parent: 'shell', grandparent: 'terminal' },
      'yes',
    )
    expect(out).toBe(
      'v1;in=1;out=1;tp=iterm;term=1;ct=1;sz=120x40;ci=0;ssh=0;l=1;p=shell;g=terminal;osc=1',
    )
    // No raw environment value survives.
    expect(out).not.toContain('xterm')
    expect(out).not.toContain('truecolor')
  })

  test('CI, SSH, no TTY and a missing size', () => {
    const out = formatClientEnvironment(
      {
        env: createTestCliEnv({
          TERM_PROGRAM: undefined,
          TERM: undefined,
          COLORTERM: undefined,
          SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22',
        }),
        ciEnv: { ...noCi, GITHUB_ACTIONS: 'true' },
        stdinIsTTY: false,
        stdoutIsTTY: false,
        columns: undefined,
        rows: Number.NaN,
      },
      { launcher: false, parent: 'unknown', grandparent: 'unknown' },
      'na',
    )
    expect(out).toBe(
      'v1;in=0;out=0;tp=none;term=0;ct=0;sz=0x0;ci=1;ssh=1;l=0;p=unknown;g=unknown;osc=na',
    )
    expect(out).not.toContain('1.2.3.4')
  })
})
