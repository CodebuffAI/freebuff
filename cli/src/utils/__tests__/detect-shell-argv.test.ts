/**
 * `detect-shell` sets up a child process to ask who our parent is. It used to
 * build that as a command LINE and hand it to `execSync`, which runs a string
 * through a shell — so anything interpolated into it is shell syntax, not data.
 * `process.ppid` is a number today, so that was never exploitable; the reason to
 * pin it is that the shape invited the next edit to interpolate something that
 * is not a number.
 *
 * This runs the POSIX branch on every platform by overriding `process.platform`
 * for the duration of the test. That is deliberate: asserting only on Linux
 * would have made this a test that passes here by doing nothing, which is the
 * failure mode it exists to prevent.
 *
 * Probes run 2026-11-26, both against the change that introduced this file:
 *  (a) `execFileSync('ps', ['-p', String(process.ppid), '-o', 'comm='])`
 *      reverted to `execSync(\`ps -p ${process.ppid} -o comm=\`)` -> the
 *      "no command line" assertion red (execSync called once).
 *  (b) the ppid moved into the program name (`execFileSync('ps -p 1', [])`)
 *      -> the argv assertion red, so the check is watching the real element.
 */
import { mock } from 'bun:test'
import { afterAll, describe, expect, test } from 'bun:test'

const execFileCalls: Array<[unknown, unknown]> = []
const execSyncCalls: unknown[] = []

const realChildProcess = { ...(await import('node:child_process')) }

mock.module('child_process', () => ({
  ...realChildProcess,
  execFileSync: (...args: unknown[]) => {
    execFileCalls.push([args[0], args[1]])
    return Buffer.from('bash\n')
  },
  execSync: (...args: unknown[]) => {
    execSyncCalls.push(args[0])
    return Buffer.from('bash\n')
  },
}))

const realPlatform = process.platform
Object.defineProperty(process, 'platform', { value: 'linux' })

const { detectShell } = await import('../detect-shell')

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
  mock.restore()
})

describe('detect-shell parent inspection', () => {
  test('asks ps with an argument array, never a command line', () => {
    const shell = detectShell({ SHELL: undefined, COMSPEC: undefined } as never)

    expect(shell).toBe('bash')
    expect(execSyncCalls).toEqual([])
    expect(execFileCalls).toHaveLength(1)
    expect(execFileCalls[0]?.[0]).toBe('ps')
    expect(execFileCalls[0]?.[1]).toEqual([
      '-p',
      String(process.ppid),
      '-o',
      'comm=',
    ])
  })
})
