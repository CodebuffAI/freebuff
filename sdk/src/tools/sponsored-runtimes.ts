/**
 * WHICH RUNTIMES A SPONSORED RUN CAN USE (COD-829), asked of the run's own
 * sandbox rather than of the host.
 *
 * A Node install under the user's home folder (nvm, mise, volta) is on the
 * host's PATH and invisible to the sandbox, which is exactly the
 * `missing_node` failure the grader counts. So the probe runs through the
 * same broker a run's commands do, with the same environment, and reports
 * only what started there. A runtime is listed when `command -v` finds it AND
 * `--version` exits 0, so a binary the sandbox can see but not execute (an
 * EPERM on an npx shim) reads as missing too.
 *
 * Unknown is `undefined`, never `[]`: a probe that timed out, failed to
 * start or printed nothing it recognised must not tell the server that
 * nothing is installed, because only a reported list ever warns.
 */
import {
  SPONSORED_RUNTIMES,
  type SponsoredRuntime,
} from '@codebuff/common/ads/sponsored-capability'

import type { TerminalCommandBroker } from './run-terminal-command'

export const SPONSORED_RUNTIME_PROBE_TIMEOUT_MS = 4_000

/**
 * POSIX sh: prints one runtime name per line for each that runs. Python is
 * `python3`, else `python`, reported as `python`. Ends with a sentinel so a
 * probe cut short is told apart from one that found nothing.
 */
export const SPONSORED_RUNTIME_PROBE_SCRIPT = [
  'for c in node npx bun; do',
  '  command -v "$c" >/dev/null 2>&1 && "$c" --version >/dev/null 2>&1 && echo "$c"',
  'done',
  'for c in python3 python; do',
  '  if command -v "$c" >/dev/null 2>&1 && "$c" --version >/dev/null 2>&1; then echo python; break; fi',
  'done',
  'echo __freebuff_runtimes_done__',
].join('\n')

const DONE = '__freebuff_runtimes_done__'

/** The probe's stdout, parsed; `undefined` when it did not run to the end. */
export function parseSponsoredRuntimeProbe(
  stdout: string,
): SponsoredRuntime[] | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.includes(DONE)) return undefined
  return SPONSORED_RUNTIMES.filter((runtime) => lines.includes(runtime))
}

/**
 * Run the probe through `broker` (a sponsored terminal broker built exactly
 * as the run's is). Never throws.
 */
export async function probeSponsoredRuntimes(
  broker: TerminalCommandBroker,
  request: {
    cwd: string
    env: NodeJS.ProcessEnv
    timeoutMs?: number
  },
): Promise<SponsoredRuntime[] | undefined> {
  // The Windows floor runs PowerShell, which this script is not.
  if (broker.ownsShell) return undefined
  let child: ReturnType<TerminalCommandBroker['start']>
  try {
    child = broker.start({
      executable: '/bin/sh',
      args: ['-c', SPONSORED_RUNTIME_PROBE_SCRIPT],
      cwd: request.cwd,
      env: request.env,
    })
  } catch {
    return undefined
  }
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer | string) => {
    if (stdout.length < 4096) stdout += chunk.toString()
  })
  child.stderr.resume()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(
      () => resolve('timeout'),
      request.timeoutMs ?? SPONSORED_RUNTIME_PROBE_TIMEOUT_MS,
    )
  })
  try {
    const result = await Promise.race([
      child.completion.catch(() => null),
      timedOut,
    ])
    if (result === 'timeout') {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      return undefined
    }
    if (result !== 0) return undefined
    return parseSponsoredRuntimeProbe(stdout)
  } finally {
    clearTimeout(timer)
  }
}
