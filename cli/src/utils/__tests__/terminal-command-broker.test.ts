import { describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

import {
  getActiveTerminalCommandProcesses,
  runTerminalCommand,
} from '@codebuff/sdk'

import {
  classifyTerminalBrokerFailure,
  createTerminalCommandBroker,
  isTerminalCommandBrokerInvocation,
  protocolPathFromEnv,
} from '../terminal-command-broker'
import { sanitizeWindowsCliVersion } from '../windows-terminal-health'

const brokerFixture = path.join(
  import.meta.dir,
  'fixtures',
  'terminal-command-broker-entry.ts',
)
const brokerOwnerFixture = path.join(
  import.meta.dir,
  'fixtures',
  'terminal-command-broker-owner.ts',
)
const brokerChildFixture = path.join(
  import.meta.dir,
  'fixtures',
  'terminal-command-broker-child.ts',
)

function isProcessRunning(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const commandEnd = stat.lastIndexOf(')')
      if (commandEnd !== -1 && stat[commandEnd + 2] === 'Z') return false
    } catch {
      // The process may have disappeared between checks.
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await Bun.sleep(25)
  return condition()
}

function createTestBroker() {
  return createTerminalCommandBroker({
    invocation: () => ({
      executable: process.execPath,
      args: [brokerFixture],
    }),
  })
}

function protocolFilesForThisProcess(): Set<string> {
  const prefix = `freebuff-terminal-command-broker-${process.pid}-`
  return new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)),
  )
}

function stdoutOf(
  result: Awaited<ReturnType<typeof runTerminalCommand>>,
): string {
  const value = result[0].value
  return 'stdout' in value && typeof value.stdout === 'string'
    ? value.stdout
    : ''
}

describe('terminal command broker', () => {
  test('normalizes failures without retaining exception text', () => {
    expect(classifyTerminalBrokerFailure(new Error('Failed to connect'))).toBe(
      'failed_to_connect',
    )
    expect(
      classifyTerminalBrokerFailure(
        Object.assign(new Error('private path must not be retained'), {
          code: 'ENOENT',
        }),
      ),
    ).toBe('enoent')
    expect(classifyTerminalBrokerFailure(new Error('private details'))).toBe(
      'unknown',
    )
    expect(
      classifyTerminalBrokerFailure(
        new Error('terminal command broker protocol response was missing'),
      ),
    ).toBe('protocol_missing')
    expect(
      classifyTerminalBrokerFailure(
        new Error(
          'terminal command broker protocol response was missing\nBroker stderr: [freebuff-broker] protocol write failed: ENOSPC',
        ),
      ),
    ).toBe('protocol_write_failed')
    expect(sanitizeWindowsCliVersion('0.0.142')).toBe('0.0.142')
    expect(sanitizeWindowsCliVersion('private path/and details')).toBe(
      'unknown',
    )
  })

  test('requires its private environment marker and flag before --', () => {
    expect(
      isTerminalCommandBrokerInvocation(
        ['freebuff', '--terminal-command-broker'],
        { CODEBUFF_TERMINAL_COMMAND_BROKER: '1' },
      ),
    ).toBe(true)
    expect(
      isTerminalCommandBrokerInvocation(
        ['freebuff', '--', '--terminal-command-broker'],
        { CODEBUFF_TERMINAL_COMMAND_BROKER: '1' },
      ),
    ).toBe(false)
    expect(
      isTerminalCommandBrokerInvocation(
        ['freebuff', '--terminal-command-broker'],
        {},
      ),
    ).toBe(false)
    expect(
      isTerminalCommandBrokerInvocation(['freebuff'], {
        CODEBUFF_TERMINAL_COMMAND_BROKER: '1',
      }),
    ).toBe(false)
  })

  test('accepts protocol files only at the constrained temp path', () => {
    const validPath = path.join(
      tmpdir(),
      `freebuff-terminal-command-broker-${process.pid}-${crypto.randomUUID()}.json`,
    )
    expect(
      protocolPathFromEnv({
        CODEBUFF_TERMINAL_COMMAND_BROKER_PROTOCOL: validPath,
      }),
    ).toBe(validPath)
    expect(() =>
      protocolPathFromEnv({
        CODEBUFF_TERMINAL_COMMAND_BROKER_PROTOCOL: path.join(
          tmpdir(),
          'wrong-prefix.json',
        ),
      }),
    ).toThrow('terminal command broker protocol path was invalid')
    expect(() =>
      protocolPathFromEnv({
        CODEBUFF_TERMINAL_COMMAND_BROKER_PROTOCOL: path.join(
          tmpdir(),
          'nested',
          path.basename(validPath),
        ),
      }),
    ).toThrow('terminal command broker protocol path was invalid')
  })

  test('relays stdout, stderr, and the command exit code', async () => {
    const [{ value }] = await runTerminalCommand({
      command: `printf 'OUT'; printf 'ERR' >&2; exit 7`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      timeout_seconds: 10,
      terminalCommandBroker: createTestBroker(),
    })

    expect('stdout' in value ? value.stdout : '').toBe('OUT')
    expect('stderr' in value ? value.stderr : '').toBe('ERR')
    expect('exitCode' in value ? value.exitCode : null).toBe(7)
  })

  test('runs commands through the production development entrypoint', async () => {
    const result = await runTerminalCommand({
      command: `printf 'DEFAULT_ENTRYPOINT_OK'`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      timeout_seconds: 10,
      terminalCommandBroker: createTerminalCommandBroker(),
    })

    expect(stdoutOf(result)).toBe('DEFAULT_ENTRYPOINT_OK')
  })

  test('removes the one-shot protocol file after completion', async () => {
    const before = protocolFilesForThisProcess()

    const result = await runTerminalCommand({
      command: `printf 'NO_PROTOCOL_LEAK'`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      timeout_seconds: 10,
      terminalCommandBroker: createTestBroker(),
    })

    expect(stdoutOf(result)).toBe('NO_PROTOCOL_LEAK')
    expect(protocolFilesForThisProcess()).toEqual(before)
  })

  test('isolates overlapping commands so one cancellation does not affect the other', async () => {
    const failures: Array<{ stage: string; failureCode: string }> = []
    const existing = new Set(
      getActiveTerminalCommandProcesses().map(({ pid }) => pid),
    )
    const firstAbort = new AbortController()
    const broker = createTerminalCommandBroker({
      invocation: () => ({
        executable: process.execPath,
        args: [brokerFixture],
      }),
      reportFailure: (failure) => failures.push(failure),
    })
    const first = runTerminalCommand({
      command: `printf 'FIRST_STARTED'; while :; do sleep 1; done`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      timeout_seconds: 30,
      signal: firstAbort.signal,
      terminalCommandBroker: broker,
    })
    const second = runTerminalCommand({
      command: `sleep 1; printf 'SECOND_DONE'`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      timeout_seconds: 10,
      terminalCommandBroker: broker,
    })

    expect(
      getActiveTerminalCommandProcesses().filter(
        ({ pid }) => !existing.has(pid),
      ),
    ).toHaveLength(2)
    firstAbort.abort()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult[0].value).toMatchObject({
      message: expect.stringContaining('aborted by the user'),
    })
    expect(stdoutOf(secondResult)).toBe('SECOND_DONE')
    expect(failures).toEqual([])
  })

  test('surfaces helper startup failures instead of falling back to the console', async () => {
    const failures: Array<{ stage: string; failureCode: string }> = []
    const broker = createTerminalCommandBroker({
      invocation: () => {
        throw new Error('helper executable is unavailable')
      },
      reportFailure: (failure) => failures.push(failure),
    })

    await expect(
      runTerminalCommand({
        command: `printf 'must not run'`,
        process_type: 'SYNC',
        cwd: process.cwd(),
        timeout_seconds: 10,
        terminalCommandBroker: broker,
      }),
    ).rejects.toThrow(
      'Failed to start terminal command broker: helper executable is unavailable\n\nRestart Freebuff and try again.',
    )
    expect(failures).toEqual([{ stage: 'spawn', failureCode: 'unknown' }])
  })

  test('contains an asynchronous spawn error when the helper is missing', async () => {
    const failures: Array<{ stage: string; failureCode: string }> = []
    const broker = createTerminalCommandBroker({
      invocation: () => ({
        executable: path.join(
          tmpdir(),
          `missing-freebuff-broker-${crypto.randomUUID()}`,
        ),
        args: [],
      }),
      reportFailure: (failure) => failures.push(failure),
    })

    await expect(
      runTerminalCommand({
        command: `printf 'must not run'`,
        process_type: 'SYNC',
        cwd: process.cwd(),
        timeout_seconds: 10,
        terminalCommandBroker: broker,
      }),
    ).rejects.toThrow('Terminal command broker failed:')

    // Bun reports this asynchronously after spawn() returns a child handle.
    await Bun.sleep(0)
    expect(failures).toEqual([{ stage: 'completion', failureCode: 'enoent' }])
  })

  test('adds recovery guidance when spawning the helper throws', async () => {
    const broker = createTerminalCommandBroker({
      invocation: () => ({ executable: '\0', args: [] }),
    })

    await expect(
      runTerminalCommand({
        command: `printf 'must not run'`,
        process_type: 'SYNC',
        cwd: process.cwd(),
        timeout_seconds: 10,
        terminalCommandBroker: broker,
      }),
    ).rejects.toThrow('Restart Freebuff and try again.')
  })

  test('adds recovery guidance when the helper exits before responding', async () => {
    const failures: Array<{ stage: string; failureCode: string }> = []
    const broker = createTerminalCommandBroker({
      invocation: () => ({
        executable: process.execPath,
        args: [
          path.join(
            tmpdir(),
            `missing-freebuff-entry-${crypto.randomUUID()}.ts`,
          ),
        ],
      }),
      reportFailure: (failure) => failures.push(failure),
    })

    let failureMessage = ''
    try {
      await runTerminalCommand({
        command: `printf 'must not run'`,
        process_type: 'SYNC',
        cwd: process.cwd(),
        timeout_seconds: 10,
        terminalCommandBroker: broker,
      })
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error)
    }

    expect(failureMessage).toContain('Terminal command broker failed:')
    expect(failureMessage).toContain('Restart Freebuff and try again.')
    expect(failures).toEqual([
      { stage: 'completion', failureCode: 'protocol_missing' },
    ])
  })

  test('explains a missing protocol response with the broker stderr reason', async () => {
    if (process.platform === 'win32') return
    const failures: Array<{ stage: string; failureCode: string }> = []
    const broker = createTerminalCommandBroker({
      invocation: () => ({
        executable: '/bin/sh',
        args: [
          '-c',
          'echo "[freebuff-broker] protocol write failed: ENOSPC" >&2; exit 1',
        ],
      }),
      reportFailure: (failure) => failures.push(failure),
    })

    let failureMessage = ''
    try {
      await runTerminalCommand({
        command: `printf 'must not run'`,
        process_type: 'SYNC',
        cwd: process.cwd(),
        timeout_seconds: 10,
        terminalCommandBroker: broker,
      })
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error)
    }

    expect(failureMessage).toContain('protocol response was missing')
    expect(failureMessage).toContain(
      '[freebuff-broker] protocol write failed: ENOSPC',
    )
    expect(failures).toEqual([
      { stage: 'completion', failureCode: 'protocol_write_failed' },
    ])
  })

  test('tolerates a protocol file written just after the helper exits', async () => {
    if (process.platform === 'win32') return
    const broker = createTerminalCommandBroker({
      invocation: () => ({
        executable: '/bin/sh',
        args: [
          '-c',
          `(sleep 0.04; printf '%s\\n' '{"ok":true,"exitCode":0}' > "$CODEBUFF_TERMINAL_COMMAND_BROKER_PROTOCOL") & exit 0`,
        ],
      }),
    })

    const result = await runTerminalCommand({
      command: `printf 'must not run'`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      timeout_seconds: 10,
      terminalCommandBroker: broker,
    })

    expect(result[0].value).toMatchObject({ exitCode: 0 })
  })

  test('does not add broker recovery guidance to a command spawn failure', async () => {
    const missingCwd = path.join(
      tmpdir(),
      `missing-freebuff-cwd-${crypto.randomUUID()}`,
    )

    let failureMessage = ''
    try {
      await runTerminalCommand({
        command: `printf 'must not run'`,
        process_type: 'SYNC',
        cwd: missingCwd,
        timeout_seconds: 10,
        terminalCommandBroker: createTestBroker(),
      })
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error)
    }

    expect(failureMessage).toContain('ENOENT')
    expect(failureMessage).not.toContain('Restart Freebuff and try again.')
  })

  test('kills the broker process group after a timeout', async () => {
    if (process.platform === 'win32') return
    const protocolFilesBefore = protocolFilesForThisProcess()
    const existing = new Set(
      getActiveTerminalCommandProcesses().map(({ pid }) => pid),
    )
    const run = runTerminalCommand({
      command: `bash -c 'trap "" TERM; while :; do sleep 1; done'`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      timeout_seconds: 0.05,
      terminalCommandBroker: createTestBroker(),
    })
    const tracked = getActiveTerminalCommandProcesses().find(
      ({ pid }) => !existing.has(pid),
    )
    expect(tracked).toBeDefined()

    await expect(run).rejects.toThrow('Command timed out')
    const deadline = Date.now() + 3_000
    while (
      Date.now() < deadline &&
      getActiveTerminalCommandProcesses().some(
        ({ pid }) => pid === tracked!.pid,
      )
    ) {
      await Bun.sleep(25)
    }
    expect(
      getActiveTerminalCommandProcesses().some(
        ({ pid }) => pid === tracked!.pid,
      ),
    ).toBe(false)
    expect(() => process.kill(-tracked!.pid, 0)).toThrow()
    expect(protocolFilesForThisProcess()).toEqual(protocolFilesBefore)
  })

  test('leaves no live background descendants after successful completion', async () => {
    if (process.platform === 'win32') return
    const tempDir = mkdtempSync(path.join(tmpdir(), 'codebuff-broker-child-'))
    const pidFile = path.join(tempDir, 'child.pid')
    try {
      await runTerminalCommand({
        command: `sleep 30 >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}`,
        process_type: 'SYNC',
        cwd: process.cwd(),
        timeout_seconds: 10,
        terminalCommandBroker: createTestBroker(),
      })

      const childPid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(Number.isInteger(childPid)).toBe(true)
      expect(await waitFor(() => !isProcessRunning(childPid), 3_000)).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('normal completion does not terminate the broker from the parent process', async () => {
    let parentTerminations = 0
    const broker = createTerminalCommandBroker({
      invocation: () => ({
        executable: process.execPath,
        args: [brokerFixture],
      }),
      terminate: (child, signal) => {
        parentTerminations++
        child.kill(signal)
      },
    })

    const result = await runTerminalCommand({
      command: `printf 'self-reaped'`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      timeout_seconds: 10,
      terminalCommandBroker: broker,
    })

    expect(stdoutOf(result)).toBe('self-reaped')
    expect(parentTerminations).toBe(0)
  })

  test('reaps its command when the owning CLI process disappears', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'codebuff-broker-owner-'))
    const brokerPidPath = path.join(tempDir, 'broker.pid')
    const commandPidPath = path.join(tempDir, 'command.pid')
    const owner = spawn(
      process.execPath,
      [
        brokerOwnerFixture,
        brokerFixture,
        brokerChildFixture,
        brokerPidPath,
        commandPidPath,
      ],
      { stdio: 'ignore' },
    )
    const ownerClosed = new Promise<void>((resolve) =>
      owner.once('close', () => resolve()),
    )
    let brokerPid: number | undefined
    let commandPid: number | undefined

    try {
      expect(
        await waitFor(
          () => existsSync(brokerPidPath) && existsSync(commandPidPath),
          5_000,
        ),
      ).toBe(true)
      brokerPid = Number(readFileSync(brokerPidPath, 'utf8'))
      commandPid = Number(readFileSync(commandPidPath, 'utf8'))
      expect(isProcessRunning(brokerPid)).toBe(true)
      expect(isProcessRunning(commandPid)).toBe(true)

      owner.kill('SIGKILL')
      await ownerClosed

      expect(
        await waitFor(
          () => !isProcessRunning(brokerPid!) && !isProcessRunning(commandPid!),
          4_000,
        ),
      ).toBe(true)
    } finally {
      try {
        owner.kill('SIGKILL')
      } catch {}
      if (brokerPid && isProcessRunning(brokerPid)) {
        if (process.platform === 'win32') {
          spawnSync('taskkill.exe', ['/pid', String(brokerPid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true,
          })
        } else {
          try {
            process.kill(-brokerPid, 'SIGKILL')
          } catch {}
        }
      }
      if (commandPid && isProcessRunning(commandPid)) {
        try {
          process.kill(commandPid, 'SIGKILL')
        } catch {}
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 15_000)
})
