import { compareFindings, finding, type DoctorArea, type DoctorCheckRun, type DoctorFinding } from './types'

export type DoctorCheck<Context> = {
  id: string
  area: DoctorArea
  /** Runs only when the user asks for a deep scan (a full database integrity check). */
  deep?: boolean
  /** Per-check bound; a slow check reports that it timed out and the scan carries on. */
  timeoutMs?: number
  run(context: Context, signal: AbortSignal): Promise<DoctorFinding[]> | DoctorFinding[]
}

const DEFAULT_TIMEOUT_MS = 8_000

/**
 * Runs every check concurrently, each under its own time limit. A check that throws or times out
 * becomes one `info` finding naming the check, never the error text (which may hold a path), so
 * one broken check can neither fail the scan nor leak into the report.
 */
export async function runDoctorChecks<Context>(
  checks: ReadonlyArray<DoctorCheck<Context>>,
  context: Context,
  options: { deep?: boolean; signal?: AbortSignal; now?: () => number } = {},
): Promise<{ findings: DoctorFinding[]; checks: DoctorCheckRun[] }> {
  const now = options.now ?? (() => performance.now())
  const runs = await Promise.all(checks.map(async (check): Promise<{ run: DoctorCheckRun; findings: DoctorFinding[] }> => {
    if (check.deep && !options.deep) return { run: { id: check.id, ms: 0, outcome: 'skipped' }, findings: [] }
    const started = now()
    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), check.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      })
      const result = await Promise.race([Promise.resolve().then(() => check.run(context, controller.signal)), timeout])
      if (result === 'timeout') {
        controller.abort()
        return {
          run: { id: check.id, ms: Math.round(now() - started), outcome: 'timeout' },
          findings: [finding(`${check.id}.timeout`, 'info', check.area, `A check took too long (${check.id})`,
            'This check did not finish in time, so its result is missing from this report. A slow disk or network can cause this.',
            ['Run the scan again. If it keeps timing out, mention it when you contact support.'])],
        }
      }
      return { run: { id: check.id, ms: Math.round(now() - started), outcome: 'done' }, findings: result }
    } catch {
      return {
        run: { id: check.id, ms: Math.round(now() - started), outcome: 'failed' },
        findings: [finding(`${check.id}.failed`, 'info', check.area, `A check could not run (${check.id})`,
          'This check stopped with an error, so its result is missing from this report.', [])],
      }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }))
  return {
    findings: runs.flatMap(run => run.findings).sort(compareFindings),
    checks: runs.map(run => run.run),
  }
}
