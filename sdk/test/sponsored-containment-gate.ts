/**
 * The gate every OS-containment test runs through, shared by the SDK, CLI and
 * Desktop suites so the skip rule is stated once.
 *
 * Some hosts cannot start a nested OS sandbox at all — Codex's own parent
 * Seatbelt profile rejects `sandbox-exec`, a developer's Linux box may have no
 * `bwrap`, and the Ubicloud CI runners cannot configure loopback inside a new
 * network namespace at all (`bwrap: loopback: Failed RTM_NEWADDR: Operation
 * not permitted`), which the sandbox needs because it unshares the network on
 * purpose. On all of those the suites SKIP, with one line saying so.
 *
 * One place may NOT skip: the dedicated `test-sponsored-containment` job in
 * `ci.yml`, GitHub-hosted `ubuntu-latest`, which installs bubblewrap and sets
 * `SPONSORED_CONTAINMENT_REQUIRED=1`. There a skip is a build error, because a
 * skip reads exactly like a pass in a green build — the containment tests
 * self-skipped on every automated runner from the day they were written until
 * COD-435, which is how a deny-list hole in the Linux arm went unexecuted.
 *
 * Probes a PERMISSIVE profile rather than matching failure text, so a profile
 * broken on our side stays red instead of reading as "host cannot sandbox".
 */
import { spawnSync } from 'node:child_process'

import { sponsoredContainment } from '../src/tools/sponsored-sandbox'

export function sponsoredContainmentUsable(): boolean {
  if (process.platform === 'darwin') {
    return (
      spawnSync('/usr/bin/sandbox-exec', [
        '-p',
        '(version 1)(allow default)',
        '/usr/bin/true',
      ]).status === 0
    )
  }
  if (process.platform === 'linux') return sponsoredContainment().available
  return false
}

/**
 * Whether THIS job declared that containment must execute. Deliberately an
 * explicit variable and not `CI` / `GITHUB_ACTIONS`: `sdk/test/setup-env.ts`
 * forces `CI=true` on every test run, laptop included, and most Linux CI
 * runners cannot run bubblewrap with an unshared network namespace, so
 * "in CI on Linux" is not the condition. The one job that installs bubblewrap
 * on a runner that can use it sets this.
 */
function containmentRequired(): boolean {
  return process.env.SPONSORED_CONTAINMENT_REQUIRED === '1'
}

export function sponsoredContainmentTestGate(): boolean {
  if (sponsoredContainmentUsable()) return true
  const reason =
    process.platform === 'linux'
      ? 'bubblewrap (bwrap) is not installed'
      : process.platform === 'darwin'
        ? '/usr/bin/sandbox-exec cannot start a nested sandbox on this host'
        : `no OS containment mechanism on ${process.platform}`
  if (containmentRequired()) {
    throw new Error(
      `sponsored containment tests cannot run: ${reason}. SPONSORED_CONTAINMENT_REQUIRED=1 is set, so a skip is a build error (COD-435): fix the "Install bubblewrap" step of the test-sponsored-containment job in .github/workflows/ci.yml, or the runner it targets, rather than letting the suite skip.`,
    )
  }
  console.warn(
    `sponsored containment tests skipped: ${reason}${process.platform === 'linux' ? ' (apt-get install bubblewrap)' : ''}`,
  )
  return false
}
