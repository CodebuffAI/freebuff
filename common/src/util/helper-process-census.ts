/**
 * Live-count telemetry for the helper processes a client spawns.
 *
 * WHY THIS EXISTS. On 2026-09-23 a Windows user reported "conhost and
 * powershell flood from freebuff — it's been happening for so long": ~50
 * `conhost.exe` and many `powershell.exe` at 800–960 MB each, the machine at
 * 98% RAM. Nothing server-side can see a client-side process flood, and nothing
 * client-side was counting, so "so long" was weeks of a problem no dashboard
 * could show. This module is the count.
 *
 * TWO SCOPES, because they answer different questions:
 *
 *   owned    children THIS process spawned and still holds a handle to, by
 *            kind. A flood here is our bug, full stop — a helper we start and
 *            never reap, or a poll that overlaps itself.
 *   machine  (Windows only) every powershell / conhost / bash / cmd process on
 *            the machine, from one `tasklist` every few minutes. This is the
 *            symptom the user actually sees in Task Manager, and it is the only
 *            way to see helpers that escaped us: a grandchild outside our job
 *            object, a watchdog waiting on a reused pid, a shell a command left
 *            behind. It cannot attribute a process to us — it is a smoke alarm,
 *            not a fingerprint — so it is reported as its own scope.
 *
 * PRIVACY: counts and memory totals only. Never a command line, path, pid or
 * any process name outside the fixed allowlist below.
 *
 * VOLUME: at most one report per (scope, kind) per cooldown (30 min default),
 * and only above a threshold, so a healthy install emits nothing at all.
 */

export type HelperProcessKind =
  /** CLI: the Windows PowerShell bootstrap that launches the terminal watchdog. */
  | 'terminal_watchdog'
  /** A terminal-tool command (broker or direct shell). */
  | 'terminal_command'
  /** Clipboard helper (clip.exe, pbcopy, xclip, ...). */
  | 'clipboard'
  /** CLI: the `tasklist` probe watching the npm launcher. */
  | 'launcher_probe'
  /** Desktop: an interactive terminal-panel shell. */
  | 'shell'
  /** Desktop: a harness CLI process (codex app-server, ...). */
  | 'harness'
  /** Desktop: a UAC-elevated command. */
  | 'elevation'

export type MachineProcessKind = 'powershell' | 'conhost' | 'bash' | 'cmd'

export type HelperProcessFloodReport = {
  kind: HelperProcessKind | MachineProcessKind
  scope: 'owned' | 'machine'
  /** Live processes of this kind when the threshold was crossed. */
  live: number
  threshold: number
  /** Machine scope only: summed and largest working set of this kind, in MB. */
  totalMemoryMb?: number
  maxMemoryMb?: number
  /** Machine scope only: every process on the machine, for scale. */
  machineProcesses?: number
}

export const DEFAULT_OWNED_THRESHOLD = 10
export const DEFAULT_REPORT_COOLDOWN_MS = 30 * 60 * 1000

/**
 * Per-kind owned thresholds. A handful of terminal commands in flight is normal
 * for a busy agent; ten live clipboard helpers never is.
 */
export const DEFAULT_OWNED_THRESHOLDS: Partial<
  Record<HelperProcessKind, number>
> = {
  terminal_watchdog: 3,
  clipboard: 3,
  launcher_probe: 3,
  elevation: 3,
  harness: 12,
  terminal_command: 12,
  shell: 16,
}

/**
 * Machine-wide counts that are already abnormal. A developer with a few
 * terminal tabs sits far below these; the reported flood was ~50 conhosts.
 */
export const DEFAULT_MACHINE_THRESHOLDS: Record<MachineProcessKind, number> = {
  powershell: 15,
  conhost: 60,
  bash: 40,
  cmd: 40,
}

/** Something whose exit can be observed: a node ChildProcess or a Bun Subprocess. */
export type TrackableProcess =
  | {
      once(
        event: 'exit' | 'error',
        listener: (...args: unknown[]) => void,
      ): unknown
    }
  | { exited: Promise<unknown> }

export type HelperProcessCensusOptions = {
  report: (report: HelperProcessFloodReport) => void
  ownedThresholds?: Partial<Record<HelperProcessKind, number>>
  defaultOwnedThreshold?: number
  cooldownMs?: number
  now?: () => number
}

export class HelperProcessCensus {
  private readonly liveByKind = new Map<HelperProcessKind, number>()
  private readonly lastReportAt = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly options: HelperProcessCensusOptions) {
    this.now = options.now ?? Date.now
  }

  /**
   * Count one live helper of `kind` until the returned release is called.
   * Release is idempotent, so wiring it to several exit paths is safe.
   */
  acquire(kind: HelperProcessKind): () => void {
    const live = (this.liveByKind.get(kind) ?? 0) + 1
    this.liveByKind.set(kind, live)
    const threshold = this.ownedThreshold(kind)
    if (live > threshold) {
      this.maybeReport({ kind, scope: 'owned', live, threshold })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const next = (this.liveByKind.get(kind) ?? 1) - 1
      if (next <= 0) this.liveByKind.delete(kind)
      else this.liveByKind.set(kind, next)
    }
  }

  /** Count `child` until it exits (or fails to start). Never throws. */
  track(
    kind: HelperProcessKind,
    child: TrackableProcess | null | undefined,
  ): void {
    if (!child) return
    try {
      const release = this.acquire(kind)
      if ('exited' in child && child.exited instanceof Promise) {
        child.exited.then(release, release)
        return
      }
      if ('once' in child && typeof child.once === 'function') {
        child.once('exit', release)
        child.once('error', release)
        return
      }
      release()
    } catch {
      // Telemetry must never affect process handling.
    }
  }

  /**
   * Gauge form of `acquire`, for owners that already keep their own set of
   * live processes (a session map, the SDK's in-flight commands): feed the
   * current size, and it is reported like a tracked count would be.
   */
  observeOwned(kind: HelperProcessKind, live: number): boolean {
    const threshold = this.ownedThreshold(kind)
    if (!(live > threshold)) return false
    return this.maybeReport({ kind, scope: 'owned', live, threshold })
  }

  count(kind: HelperProcessKind): number {
    return this.liveByKind.get(kind) ?? 0
  }

  snapshot(): Partial<Record<HelperProcessKind, number>> {
    return Object.fromEntries(this.liveByKind)
  }

  /** Feed one machine-wide census; reports each kind above its threshold. */
  observeMachine(
    summary: MachineProcessSummary,
    thresholds: Record<MachineProcessKind, number> = DEFAULT_MACHINE_THRESHOLDS,
  ): HelperProcessFloodReport[] {
    const reported: HelperProcessFloodReport[] = []
    for (const kind of Object.keys(thresholds) as MachineProcessKind[]) {
      const stats = summary.kinds[kind]
      const threshold = thresholds[kind]
      if (!stats || stats.count <= threshold) continue
      const report: HelperProcessFloodReport = {
        kind,
        scope: 'machine',
        live: stats.count,
        threshold,
        totalMemoryMb: stats.totalMemoryMb,
        maxMemoryMb: stats.maxMemoryMb,
        machineProcesses: summary.total,
      }
      if (this.maybeReport(report)) reported.push(report)
    }
    return reported
  }

  private ownedThreshold(kind: HelperProcessKind): number {
    return (
      this.options.ownedThresholds?.[kind] ??
      DEFAULT_OWNED_THRESHOLDS[kind] ??
      this.options.defaultOwnedThreshold ??
      DEFAULT_OWNED_THRESHOLD
    )
  }

  private maybeReport(report: HelperProcessFloodReport): boolean {
    const key = `${report.scope}:${report.kind}`
    const now = this.now()
    const last = this.lastReportAt.get(key)
    const cooldown = this.options.cooldownMs ?? DEFAULT_REPORT_COOLDOWN_MS
    if (last !== undefined && now - last < cooldown) return false
    this.lastReportAt.set(key, now)
    try {
      this.options.report(report)
    } catch {
      // Telemetry must never affect process handling.
    }
    return true
  }
}

// ---------------------------------------------------------------- machine census

/** Image names we count, lowercased. Everything else is only a total. */
export const MACHINE_PROCESS_IMAGES: Readonly<
  Record<string, MachineProcessKind>
> = {
  'powershell.exe': 'powershell',
  'pwsh.exe': 'powershell',
  'conhost.exe': 'conhost',
  'bash.exe': 'bash',
  'cmd.exe': 'cmd',
}

export type MachineProcessStats = {
  count: number
  totalMemoryMb: number
  maxMemoryMb: number
}

export type MachineProcessSummary = {
  total: number
  kinds: Partial<Record<MachineProcessKind, MachineProcessStats>>
}

/** Split one CSV line of quoted fields (`"a","b,c","d"`). */
function csvFields(line: string): string[] {
  const fields: string[] = []
  const pattern = /"((?:[^"]|"")*)"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line)) !== null) {
    fields.push(match[1]!.replace(/""/g, '"'))
  }
  return fields
}

/**
 * Parse `tasklist /FO CSV /NH`. Columns are image, pid, session name,
 * session #, memory — the memory text is localized ("85,432 K", "85.432 K",
 * "85 432 Ko"), so only its digits are read. Header-less on purpose (/NH), but a
 * stray header line parses as a non-numeric pid and is dropped.
 */
export function parseTasklistCsv(
  stdout: string,
): Array<{ image: string; memoryKb: number }> {
  const rows: Array<{ image: string; memoryKb: number }> = []
  for (const line of stdout.split(/\r?\n/)) {
    const fields = csvFields(line)
    if (fields.length < 5) continue
    if (!/^\d+$/.test(fields[1]!.trim())) continue
    const digits = fields[fields.length - 1]!.replace(/\D/g, '')
    rows.push({
      image: fields[0]!.trim().toLowerCase(),
      memoryKb: digits ? Number(digits) : 0,
    })
  }
  return rows
}

export function summarizeMachineProcesses(
  rows: ReadonlyArray<{ image: string; memoryKb: number }>,
): MachineProcessSummary {
  const kinds: Partial<Record<MachineProcessKind, MachineProcessStats>> = {}
  for (const row of rows) {
    const kind = MACHINE_PROCESS_IMAGES[row.image]
    if (!kind) continue
    const stats = (kinds[kind] ??= {
      count: 0,
      totalMemoryMb: 0,
      maxMemoryMb: 0,
    })
    const mb = row.memoryKb / 1024
    stats.count++
    stats.totalMemoryMb += mb
    stats.maxMemoryMb = Math.max(stats.maxMemoryMb, mb)
  }
  for (const stats of Object.values(kinds)) {
    stats.totalMemoryMb = Math.round(stats.totalMemoryMb)
    stats.maxMemoryMb = Math.round(stats.maxMemoryMb)
  }
  return { total: rows.length, kinds }
}

export type MachineProcessCensusOptions = {
  census: HelperProcessCensus
  /** `tasklist /FO CSV /NH` stdout. Rejections are swallowed. */
  listProcesses: () => Promise<string>
  intervalMs?: number
  initialDelayMs?: number
  thresholds?: Record<MachineProcessKind, number>
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}

export const DEFAULT_MACHINE_CENSUS_INTERVAL_MS = 10 * 60 * 1000
export const DEFAULT_MACHINE_CENSUS_INITIAL_DELAY_MS = 2 * 60 * 1000

/**
 * Poll the machine-wide census. One listing at a time: the next poll is only
 * scheduled once the previous one settled, so a `tasklist` that hangs on a
 * machine at 98% RAM cannot stack up copies of itself — which would be this
 * telemetry reproducing the very flood it exists to detect.
 */
export function startMachineProcessCensus(
  options: MachineProcessCensusOptions,
): {
  stop: () => void
  runOnce: () => Promise<HelperProcessFloodReport[]>
} {
  const setTimer =
    options.setTimeoutFn ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms)
      ;(handle as { unref?: () => void }).unref?.()
      return handle
    })
  const clearTimer =
    options.clearTimeoutFn ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let stopped = false
  let timer: unknown = null
  let inFlight: Promise<HelperProcessFloodReport[]> | null = null

  const runOnce = (): Promise<HelperProcessFloodReport[]> => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const stdout = await options.listProcesses()
        return options.census.observeMachine(
          summarizeMachineProcesses(parseTasklistCsv(stdout)),
          options.thresholds,
        )
      } catch {
        return []
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  const schedule = (ms: number) => {
    if (stopped) return
    timer = setTimer(() => {
      timer = null
      void runOnce().finally(() =>
        schedule(options.intervalMs ?? DEFAULT_MACHINE_CENSUS_INTERVAL_MS),
      )
    }, ms)
  }
  schedule(options.initialDelayMs ?? DEFAULT_MACHINE_CENSUS_INITIAL_DELAY_MS)

  return {
    stop: () => {
      stopped = true
      if (timer !== null) clearTimer(timer)
      timer = null
    },
    runOnce,
  }
}
