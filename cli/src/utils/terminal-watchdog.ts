/**
 * Sacrificial watchdog process that resets the terminal if the CLI dies
 * without running its own cleanup (SIGKILL, native crash, group kill).
 *
 * The in-process handlers (renderer-cleanup.ts) cover catchable exits, and
 * the npm wrapper resets when it outlives the binary — but neither survives
 * `pkill -9 node`-style sweeps that take out the wrapper and binary together,
 * and dev/direct-binary runs have no wrapper at all. This covers those.
 *
 * POSIX:
 * - We spawn a detached `/bin/sh` whose stdin is a pipe from this process.
 *   `sh` isn't named node/bun/codebuff/freebuff, so process-name kill sweeps
 *   miss it, and `detached` puts it in its own session so process-group kills
 *   miss it too.
 * - The watchdog blocks on `cat` until the pipe hits EOF — which only happens
 *   when this process is gone, however it died — then writes the reset
 *   sequences to its stdout, which is a dup of our stdout (the terminal).
 *   It must NOT open /dev/tty: being in its own session it has no controlling
 *   terminal, so that open fails with ENXIO. Writing to an inherited tty fd
 *   needs no controlling terminal.
 * - On clean shutdown the CLI first writes reset bytes synchronously to the
 *   controlling terminal, then SIGKILLs the watchdog. If that direct write
 *   fails, the watchdog remains armed and repairs the terminal after exit.
 *
 * Windows (closes the codebuff#843 after-exit gap, where the hosting
 * terminal keeps sending mouse/focus VT input that the shell echoes as
 * `^[[<35;12;7M` gibberish):
 * - Bun/libuv put direct children in a kill-on-job-close job object, so a
 *   plain child — detached or not — is terminated the moment we die
 *   (oven-sh/bun#31603) and can never fire. Grandchildren of job members are
 *   NOT added to the job (silent-breakaway semantics), so we launch a
 *   short-lived PowerShell bootstrap (in the job; its death doesn't matter)
 *   that uses Start-Process -NoNewWindow to spawn the real watchdog outside
 *   the job, attached to our console.
 * - The pipe/EOF trick can't cross the bootstrap hop, so the watchdog
 *   detects our death by waiting on our process handle instead, then writes
 *   the reset sequences to its console stdout (ConPTY forwards the disable
 *   sequences to the hosting terminal).
 * - A pid is NOT an identity on Windows. The grandchild starts hundreds of ms
 *   (on a loaded machine, tens of seconds — `arming/timeout` fired ~3.9k times
 *   in the week to 2026-09-23) after we asked for it, and a CLI can die inside
 *   that window: the npm launcher TerminateProcess'es the running binary to
 *   apply an update seconds after launch. A watchdog that then waited on "our"
 *   pid waited on whatever process Windows handed that pid to next, for as
 *   long as THAT process lived. So the bootstrap — a member of our
 *   kill-on-close job, so it only runs while we are provably alive — reads our
 *   creation time and hands it to the grandchild, which waits only on a
 *   process with that pid AND that creation time. Anything else means we are
 *   already gone.
 * - Each watchdog keeps `<disarm path>.pid` (`<its pid> <our pid>`) for
 *   exactly as long as it runs. The next launch reads those files: a watchdog
 *   still running after its owner died is reported as
 *   `cli.helper_outlived_parent`, and a machine already carrying
 *   MAX_CONCURRENT_WINDOWS_WATCHDOGS of them gets no new one — a cap on the
 *   one long-lived PowerShell this CLI owns.
 * - We hold no handle to the grandchild, so clean shutdown can't kill it.
 *   After a confirmed synchronous reset, stopTerminalWatchdog() drops a disarm
 *   file; the watchdog checks it after its wait and exits silently.
 * - Windows PowerShell 5.1 always exists and is invoked by absolute path.
 *   Scripts are passed as plain -Command text so the command lines stay
 *   human-readable in process listings (encoded PowerShell spawned by a CLI
 *   is a classic EDR/AV malware heuristic). They are deliberately built
 *   without double quotes, which makes that quoting-safe — see
 *   spawnWindowsWatchdog.
 * - Arming takes a few hundred ms (PowerShell boot); deaths inside that
 *   window fall back to the pre-existing behavior (npm wrapper or nothing).
 */
import { spawn } from 'child_process'
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import os from 'os'
import path from 'path'

import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'

import { TERMINAL_RESET_SEQUENCES } from './terminal-reset-sequences'
import { getCliEnv } from './env'
import { trackHelperProcess } from './helper-process-telemetry'
import {
  reportCliProcessHealth,
  reportWindowsTerminalFailure,
} from './windows-terminal-health'

import type { ChildProcess } from 'child_process'

let watchdog: ChildProcess | null = null
let disarmFilePath: string | null = null
let armedFilePath: string | null = null
let armMonitor: ReturnType<typeof setTimeout> | null = null

const WINDOWS_ARM_TIMEOUT_MS = 10_000

export type TerminalWatchdogFailure = {
  stage: 'spawn' | 'bootstrap' | 'arming'
  failureCode:
    | 'enoent'
    | 'eacces'
    | 'eperm'
    | 'exit_nonzero'
    | 'terminated'
    | 'timeout'
    | 'unknown'
}

export function classifyTerminalWatchdogSpawnFailure(
  error: unknown,
): TerminalWatchdogFailure['failureCode'] {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as NodeJS.ErrnoException).code ?? '').toUpperCase()
      : ''
  if (code === 'ENOENT') return 'enoent'
  if (code === 'EACCES') return 'eacces'
  if (code === 'EPERM') return 'eperm'
  return 'unknown'
}

function reportTerminalWatchdogFailure(failure: TerminalWatchdogFailure): void {
  reportWindowsTerminalFailure(AnalyticsEvent.TERMINAL_WATCHDOG_FAILED, failure)
}

function clearArmMonitor(): void {
  if (armMonitor) clearTimeout(armMonitor)
  armMonitor = null
  if (armedFilePath) {
    try {
      rmSync(armedFilePath, { force: true })
    } catch {
      // The external watchdog also removes this marker when it exits.
    }
  }
  armedFilePath = null
}

/** Read-only watchdog state for local process diagnostics. */
export function getTerminalWatchdogDiagnostics() {
  const external = disarmFilePath !== null
  const childIsRunning = Boolean(
    watchdog?.pid && watchdog.exitCode === null && watchdog.signalCode === null,
  )
  return {
    armed: childIsRunning || external,
    external,
    pid: !external && childIsRunning ? watchdog?.pid : undefined,
  }
}

/** Reset payload with ESC as printf-compatible octal escapes. */
function printfPayload(): string {
  return TERMINAL_RESET_SEQUENCES.replace(/\x1b/g, '\\033')
}

function spawnPosixWatchdog(overrideFd: number | null): ChildProcess {
  // `cat` holds until our death closes the pipe; the reset then goes to the
  // watchdog's stdout (see stdio below). The payload contains no quotes, so
  // embedding it in single quotes is safe.
  const script = `cat >/dev/null 2>&1; printf '${printfPayload()}'`
  return spawn('/bin/sh', ['-c', script, 'terminal-reset-watchdog'], {
    detached: true,
    stdio: ['pipe', overrideFd ?? 'inherit', 'ignore'],
  })
}

/** Single-quote a string for PowerShell (only ' needs escaping, by doubling). */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Placeholder the bootstrap replaces with the owner's creation time (a Windows
 * FILETIME) before launching the grandchild. Only digits ever replace it.
 */
const OWNER_START_TOKEN = '__FREEBUFF_OWNER_START__'

/** Two reads of one creation time agree exactly; 1ms of slack absorbs rounding. */
const OWNER_START_TOLERANCE_TICKS = 10_000

export function windowsPowerShellPath(): string {
  // Windows PowerShell 5.1 ships with every supported Windows; use the
  // absolute path so a broken PATH can't take out the safety net.
  return path.join(
    getCliEnv().SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

/**
 * The two Windows scripts, pure so their invariants are testable on any OS:
 * the watchdog script contains no `"` (see the quoting note below), waits only
 * on a process whose pid AND creation time match its owner, and records both
 * pids in a pid file that lives exactly as long as it does.
 */
export function buildWindowsWatchdogScripts(options: {
  ownerPid: number
  ttyPath?: string
  disarmPath: string
  armedPath: string
  powershell: string
  /**
   * Test-only: hand the grandchild this creation time instead of the owner's
   * real one — exactly what a reused pid looks like from the watchdog's side.
   */
  ownerStartOverride?: string
}): { bootstrapScript: string; watchdogScript: string } {
  const { ownerPid } = options
  // The payload rides as a numeric byte array, which keeps the script free of
  // double quotes and string interpolation (the no-`"` invariant the quoting
  // below relies on) and avoids any Console.Out encoding translation, so the
  // reset payload arrives byte-exact.
  const payloadBytes = Array.from(
    Buffer.from(TERMINAL_RESET_SEQUENCES, 'ascii'),
  ).join(',')
  // Tests observe a file instead of the console; production writes to the
  // watchdog's stdout, which is the console (Start-Process -NoNewWindow
  // without redirection leaves the grandchild on our console's handles).
  const writeResets = options.ttyPath
    ? `[System.IO.File]::WriteAllBytes(${psQuote(options.ttyPath)}, $b)`
    : '$s=[Console]::OpenStandardOutput(); $s.Write($b, 0, $b.Length); $s.Flush()'
  // Resolve the owner BEFORE announcing "armed", so the marker means "waiting
  // on the right process, or already sure it is gone" — never "about to wait
  // on whatever holds this pid now". The armed marker lets tests wait out the
  // bootstrap hop and production report a bounded arming timeout (the owner
  // deletes it once it has looked). The pid file is the watchdog's alone: it
  // lives exactly as long as the watchdog, so the next launch can recognise
  // one that outlived its owner.
  const pidPath = windowsWatchdogPidPath(options.disarmPath)
  const watchdogScript =
    `$w = $null; ` +
    `try { $o = Get-Process -Id ${ownerPid} -ErrorAction Stop; ` +
    `if ([Math]::Abs($o.StartTime.ToFileTimeUtc() - ${OWNER_START_TOKEN}) -le ${OWNER_START_TOLERANCE_TICKS}) { $w = $o } } catch {}; ` +
    `[System.IO.File]::WriteAllText(${psQuote(pidPath)}, [string]$PID + ' ${ownerPid}'); ` +
    `[System.IO.File]::WriteAllText(${psQuote(options.armedPath)}, 'armed'); ` +
    `if ($w) { try { $w.WaitForExit() } catch {} }; ` +
    `if (Test-Path -LiteralPath ${psQuote(options.disarmPath)}) { ` +
    `Remove-Item -LiteralPath ${psQuote(options.disarmPath)} -Force -ErrorAction SilentlyContinue ` +
    `} else { ` +
    `$b=[byte[]](${payloadBytes}); ` +
    `${writeResets} }; ` +
    `Remove-Item -LiteralPath ${psQuote(options.armedPath)} -Force -ErrorAction SilentlyContinue; ` +
    `Remove-Item -LiteralPath ${psQuote(pidPath)} -Force -ErrorAction SilentlyContinue`

  // Plain -Command (not -EncodedCommand) so the command lines are auditable
  // in process listings — encoded PowerShell trips EDR/AV heuristics. This is
  // quoting-safe because the watchdog script contains no `"` (paths are
  // single-quoted, the payload is numeric): it survives as the one
  // double-quoted region of the grandchild's argument string, which
  // Start-Process passes verbatim (single pre-built -ArgumentList string). On
  // the bootstrap's own command line those `"` are escaped as \" by spawn,
  // which powershell.exe's argv tokenizer unescapes.
  const watchdogArgs = `-NoProfile -NonInteractive -Command "${watchdogScript}"`
  // The bootstrap is a member of our kill-on-close job, so while it runs we
  // are alive and this read names US. If we are already gone it throws, the
  // bootstrap exits non-zero, and no grandchild is started at all.
  const ownerStart =
    options.ownerStartOverride !== undefined
      ? String(Math.trunc(Number(options.ownerStartOverride)) || 0)
      : `(Get-Process -Id ${ownerPid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`
  const bootstrapScript =
    `$t = ${ownerStart}; ` +
    `Start-Process -FilePath ${psQuote(options.powershell)} ` +
    `-ArgumentList (${psQuote(watchdogArgs)}.Replace('${OWNER_START_TOKEN}', [string]$t)) -NoNewWindow`
  return { bootstrapScript, watchdogScript }
}

function spawnWindowsWatchdog(options: {
  ttyPath?: string
  disarmPath: string
  armedPath: string
  powershellPath?: string
  ownerStartOverride?: string
}): ChildProcess {
  const powershell = options.powershellPath ?? windowsPowerShellPath()
  const { bootstrapScript } = buildWindowsWatchdogScripts({
    ownerPid: process.pid,
    ttyPath: options.ttyPath,
    disarmPath: options.disarmPath,
    armedPath: options.armedPath,
    powershell,
    ownerStartOverride: options.ownerStartOverride,
  })

  return spawn(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', bootstrapScript],
    {
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  )
}

// ------------------------------------------------ leaked-watchdog inspection

const WATCHDOG_FILE_PREFIX = 'codebuff-watchdog-disarm-'
const PID_FILE_PATTERN = /^codebuff-watchdog-disarm-(\d+)-[a-z0-9]+\.pid$/
const ARMED_MARKER_PATTERN = /^codebuff-watchdog-disarm-(\d+)-[a-z0-9]+\.armed$/
const DISARM_FILE_PATTERN = /^codebuff-watchdog-disarm-(\d+)-[a-z0-9]+$/

/** The file a watchdog keeps for exactly as long as it runs. */
export function windowsWatchdogPidPath(disarmPath: string): string {
  return `${disarmPath}.pid`
}

/**
 * More watchdogs than this on one machine means they are not being reaped —
 * nobody runs this many CLI sessions at once — so a new launch adds none.
 */
export const MAX_CONCURRENT_WINDOWS_WATCHDOGS = 8

/** A leftover disarm file is only swept once it is clearly not in flight. */
const STALE_DISARM_AGE_MS = 60 * 60 * 1000

export type WindowsWatchdogInspection = {
  /** Watchdogs whose owner is still running (concurrent CLI sessions). */
  active: number
  /** Watchdogs still running after their owner died. */
  orphaned: number
  /**
   * Armed markers left by a watchdog that predates the pid file, whose owner
   * died before its own 10s arming check could delete the marker — the exact
   * window a reused pid could strand that watchdog. It may be leaked or may
   * have been killed; nothing here can tell which, so these are reported
   * separately and never counted as orphans.
   */
  legacyStale: number
  /** Leftover files this inspection deleted. */
  swept: number
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Classify every watchdog file in the temp directory. A watchdog deletes its
 * pid file when it exits, so a pid file whose owner is dead but whose watchdog
 * pid is alive is a watchdog that outlived its parent. Files whose watchdog is
 * provably gone, and disarm files nothing will ever consume, are swept. Every
 * dependency is injectable so this runs in tests on any OS.
 */
export function inspectWindowsWatchdogMarkers(
  deps: {
    dir?: string
    listDir?: (dir: string) => string[]
    readFile?: (file: string) => string
    ageMs?: (file: string) => number
    remove?: (file: string) => void
    isAlive?: (pid: number) => boolean
    selfPid?: number
  } = {},
): WindowsWatchdogInspection {
  const dir = deps.dir ?? os.tmpdir()
  const listDir = deps.listDir ?? ((d: string) => readdirSync(d))
  const readFile = deps.readFile ?? ((f: string) => readFileSync(f, 'utf8'))
  const ageMs = deps.ageMs ?? ((f: string) => Date.now() - statSync(f).mtimeMs)
  const remove = deps.remove ?? ((f: string) => rmSync(f, { force: true }))
  const isAlive = deps.isAlive ?? processIsAlive
  const selfPid = deps.selfPid ?? process.pid
  const result: WindowsWatchdogInspection = {
    active: 0,
    orphaned: 0,
    legacyStale: 0,
    swept: 0,
  }

  let names: string[]
  try {
    names = listDir(dir).filter((name) => name.startsWith(WATCHDOG_FILE_PREFIX))
  } catch {
    return result
  }
  const present = new Set(names)
  const sweep = (file: string) => {
    try {
      remove(file)
      result.swept++
    } catch {
      // A file another process still holds is simply left for next time.
    }
  }
  const sweepIfOlder = (file: string, minAgeMs: number) => {
    try {
      if (ageMs(file) > minAgeMs) sweep(file)
    } catch {
      // Unreadable age: leave it for the next launch.
    }
  }

  for (const name of names) {
    const file = path.join(dir, name)

    const pidFile = PID_FILE_PATTERN.exec(name)
    if (pidFile) {
      const ownerPid = Number(pidFile[1])
      if (ownerPid === selfPid) continue
      if (isAlive(ownerPid)) {
        result.active++
        continue
      }
      let watchdogPid = NaN
      try {
        watchdogPid = Number(/^(\d+) /.exec(readFile(file).trim())?.[1])
      } catch {
        continue
      }
      if (Number.isInteger(watchdogPid) && isAlive(watchdogPid)) {
        result.orphaned++
      } else {
        sweep(file)
        const armedFile = file.replace(/\.pid$/, '.armed')
        if (present.has(path.basename(armedFile))) sweep(armedFile)
      }
      continue
    }

    const armed = ARMED_MARKER_PATTERN.exec(name)
    if (armed) {
      const ownerPid = Number(armed[1])
      if (ownerPid === selfPid || isAlive(ownerPid)) continue
      // A current watchdog's marker is judged through its pid file above.
      if (present.has(name.replace(/\.armed$/, '.pid'))) continue
      // Counted once, then removed: the report is the whole value of it, and a
      // still-running watchdog's own final Remove-Item tolerates it missing.
      result.legacyStale++
      sweep(file)
      continue
    }

    const disarm = DISARM_FILE_PATTERN.exec(name)
    if (disarm) {
      // Written at a clean exit for a watchdog to consume. One still here an
      // hour after its owner died belongs to a watchdog that never ran.
      const ownerPid = Number(disarm[1])
      if (ownerPid === selfPid || isAlive(ownerPid)) continue
      sweepIfOlder(file, STALE_DISARM_AGE_MS)
    }
  }
  return result
}

/**
 * Inspect before arming: report leaked watchdogs, and refuse to add another
 * when the machine already carries too many. Returns whether to arm.
 */
export function admitWindowsWatchdog(
  inspect: () => WindowsWatchdogInspection = inspectWindowsWatchdogMarkers,
  report: typeof reportCliProcessHealth = reportCliProcessHealth,
): boolean {
  let inspection: WindowsWatchdogInspection
  try {
    inspection = inspect()
  } catch {
    return true
  }
  if (inspection.orphaned > 0 || inspection.legacyStale > 0) {
    report(AnalyticsEvent.CLI_HELPER_OUTLIVED_PARENT, {
      kind: 'terminal_watchdog',
      count: inspection.orphaned,
      legacyStale: inspection.legacyStale,
      active: inspection.active,
    })
  }
  const live = inspection.active + inspection.orphaned
  if (live < MAX_CONCURRENT_WINDOWS_WATCHDOGS) return true
  report(AnalyticsEvent.CLI_HELPER_PROCESS_FLOOD, {
    kind: 'terminal_watchdog',
    scope: 'machine',
    live,
    threshold: MAX_CONCURRENT_WINDOWS_WATCHDOGS,
    skipped: true,
  })
  return false
}

const isTruthy = (value: string | undefined): boolean =>
  value === '1' || value?.toLowerCase() === 'true'

/**
 * Start the watchdog. Call once, before the TUI renderer starts enabling
 * terminal modes. No-op when stdout isn't a TTY (unless an explicit ttyPath
 * is injected, e.g. in tests), or if already started.
 *
 * Also a no-op when CODEBUFF_NO_TERMINAL_WATCHDOG is set. This remains an
 * explicit escape hatch for Windows endpoint-security policies that reject the
 * out-of-job PowerShell grandchild used by the recovery path.
 *
 * @param options.ttyPath - Override the reset target (POSIX: the watchdog's
 *   stdout is pointed at this file; Windows: the watchdog writes the payload
 *   to this file and drops a `<ttyPath>.armed` marker once running). Tests
 *   inject a regular file here to observe what gets written.
 */
export function startTerminalWatchdog(options?: {
  ttyPath?: string
  reportFailure?: (failure: TerminalWatchdogFailure) => void
  /** Test-only override for exercising Windows spawn failures. */
  windowsPowerShellPath?: string
  /** Test-only: see buildWindowsWatchdogScripts. */
  windowsOwnerStartOverride?: string
  /**
   * Test-only: replaces the temp-dir marker inspection. Without it, runs with
   * an injected ttyPath skip the inspection (their markers live beside the
   * tty file, not in the temp dir it reads).
   */
  inspectWindowsWatchdogs?: () => WindowsWatchdogInspection
}): void {
  if (watchdog) return
  const env = getCliEnv()
  if (isTruthy(env.CODEBUFF_NO_TERMINAL_WATCHDOG)) return
  if (!options?.ttyPath && !process.stdout.isTTY) return

  const reportFailure = options?.reportFailure ?? reportTerminalWatchdogFailure
  let overrideFd: number | null = null
  try {
    let child: ChildProcess
    if (process.platform === 'win32') {
      const inspect =
        options?.inspectWindowsWatchdogs ??
        (options?.ttyPath ? undefined : inspectWindowsWatchdogMarkers)
      if (inspect && !admitWindowsWatchdog(inspect)) return
      const disarmPath = path.join(
        os.tmpdir(),
        `codebuff-watchdog-disarm-${process.pid}-${Math.random().toString(36).slice(2)}`,
      )
      const armedPath = options?.ttyPath
        ? `${options.ttyPath}.armed`
        : `${disarmPath}.armed`
      child = spawnWindowsWatchdog({
        ttyPath: options?.ttyPath,
        disarmPath,
        armedPath,
        powershellPath: options?.windowsPowerShellPath,
        ownerStartOverride: options?.windowsOwnerStartOverride,
      })
      disarmFilePath = disarmPath
      if (!options?.ttyPath) {
        armedFilePath = armedPath
      }
    } else {
      if (options?.ttyPath) {
        overrideFd = openSync(options.ttyPath, 'w')
      }
      child = spawnPosixWatchdog(overrideFd)
    }
    let failureReported = false
    const reportOnce = (failure: TerminalWatchdogFailure) => {
      if (failureReported) return
      failureReported = true
      reportFailure(failure)
    }
    const fail = (failure: TerminalWatchdogFailure) => {
      if (failureReported || watchdog !== child) return
      watchdog = null
      disarmFilePath = null
      clearArmMonitor()
      reportOnce(failure)
    }
    child.on('error', (error) => {
      fail({
        stage: 'spawn',
        failureCode: classifyTerminalWatchdogSpawnFailure(error),
      })
    })
    if (process.platform === 'win32') {
      child.on('exit', (code, signal) => {
        if (code === 0 || watchdog !== child) return
        fail({
          stage: 'bootstrap',
          failureCode: signal ? 'terminated' : 'exit_nonzero',
        })
      })
    }
    // Don't let the watchdog (or our write end of its pipe) hold the event
    // loop open — the CLI must still be able to exit naturally. stdin is a
    // Socket at runtime; its unref isn't in the Writable type.
    child.unref()
    // POSIX: the watchdog itself, alive for our whole life. Windows: only the
    // short-lived bootstrap. Either way more than a couple live at once is a
    // leak, and the census reports it.
    trackHelperProcess('terminal_watchdog', child)
    child.stdin?.on('error', () => {})
    ;(child.stdin as { unref?: () => void } | null)?.unref?.()
    watchdog = child
    if (armedFilePath) {
      const expectedMarker = armedFilePath
      armMonitor = setTimeout(() => {
        if (watchdog !== child) return
        const armed = existsSync(expectedMarker)
        clearArmMonitor()
        if (!armed) {
          reportOnce({ stage: 'arming', failureCode: 'timeout' })
        }
      }, WINDOWS_ARM_TIMEOUT_MS)
      ;(armMonitor as { unref?: () => void }).unref?.()
    }
  } catch (error) {
    disarmFilePath = null
    clearArmMonitor()
    if (process.platform === 'win32') {
      reportFailure({
        stage: 'spawn',
        failureCode: classifyTerminalWatchdogSpawnFailure(error),
      })
    }
    // Best-effort: no watchdog is the pre-existing behavior.
  } finally {
    if (overrideFd !== null) {
      try {
        closeSync(overrideFd) // the child holds its own dup
      } catch {
        // Ignore close errors
      }
    }
  }
}

/**
 * Disarm the watchdog after the clean-shutdown path has synchronously restored
 * the terminal. Safe to call multiple times and synchronous, so it also works
 * inside a process 'exit' handler.
 */
export function stopTerminalWatchdog(): void {
  const child = watchdog
  const disarm = disarmFilePath
  if (!child && !disarm) return
  watchdog = null
  disarmFilePath = null
  clearArmMonitor()
  if (disarm) {
    // Windows: the real watchdog is a grandchild we hold no handle to; it
    // checks for this file after our death and stays silent when present.
    try {
      writeFileSync(disarm, '')
    } catch {
      // Best-effort; worst case the watchdog writes resets on a clean exit,
      // which the terminal treats as no-ops.
    }
  }
  if (child) {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already dead — nothing to stop.
    }
  }
}
