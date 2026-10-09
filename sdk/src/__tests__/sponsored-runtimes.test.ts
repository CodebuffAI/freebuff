import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'stream'

import {
  parseSponsoredRuntimeProbe,
  probeSponsoredRuntimes,
} from '../tools/sponsored-runtimes'

import type { TerminalCommandBroker } from '../tools/run-terminal-command'

function broker(
  stdout: string,
  exitCode: number | null = 0,
  options: { never?: boolean; ownsShell?: boolean; throws?: boolean } = {},
): TerminalCommandBroker & { started: number; killed: string[] } {
  const state = { started: 0, killed: [] as string[] }
  return {
    ...(options.ownsShell ? { ownsShell: true } : {}),
    get started() {
      return state.started
    },
    get killed() {
      return state.killed
    },
    start() {
      state.started += 1
      if (options.throws) throw new Error('cannot contain')
      const out = new PassThrough()
      const err = new PassThrough()
      out.end(stdout)
      err.end()
      return {
        stdout: out,
        stderr: err,
        completion: options.never
          ? new Promise<number | null>(() => {})
          : Promise.resolve(exitCode),
        kill: (signal) => {
          state.killed.push(signal)
        },
        isAlive: () => false,
      }
    },
  }
}

describe('parseSponsoredRuntimeProbe', () => {
  test('lists what ran, in the fixed order', () => {
    expect(
      parseSponsoredRuntimeProbe(
        'python\nnode\nnpx\n__freebuff_runtimes_done__\n',
      ),
    ).toEqual(['node', 'npx', 'python'])
  })

  test('nothing found is an empty list; a probe cut short is unknown', () => {
    expect(parseSponsoredRuntimeProbe('__freebuff_runtimes_done__')).toEqual([])
    expect(parseSponsoredRuntimeProbe('node\n')).toBeUndefined()
  })

  test('noise never becomes a runtime', () => {
    expect(
      parseSponsoredRuntimeProbe('nodejs\nv20.1.0\n__freebuff_runtimes_done__'),
    ).toEqual([])
  })
})

describe('probeSponsoredRuntimes', () => {
  const request = { cwd: '/work', env: { PATH: '/usr/bin' } }

  test("reads the broker's answer", async () => {
    expect(
      await probeSponsoredRuntimes(
        broker('node\nbun\n__freebuff_runtimes_done__\n'),
        request,
      ),
    ).toEqual(['node', 'bun'])
  })

  test('a failed start, a non-zero exit or a timeout is unknown, never []', async () => {
    expect(
      await probeSponsoredRuntimes(broker('', 0, { throws: true }), request),
    ).toBeUndefined()
    expect(
      await probeSponsoredRuntimes(
        broker('__freebuff_runtimes_done__', 1),
        request,
      ),
    ).toBeUndefined()
    const hung = broker('', 0, { never: true })
    expect(
      await probeSponsoredRuntimes(hung, { ...request, timeoutMs: 5 }),
    ).toBeUndefined()
    expect(hung.killed).toEqual(['SIGKILL'])
  })

  test('a broker with its own shell (the Windows floor) is not asked', async () => {
    const floor = broker('__freebuff_runtimes_done__', 0, { ownsShell: true })
    expect(await probeSponsoredRuntimes(floor, request)).toBeUndefined()
    expect(floor.started).toBe(0)
  })
})
