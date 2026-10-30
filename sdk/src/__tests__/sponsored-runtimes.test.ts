import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'

import {
  parseSponsoredRuntimeProbe,
  probeSponsoredRuntimes,
  SPONSORED_RUNTIME_PROBE_SCRIPT,
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

const testWithSystemPython = test.skipIf(!existsSync('/usr/bin/python3'))

function runRuntimeProbe(options: {
  uname: 'Darwin' | 'Linux'
  xcodeSelectPath?: string
  xcodeSelectStatus?: number
  hasDevPython?: boolean
}): string {
  const root = mkdtempSync(join(tmpdir(), 'sponsored-runtime-probe-'))
  const fakebin = join(root, 'fakebin')
  const devDir = join(root, 'developer')
  mkdirSync(fakebin)
  if (options.hasDevPython) {
    const devPython = join(devDir, 'usr/bin/python3')
    mkdirSync(join(devDir, 'usr/bin'), { recursive: true })
    writeFileSync(devPython, '#!/bin/sh\nexit 0\n')
    chmodSync(devPython, 0o755)
  }
  writeFileSync(
    fakebin + '/uname',
    `#!/bin/sh\nprintf '%s\\n' '${options.uname}'\n`,
  )
  writeFileSync(
    fakebin + '/xcode-select',
    '#!/bin/sh\nprintf "%s\\n" "$XCODE_SELECT_PATH"\nexit "$XCODE_SELECT_STATUS"\n',
  )
  chmodSync(fakebin + '/uname', 0o755)
  chmodSync(fakebin + '/xcode-select', 0o755)

  try {
    const result = Bun.spawnSync(
      ['/bin/sh', '-c', SPONSORED_RUNTIME_PROBE_SCRIPT],
      {
        env: {
          PATH: `${fakebin}:/usr/bin:/bin`,
          XCODE_SELECT_PATH: options.xcodeSelectPath ?? devDir,
          XCODE_SELECT_STATUS: String(options.xcodeSelectStatus ?? 0),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(result.exitCode).toBe(0)
    return result.stdout.toString()
  } finally {
    rmSync(root, { recursive: true, force: true })
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

describe('SPONSORED_RUNTIME_PROBE_SCRIPT Python detection', () => {
  testWithSystemPython(
    'skips the macOS shim when the developer Python is missing',
    () => {
      const output = runRuntimeProbe({ uname: 'Darwin' })
      expect(output).not.toContain('python\n')
      // Nothing python-shaped, not "nothing at all": this probe also reports
      // node/npx from the host, and asserting an empty list made the test
      // depend on what the machine happens to have in /usr/bin.
      expect(parseSponsoredRuntimeProbe(output)).not.toContain('python')
    },
  )

  testWithSystemPython(
    'uses the Python inside the selected developer directory',
    () => {
      const output = runRuntimeProbe({ uname: 'Darwin', hasDevPython: true })
      expect(parseSponsoredRuntimeProbe(output)).toContain('python')
    },
  )

  testWithSystemPython('skips the macOS shim when xcode-select fails', () => {
    const output = runRuntimeProbe({
      uname: 'Darwin',
      xcodeSelectStatus: 1,
    })
    expect(output).not.toContain('python\n')
    expect(parseSponsoredRuntimeProbe(output)).not.toContain('python')
  })

  testWithSystemPython(
    'keeps using /usr/bin/python3 on non-Darwin systems',
    () => {
      const output = runRuntimeProbe({ uname: 'Linux' })
      expect(parseSponsoredRuntimeProbe(output)).toContain('python')
    },
  )
})
