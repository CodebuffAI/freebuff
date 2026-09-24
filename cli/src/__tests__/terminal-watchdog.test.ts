import { spawn } from 'child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { TERMINAL_RESET_SEQUENCES } from '../utils/terminal-reset-sequences'
import { classifyTerminalWatchdogSpawnFailure } from '../utils/terminal-watchdog'
import { sanitizeWindowsCliVersion } from '../utils/windows-terminal-health'

import type { ChildProcess } from 'child_process'

const IS_WINDOWS = process.platform === 'win32'
const FIXTURE = join(import.meta.dir, 'helpers', 'terminal-watchdog-fixture.ts')
const tempDir = mkdtempSync(join(tmpdir(), 'terminal-watchdog-'))

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// Every fixture is spawned at once and killed at once, so these are one shared
// budget for the whole file instead of a per-test cost. Windows pays for two
// PowerShell hops (bootstrap + out-of-job watchdog) on a runner that is often
// busy scanning them, hence the wide margin there.
//
// Ready is longer than the fixture's own arm deadline on purpose, so the
// fixture is what reports a failure to arm (it names the marker it waited on);
// this is only the backstop for a fixture that never speaks at all.
const READY_TIMEOUT_MS = IS_WINDOWS ? 60_000 : 15_000
const WRITE_TIMEOUT_MS = IS_WINDOWS ? 45_000 : 15_000
const DISARM_TIMEOUT_MS = 10_000
// "close" waits on the stdio pipes as well as the exit; this bounds that wait.
const DRAIN_TIMEOUT_MS = 2_000
// Ceiling on the settle described in beforeAll, so one slow control write can't
// stretch the run.
const MAX_SETTLE_MS = 5_000
// Must exceed the sum of the waits above: a hook that times out takes the whole
// describe down as one "(unnamed)" failure and stops the rest of the file from
// running, which reads as deleted tests to scripts/ci/test-with-guard.ts.
const SETUP_TIMEOUT_MS = IS_WINDOWS ? 150_000 : 60_000

type Scenario = {
  key: string
  mode: 'hang' | 'clean' | 'spawn-failure' | 'reused-pid'
  env?: Record<string, string>
  /** "hang" fixtures wait to be SIGKILLed; the others exit on their own. */
  kill: boolean
  /** Whether an armed watchdog should write the reset payload after death. */
  expectWrite: boolean
}

const OPT_OUT_VALUES = ['1', 'true', 'TRUE']

// POSIX uses a detached sh blocking on pipe EOF. Windows uses a PowerShell
// grandchild (outside Bun's kill-on-close job object) blocking on its owner's
// process handle (identity-checked by creation time).
// Both then write the reset sequences to ttyPath.
const SCENARIOS: Scenario[] = [
  { key: 'unclean', mode: 'hang', kill: true, expectWrite: true },
  // The Windows arm path spawns a PowerShell bootstrap that Start-Process's a
  // second, longer-lived PowerShell — a shape EDR/AV scores as malicious. The
  // opt-out lets an affected user keep running the CLI at the cost of the
  // after-exit terminal repair, so "no watchdog at all" has to actually hold.
  ...OPT_OUT_VALUES.map((value): Scenario => ({
    key: `optout-${value}`,
    mode: 'hang',
    env: { CODEBUFF_NO_TERMINAL_WATCHDOG: value },
    kill: true,
    expectWrite: false,
  })),
  {
    key: 'optout-noise',
    mode: 'hang',
    env: { CODEBUFF_NO_TERMINAL_WATCHDOG: '0' },
    kill: true,
    expectWrite: true,
  },
  { key: 'clean', mode: 'clean', kill: false, expectWrite: false },
  // The PowerShell spawn-failure path only exists on Windows.
  ...(IS_WINDOWS
    ? [
        {
          key: 'spawn-failure',
          mode: 'spawn-failure' as const,
          kill: false,
          expectWrite: false,
        },
        // The pid-reuse leak: a watchdog armed after its owner died used to
        // wait on whichever process inherited the pid, for as long as that
        // process lived. It must now fire at once instead.
        {
          key: 'reused-pid',
          mode: 'reused-pid' as const,
          kill: false,
          expectWrite: true,
        },
      ]
    : []),
]

type Run = {
  scenario: Scenario
  child: ChildProcess
  pid: number | undefined
  ttyPath: string
  ready: boolean
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  /** Snapshotted once, after the barriers in beforeAll. */
  content: string
  disarmFiles: string[]
  readyPromise: Promise<void>
  closePromise: Promise<void>
}

function readTty(ttyPath: string): string {
  try {
    return readFileSync(ttyPath, 'utf8')
  } catch {
    return ''
  }
}

function listTmp(): string[] {
  try {
    return readdirSync(tmpdir())
  } catch {
    return []
  }
}

/**
 * Disarm files a fixture left in the temp dir (Windows watchdog only; POSIX
 * never creates one). Named codebuff-watchdog-disarm-<pid>-<random>.
 */
function findDisarmFiles(pid: number | undefined, names = listTmp()): string[] {
  return names.filter((name) =>
    name.startsWith(`codebuff-watchdog-disarm-${pid}-`),
  )
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return condition()
}

function startRun(scenario: Scenario, index: number): Run {
  // Indexed because the keys are not unique on a case-insensitive filesystem:
  // the "true" and "TRUE" opt-out variants would otherwise share one file (and
  // one `.armed` marker) now that every fixture runs at the same time.
  const ttyPath = join(tempDir, `${index}-${scenario.key}.out`)
  const childEnv = { ...process.env }
  delete childEnv.CODEBUFF_NO_TERMINAL_WATCHDOG
  const child = spawn(process.execPath, [FIXTURE, scenario.mode, ttyPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...childEnv, ...scenario.env },
  })

  const run: Run = {
    scenario,
    child,
    pid: child.pid,
    ttyPath,
    ready: false,
    stderr: '',
    exitCode: null,
    signal: null,
    content: '',
    disarmFiles: [],
    // Replaced below; the promise bodies need `run` to record into.
    readyPromise: Promise.resolve(),
    closePromise: Promise.resolve(),
  }

  child.stderr!.on('data', (chunk: Buffer) => {
    run.stderr += chunk.toString()
  })

  // Prefer "close" over "exit" so the fixture's stdout/stderr are fully
  // drained — a fixture that prints and exits immediately would otherwise lose
  // them. "close" additionally waits on the stdio pipes, though, so fall back
  // to "exit" on a timer: no watchdog inherits these pipes today (the POSIX one
  // gets the tty fd, the Windows bootstrap gets all-ignore), but a future one
  // that did would hang this hook, and a hung hook takes the describe with it.
  run.closePromise = new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      run.exitCode = code
      run.signal = signal
      const drain = setTimeout(resolve, DRAIN_TIMEOUT_MS)
      ;(drain as { unref?: () => void }).unref?.()
      child.on('close', () => {
        clearTimeout(drain)
        resolve()
      })
    })
    child.on('error', (error) => {
      run.stderr += `spawn error: ${error.message}\n`
      resolve()
    })
  })

  /** Resolves once the fixture prints "ready" (watchdog policy applied). */
  run.readyPromise = new Promise<void>((resolve) => {
    let out = ''
    const timer = setTimeout(resolve, READY_TIMEOUT_MS)
    ;(timer as { unref?: () => void }).unref?.()
    const finish = () => {
      clearTimeout(timer)
      resolve()
    }
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      if (out.includes('ready')) {
        run.ready = true
        finish()
      }
    })
    // "clean"/"spawn-failure" exit on their own; a fixture that died before
    // arming also lands here, with ready left false for the diagnostics dump.
    run.closePromise.then(finish)
  })

  return run
}

/**
 * Whether a run wrote what its scenario called for. "spawn-failure" is the one
 * scenario that legitimately writes something other than the reset payload (a
 * JSON failure report), so it is only checked for having said anything at all.
 */
function matchesExpectation(run: Run): boolean {
  if (run.scenario.expectWrite) return run.content === TERMINAL_RESET_SEQUENCES
  if (run.scenario.mode === 'spawn-failure') return run.content !== ''
  return run.content === '' && run.ready
}

function describeRun(run: Run): string {
  const content = run.content
  const shape =
    content === TERMINAL_RESET_SEQUENCES
      ? 'reset-sequences'
      : content === ''
        ? 'empty'
        : `${content.length} bytes: ${JSON.stringify(content.slice(0, 120))}`
  return [
    `  ${run.scenario.key}: ready=${run.ready} exit=${run.exitCode} signal=${run.signal}`,
    `    wrote: ${shape}`,
    `    disarm files: ${JSON.stringify(run.disarmFiles)}`,
    run.stderr.trim() ? `    stderr: ${run.stderr.trim()}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

let runs: Run[] = []
const runFor = (key: string): Run => {
  const run = runs.find((r) => r.scenario.key === key)
  if (!run) throw new Error(`no run recorded for scenario ${key}`)
  return run
}

describe('terminal watchdog', () => {
  test('bounds watchdog failure telemetry labels', () => {
    expect(
      classifyTerminalWatchdogSpawnFailure(
        Object.assign(new Error('private path'), { code: 'ENOENT' }),
      ),
    ).toBe('enoent')
    expect(
      classifyTerminalWatchdogSpawnFailure(new Error('private text')),
    ).toBe('unknown')
    expect(sanitizeWindowsCliVersion('0.0.142')).toBe('0.0.142')
    expect(sanitizeWindowsCliVersion('private/path')).toBe('unknown')
  })
})

// Each scenario needs a real process to arm a real watchdog and then die, so
// they all run at once and every test below asserts on the same snapshot:
// wall clock is one fixture's cost, not the sum. Nothing here throws — a wait
// that times out still snapshots, so the failing assertion names the scenario.
describe('terminal watchdog (fixture processes)', () => {
  beforeAll(async () => {
    runs = SCENARIOS.map(startRun)
    await Promise.all(runs.map((run) => run.readyPromise))

    const killedAt = Date.now()
    for (const run of runs) {
      if (run.scenario.kill) run.child.kill('SIGKILL')
    }
    await Promise.all(runs.map((run) => run.closePromise))

    // The scenarios that SHOULD write double as the clock for the ones that
    // should not: once an armed watchdog has fired, a watchdog that was never
    // armed has had at least as long to (incorrectly) fire. That beats a fixed
    // sleep in both directions — it can't pass for the wrong reason on a slow
    // runner, and it doesn't burn seconds on a fast one.
    const writers = runs.filter((run) => run.scenario.expectWrite)
    // A fixture that never printed "ready" never armed a watchdog (on Windows
    // it gives up on the arm marker and exits non-zero), so there is nothing
    // left to wait for — skip straight to the diagnostics rather than burning
    // the full write budget on a run that has already lost.
    if (writers.every((run) => run.ready)) {
      const wrote = await waitUntil(
        () =>
          writers.every(
            (run) => readTty(run.ttyPath) === TERMINAL_RESET_SEQUENCES,
          ),
        WRITE_TIMEOUT_MS,
      )
      // The control's write only proves the pipeline ran to the 50ms polling
      // granularity, and a wrongly-armed watchdog wakes on the same death but
      // need not win that race. Give it twice the latency the control just
      // demonstrated — self-scaling, unlike the fixed sleep this replaced.
      if (wrote) {
        const settle = Math.min(
          Math.max(250, 2 * (Date.now() - killedAt)),
          MAX_SETTLE_MS,
        )
        await new Promise((r) => setTimeout(r, settle))
      }
    }
    // Windows only: a disarmed watchdog deletes its disarm file when it wakes,
    // which is the strongest available proof that it woke and chose silence.
    await waitUntil(() => {
      const names = listTmp()
      return runs.every((run) => findDisarmFiles(run.pid, names).length === 0)
    }, DISARM_TIMEOUT_MS)

    const names = listTmp()
    for (const run of runs) {
      run.content = readTty(run.ttyPath)
      run.disarmFiles = findDisarmFiles(run.pid, names)
    }

    // A missing write is the historical flake here, and a spurious one is the
    // regression the opt-out scenarios exist to catch. Either way, dump every
    // fixture's state so the CI log says which hop failed instead of just
    // "expected reset sequences, got empty string".
    if (runs.some((run) => !matchesExpectation(run))) {
      console.error(
        `terminal watchdog fixtures did not behave as expected:\n${runs
          .map(describeRun)
          .join('\n')}`,
      )
    }
  }, SETUP_TIMEOUT_MS)

  test('writes reset sequences to the tty when the process dies uncleanly', () => {
    expect(runFor('unclean').ready).toBe(true)
    expect(runFor('unclean').content).toBe(TERMINAL_RESET_SEQUENCES)
  })

  test.each(OPT_OUT_VALUES)(
    'never arms when CODEBUFF_NO_TERMINAL_WATCHDOG=%s',
    (value) => {
      const run = runFor(`optout-${value}`)
      expect(run.ready).toBe(true)
      expect(run.content).toBe('')
      expect(run.disarmFiles).toEqual([])
    },
  )

  test('still arms when the opt-out is set to an unrelated value', () => {
    expect(runFor('optout-noise').ready).toBe(true)
    expect(runFor('optout-noise').content).toBe(TERMINAL_RESET_SEQUENCES)
  })

  test('stays silent when the process shuts down cleanly', () => {
    const run = runFor('clean')
    expect(run.exitCode).toBe(0)
    expect(run.content).toBe('')
    // The watchdog consumes (deletes) the disarm file when it wakes, so clean
    // exits must not litter the temp dir.
    expect(run.disarmFiles).toEqual([])
  })

  test.skipIf(!IS_WINDOWS)(
    'never waits on a process whose creation time is not its owner',
    () => {
      const run = runFor('reused-pid')
      // The fixture exits 0 only after seeing the reset while it was alive.
      expect(run.exitCode).toBe(0)
      expect(run.content).toBe(TERMINAL_RESET_SEQUENCES)
      expect(run.disarmFiles).toEqual([])
    },
  )

  test.skipIf(!IS_WINDOWS)(
    'reports a bounded failure when PowerShell cannot spawn',
    () => {
      const run = runFor('spawn-failure')
      expect(run.exitCode).toBe(0)
      expect(JSON.parse(run.content)).toEqual({
        stage: 'spawn',
        failureCode: 'enoent',
      })
      expect(run.disarmFiles).toEqual([])
    },
  )
})
