import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { PassThrough } from 'stream'

import {
  BoundedOutputBuffer,
  getActiveTerminalCommandProcesses,
  rewriteWindowsNulRedirects,
  runTerminalCommand,
} from '../tools/run-terminal-command'

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
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return condition()
}

describe('rewriteWindowsNulRedirects', () => {
  test('rewrites cmd-style nul redirects to /dev/null', () => {
    expect(rewriteWindowsNulRedirects('tsc --noEmit > nul 2>&1')).toBe(
      'tsc --noEmit > /dev/null 2>&1',
    )
    expect(rewriteWindowsNulRedirects('npm test >nul 2>nul')).toBe(
      'npm test >/dev/null 2>/dev/null',
    )
    expect(rewriteWindowsNulRedirects('some-tool >> NUL')).toBe(
      'some-tool >> /dev/null',
    )
    expect(rewriteWindowsNulRedirects('ssh host cmd < nul')).toBe(
      'ssh host cmd < /dev/null',
    )
  })

  test('leaves nul-like filenames and non-redirect uses alone', () => {
    expect(rewriteWindowsNulRedirects('cat nul.txt > out.log')).toBe(
      'cat nul.txt > out.log',
    )
    expect(rewriteWindowsNulRedirects('echo nul')).toBe('echo nul')
    expect(rewriteWindowsNulRedirects('grep foo > nullable.ts')).toBe(
      'grep foo > nullable.ts',
    )
  })
})

describe('BoundedOutputBuffer', () => {
  test('preserves output below the limit and strips terminal colors', () => {
    const output = new BoundedOutputBuffer(100)
    output.append('\u001b[31')
    output.append('mhello\u001b[0m world')

    expect(output.format()).toBe('hello world')
  })

  test('keeps a bounded prefix and suffix for oversized output', () => {
    const output = new BoundedOutputBuffer(100)
    output.append('start-' + 'x'.repeat(200) + '-end')

    expect(output.retainedLength).toBeLessThanOrEqual(100)
    expect(output.format()).toHaveLength(100)
    expect(output.format()).toStartWith('start-')
    expect(output.format()).toContain('[...TRUNCATED DUE TO LENGTH...]')
    expect(output.format()).toEndWith('-end')
  })

  test('applies the output limit after removing color sequences', () => {
    const output = new BoundedOutputBuffer(100)
    output.append(`start-${'\u001b[31mx\u001b[0m'.repeat(200)}-end`)

    expect(output.format()).toHaveLength(100)
    expect(output.format()).toStartWith('start-')
    expect(output.format()).toEndWith('-end')
    expect(output.format()).not.toContain('\u001b[')
  })

  test('does not grow as more chunks arrive after truncation', () => {
    const output = new BoundedOutputBuffer(100)

    for (let i = 0; i < 1_000; i++) {
      output.append(`chunk-${i.toString().padStart(4, '0')}`)
    }

    expect(output.retainedLength).toBeLessThanOrEqual(100)
    expect(output.format()).toStartWith('chunk-0000')
    expect(output.format()).toEndWith('chunk-0999')
  })
})

describe('terminal command process diagnostics', () => {
  test('does not run when the terminal command broker cannot start', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'codebuff-broker-failure-'))
    const marker = join(tempDir, 'spawned')

    try {
      await expect(
        runTerminalCommand({
          command: `printf spawned > ${JSON.stringify(marker)}`,
          process_type: 'SYNC',
          cwd: process.cwd(),
          timeout_seconds: 5,
          terminalCommandBroker: {
            start: () => {
              throw new Error('broker unavailable')
            },
          },
        }),
      ).rejects.toThrow(
        'Failed to start terminal command broker: broker unavailable',
      )

      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('uses broker output and completion without spawning directly', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let requestedExecutable = ''
    const resultPromise = runTerminalCommand({
      command: `printf 'brokered'`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      timeout_seconds: 5,
      terminalCommandBroker: {
        start: (request) => {
          requestedExecutable = request.executable
          queueMicrotask(() => {
            stdout.end('brokered')
            stderr.end()
          })
          return {
            pid: 999_999,
            stdout,
            stderr,
            completion: Promise.resolve(0),
            kill: () => {},
            isAlive: () => false,
          }
        },
      },
    })

    const [{ value }] = await resultPromise
    expect(['bash', 'bash.exe']).toContain(
      basename(requestedExecutable).toLowerCase(),
    )
    expect('stdout' in value ? value.stdout : '').toBe('brokered')
    expect('exitCode' in value ? value.exitCode : null).toBe(0)
  })

  test('a broker that owns its shell gets the command text, with no bash lookup or rewrite', async () => {
    // The sponsored Windows floor runs PowerShell (COD-642). It must be handed
    // the command as written -- not a bash invocation, and not with a
    // cmd-style `> nul` rewritten to a `/dev/null` PowerShell cannot open.
    const requests: Array<Record<string, unknown>> = []
    const [{ value }] = await runTerminalCommand({
      command: 'Write-Output brokered > nul',
      process_type: 'SYNC',
      cwd: process.cwd(),
      timeout_seconds: 5,
      terminalCommandBroker: {
        ownsShell: true,
        start: (request) => {
          requests.push({ ...request })
          const stdout = new PassThrough()
          const stderr = new PassThrough()
          queueMicrotask(() => {
            stdout.end('brokered')
            stderr.end()
          })
          return {
            pid: 999_998,
            stdout,
            stderr,
            completion: Promise.resolve(0),
            kill: () => {},
            isAlive: () => false,
          }
        },
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.command).toBe('Write-Output brokered > nul')
    expect(requests[0]!.executable).toBe('')
    expect(requests[0]!.args).toEqual([])
    expect('stdout' in value ? value.stdout : '').toBe('brokered')
  })

  test('a broker that does not own its shell gets the bash request, unchanged', async () => {
    const requests: Array<Record<string, unknown>> = []
    await runTerminalCommand({
      command: `printf 'x'`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      timeout_seconds: 5,
      terminalCommandBroker: {
        start: (request) => {
          requests.push({ ...request })
          const stdout = new PassThrough()
          const stderr = new PassThrough()
          queueMicrotask(() => {
            stdout.end()
            stderr.end()
          })
          return {
            pid: 999_997,
            stdout,
            stderr,
            completion: Promise.resolve(0),
            kill: () => {},
            isAlive: () => false,
          }
        },
      },
    })
    expect('command' in requests[0]!).toBe(false)
    expect(requests[0]!.args).toEqual(['-c', `printf 'x'`])
  })

  test('bounds direct cleanup while reaping a stubborn background descendant', async () => {
    if (process.platform === 'win32') return

    const tempDir = mkdtempSync(join(tmpdir(), 'codebuff-direct-cleanup-'))
    const pidFile = join(tempDir, 'descendant.pid')
    const readyFile = join(tempDir, 'descendant.ready')
    const fixture = join(
      import.meta.dir,
      'fixtures',
      'posix-stubborn-descendant.ts',
    )
    let descendantPid: number | undefined
    try {
      const completed = runTerminalCommand({
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} ${JSON.stringify(pidFile)} ${JSON.stringify(readyFile)} >/dev/null 2>&1 & while [ ! -f ${JSON.stringify(readyFile)} ]; do sleep 0.01; done`,
        process_type: 'SYNC',
        cwd: process.cwd(),
        timeout_seconds: -1,
      })
      let deadline: ReturnType<typeof setTimeout> | undefined
      const result = await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(new Error('direct process-group cleanup was unbounded')),
            5_000,
          )
        }),
      ]).finally(() => clearTimeout(deadline))

      descendantPid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(Number.isInteger(descendantPid)).toBe(true)
      expect(result[0].value).toMatchObject({ exitCode: 0 })
      expect(
        await waitFor(() => !isProcessRunning(descendantPid!), 3_000),
      ).toBe(true)
    } finally {
      if (descendantPid && isProcessRunning(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {}
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 10_000)

  test('stops tracking a cancelled process after bounded forced cleanup', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const controller = new AbortController()
    const pid = 987_654_321
    const signals: NodeJS.Signals[] = []
    const run = runTerminalCommand({
      command: `printf 'never exits'`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      timeout_seconds: -1,
      signal: controller.signal,
      terminalCommandBroker: {
        start: () => ({
          pid,
          stdout,
          stderr,
          completion: new Promise(() => {}),
          kill: (signal) => signals.push(signal),
          isAlive: () => true,
        }),
      },
    })

    controller.abort()
    await run
    expect(
      getActiveTerminalCommandProcesses().some((child) => child.pid === pid),
    ).toBe(true)
    expect(
      await waitFor(
        () =>
          !getActiveTerminalCommandProcesses().some(
            (child) => child.pid === pid,
          ),
        4_000,
      ),
    ).toBe(true)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  }, 6_000)

  test('cancelled-process observation does not keep the host alive', () => {
    const fixture = join(
      import.meta.dir,
      'fixtures',
      'cancelled-command-does-not-keep-alive.ts',
    )
    const child = spawnSync(process.execPath, [fixture], {
      encoding: 'utf8',
      timeout: 5_000,
    })

    expect(child.status).toBe(0)
    const observationStartedAt = Number(child.stdout.trim())
    expect(Number.isFinite(observationStartedAt)).toBe(true)
    expect(Date.now() - observationStartedAt).toBeLessThan(2_400)
  }, 6_000)

  test('tracks a command until its process exits', async () => {
    const existingPids = new Set(
      getActiveTerminalCommandProcesses().map((child) => child.pid),
    )
    const controller = new AbortController()
    const run = runTerminalCommand({
      command: `bun -e "setInterval(() => {}, 1000)"`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      timeout_seconds: 30,
      signal: controller.signal,
    })

    const active = getActiveTerminalCommandProcesses()
    const tracked = active.find((child) => !existingPids.has(child.pid))
    expect(tracked).toBeDefined()
    const pid = tracked!.pid
    if (process.platform !== 'win32') {
      expect(tracked!.processGroupId).toBe(pid)
    }

    controller.abort()
    await run
    for (let i = 0; i < 20; i++) {
      if (
        !getActiveTerminalCommandProcesses().some((child) => child.pid === pid)
      ) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(
      getActiveTerminalCommandProcesses().some((child) => child.pid === pid),
    ).toBe(false)
  })

  test('escalates when a grandchild ignores SIGTERM', async () => {
    if (process.platform === 'win32') return

    const existingPids = new Set(
      getActiveTerminalCommandProcesses().map((child) => child.pid),
    )
    const controller = new AbortController()
    const run = runTerminalCommand({
      command: `bash -c 'trap "" TERM; while :; do sleep 1; done'`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      timeout_seconds: 30,
      signal: controller.signal,
    })
    const tracked = getActiveTerminalCommandProcesses().find(
      (child) => !existingPids.has(child.pid),
    )
    expect(tracked).toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    await run
    expect(
      getActiveTerminalCommandProcesses().some(
        (child) => child.pid === tracked!.pid,
      ),
    ).toBe(true)

    const processGroupIsAlive = () => {
      try {
        process.kill(-tracked!.pid, 0)
        return true
      } catch {
        return false
      }
    }
    const deadline = Date.now() + 3_000
    while (
      Date.now() < deadline &&
      (getActiveTerminalCommandProcesses().some(
        (child) => child.pid === tracked!.pid,
      ) ||
        processGroupIsAlive())
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(
      getActiveTerminalCommandProcesses().some(
        (child) => child.pid === tracked!.pid,
      ),
    ).toBe(false)
    expect(processGroupIsAlive()).toBe(false)
  })

  test('cancels a detached Windows grandchild with its terminal-tool tree', async () => {
    if (process.platform !== 'win32') return

    const tempDir = mkdtempSync(join(tmpdir(), 'codebuff-process-tree-'))
    const pidFile = join(tempDir, 'grandchild.pid')
    const fixture = join(
      import.meta.dir,
      'fixtures',
      'windows-stubborn-grandchild.ts',
    )
    const bashPath = (value: string) => value.replaceAll('\\', '/')
    const isAlive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const controller = new AbortController()
    let parentPid: number | undefined
    let grandchildPid: number | undefined

    try {
      const existingPids = new Set(
        getActiveTerminalCommandProcesses().map((child) => child.pid),
      )
      const run = runTerminalCommand({
        command: `bun ${JSON.stringify(bashPath(fixture))} ${JSON.stringify(bashPath(pidFile))}`,
        process_type: 'SYNC',
        cwd: process.cwd(),
        timeout_seconds: 30,
        signal: controller.signal,
      })
      const shellPid = getActiveTerminalCommandProcesses().find(
        (child) => !existingPids.has(child.pid),
      )?.pid
      expect(shellPid).toBeDefined()

      const readyDeadline = Date.now() + 5_000
      while (!existsSync(pidFile) && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(existsSync(pidFile)).toBe(true)
      const fixturePids = JSON.parse(readFileSync(pidFile, 'utf8')) as {
        parentPid: number
        grandchildPid: number
      }
      parentPid = fixturePids.parentPid
      grandchildPid = fixturePids.grandchildPid
      expect(Number.isInteger(parentPid)).toBe(true)
      expect(Number.isInteger(grandchildPid)).toBe(true)
      // The fixture's detached grandchild would outlive a direct kill of the
      // shell parent. Windows tree cancellation must remove all three PIDs.
      expect(() => process.kill(shellPid!, 0)).not.toThrow()
      expect(() => process.kill(parentPid!, 0)).not.toThrow()
      expect(() => process.kill(grandchildPid!, 0)).not.toThrow()

      controller.abort()
      await run

      const stoppedDeadline = Date.now() + 5_000
      while (
        Date.now() < stoppedDeadline &&
        (isAlive(shellPid!) || isAlive(parentPid!) || isAlive(grandchildPid!))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(() => process.kill(shellPid!, 0)).toThrow()
      expect(() => process.kill(parentPid!, 0)).toThrow()
      expect(() => process.kill(grandchildPid!, 0)).toThrow()
    } finally {
      controller.abort()
      if (parentPid) {
        spawnSync('taskkill.exe', ['/pid', String(parentPid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      }
      if (grandchildPid) {
        spawnSync('taskkill.exe', ['/pid', String(grandchildPid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 25_000)
})
