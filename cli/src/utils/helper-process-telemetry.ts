/**
 * The CLI's helper-process census: counts the children it spawns by kind and,
 * on Windows, how many powershell / conhost / bash / cmd processes the whole
 * machine is carrying. Either crossing its threshold emits
 * `cli.helper_process_flood` (rate-limited per kind) through the same
 * PostHog + Axiom path as the Windows terminal-health events, so a flood on a
 * user's machine is finally visible in `scripts/logs/alert-helper-process-flood.ts`.
 *
 * See common/src/util/helper-process-census.ts for the model and the privacy
 * envelope (counts only).
 */
import { execFile } from 'child_process'

import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import {
  HelperProcessCensus,
  startMachineProcessCensus,
} from '@codebuff/common/util/helper-process-census'

import { reportCliProcessHealth } from './windows-terminal-health'

import type {
  HelperProcessFloodReport,
  HelperProcessKind,
  TrackableProcess,
} from '@codebuff/common/util/helper-process-census'

let census: HelperProcessCensus | null = null
let machineCensus: { stop: () => void } | null = null

function reportFlood(report: HelperProcessFloodReport): void {
  reportCliProcessHealth(AnalyticsEvent.CLI_HELPER_PROCESS_FLOOD, report)
}

export function getHelperProcessCensus(): HelperProcessCensus {
  return (census ??= new HelperProcessCensus({ report: reportFlood }))
}

/** Count `child` as a live helper of `kind` until it exits. Never throws. */
export function trackHelperProcess(
  kind: HelperProcessKind,
  child: TrackableProcess | null | undefined,
): void {
  getHelperProcessCensus().track(kind, child)
}

/** Read-only counts for local diagnostics. */
export function getHelperProcessSnapshot() {
  return census?.snapshot() ?? {}
}

/** `tasklist` stdout, bounded in time and size. */
export function listWindowsProcesses(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'tasklist',
      ['/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    )
  })
}

/**
 * Start the Windows machine census (no-op elsewhere, and idempotent). One
 * `tasklist` a few minutes after launch, then every ten minutes, never two at
 * once, on an unref'd timer so it can never hold the CLI open.
 */
export function startWindowsMachineProcessCensus(): void {
  if (process.platform !== 'win32' || machineCensus) return
  machineCensus = startMachineProcessCensus({
    census: getHelperProcessCensus(),
    listProcesses: listWindowsProcesses,
  })
}

export function stopWindowsMachineProcessCensus(): void {
  machineCensus?.stop()
  machineCensus = null
}
