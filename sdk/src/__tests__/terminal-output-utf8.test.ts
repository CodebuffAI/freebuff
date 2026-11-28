import { expect, it } from 'bun:test'
import { readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { PassThrough } from 'stream'
import { finished } from 'stream/promises'

import { runTerminalCommand } from '../tools/run-terminal-command'

import type { TerminalCommandBroker } from '../tools/run-terminal-command'

// Use real streams to split multibyte characters without depending on pipe timing.
it('preserves split UTF-8 in foreground output and brokered background logs', async () => {
  const collected: { stdout: string; stderr: string }[] = []
  for (const process_type of ['SYNC', 'BACKGROUND'] as const) {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const brokerChunks: unknown[] = []
    stdout.on('data', (chunk) => brokerChunks.push(chunk))
    let finish!: (code: number) => void
    let logDirectory: string | undefined
    const terminalCommandBroker: TerminalCommandBroker = {
      ownsShell: true,
      start: () => ({
        pid: 987_654_320,
        stdout,
        stderr,
        completion: new Promise((resolve) => {
          finish = resolve
        }),
        kill: () => {},
        isAlive: () => false,
      }),
    }
    const run = runTerminalCommand({
      command: 'UTF-8 stream fixture',
      process_type,
      cwd: process.cwd(),
      timeout_seconds: 5,
      terminalCommandBroker,
    })
    try {
      // Keep stdout/stderr decoder state independent; leave ANSI codes intact.
      const output = Buffer.from('Aé中🙂Z')
      const error = Buffer.from('ß错🚀')
      stdout.write('\x1b[31m')
      for (
        let index = 0;
        index < Math.max(output.length, error.length);
        index++
      ) {
        if (index < output.length)
          stdout.write(output.subarray(index, index + 1))
        if (index < error.length) stderr.write(error.subarray(index, index + 1))
      }
      stdout.write('\x1b[0m')
      stdout.end(Buffer.from([0xe4]))
      stderr.end(Buffer.from([0xf0]))
      await Promise.all([finished(stdout), finished(stderr)])
      finish(0)
      const [{ value }] = await run
      if ('stdoutPath' in value && value.stdoutPath && value.stderrPath) {
        logDirectory = path.dirname(value.stdoutPath)
        collected.push({
          stdout: readFileSync(value.stdoutPath, 'utf8'),
          stderr: readFileSync(value.stderrPath, 'utf8'),
        })
      } else if ('stdout' in value) {
        collected.push({
          stdout: value.stdout ?? '',
          stderr: value.stderr ?? '',
        })
      }
      expect(brokerChunks.every(Buffer.isBuffer)).toBe(true)
    } finally {
      finish(0)
      await run
      stdout.destroy()
      stderr.destroy()
      if (logDirectory) {
        if (
          path.dirname(logDirectory) !== path.resolve(tmpdir()) ||
          !path.basename(logDirectory).startsWith('codebuff-process-')
        ) {
          throw new Error('Unexpected background log directory')
        }
        rmSync(logDirectory, { recursive: true, force: true })
      }
    }
  }
  // An incomplete sequence at EOF still produces the usual replacement character.
  expect(collected).toEqual([
    { stdout: 'Aé中🙂Z�', stderr: 'ß错🚀�' },
    { stdout: 'Aé中🙂Z�', stderr: 'ß错🚀�' },
  ])
})
