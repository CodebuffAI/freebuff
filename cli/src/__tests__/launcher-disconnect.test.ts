import { spawn } from 'child_process'
import path from 'path'

import { expect, test } from 'bun:test'

import { ensureCliTestEnv } from './test-utils'

ensureCliTestEnv()

const LAUNCHER_FIXTURE = path.join(
  import.meta.dir,
  'helpers',
  'launcher-disconnect-fixture.cjs',
)
const RENDERER_FIXTURE = path.join(
  import.meta.dir,
  'helpers',
  'renderer-cleanup-fixture.tsx',
)

/**
 * How long to keep reading after the fixture exits. Its diagnostics are written
 * immediately before `process.exit`, so the bytes are already in the pipe and
 * this only covers the hand-off — measured, 100ms was enough to capture them in
 * full. Kept well above that, but deliberately short: the fixture bounds itself
 * at its READY_TIMEOUT_MS renderer-ready deadline plus a SURVIVAL_TIMEOUT_MS
 * window that starts only once the launcher is killed, and the headroom under
 * the test timeout below is what stops a slow runner from turning a real failure
 * back into the contentless timeout this indirection exists to prevent.
 */
const OUTPUT_DRAIN_MS = 750

test('the CLI exits cleanly when its package launcher disappears', async () => {
  const result = await new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    output: string
  }>((resolve, reject) => {
    // On this already-running Bun, not `node`: a fresh Windows VM can take
    // seconds to start node for the first time, and no fixture clock covers it.
    const child = spawn(
      process.execPath,
      [LAUNCHER_FIXTURE, 'observe', RENDERER_FIXTURE],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let openStreams = 2
    let settled = false
    let drain: ReturnType<typeof setTimeout> | undefined

    // Report as soon as we know the exit status AND either the pipes drained or
    // the drain window elapsed. Nothing resolves without an exit status, so a
    // surviving CLI still fails the assertions below rather than passing.
    const settle = () => {
      if (settled || !exit) return
      settled = true
      if (drain) clearTimeout(drain)
      resolve({ ...exit, output })
    }
    const onStreamEnd = () => {
      openStreams -= 1
      if (openStreams === 0) settle()
    }

    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.stdout.once('end', onStreamEnd)
    child.stderr.once('end', onStreamEnd)
    child.once('error', reject)

    // Wait on 'exit', not 'close'. The fixture spawns both the launcher and the
    // CLI with stdio:'inherit', so those grandchildren hold these pipes open. A
    // CLI that outlives its launcher — the exact failure this test exists to
    // catch — keeps them open forever, so 'close' never fires and the run died
    // on the 15s timeout instead, throwing away the fixture's exit code and its
    // "CLI survived after its launcher exited" diagnostic.
    child.once('exit', (code, signal) => {
      exit = { code, signal }
      if (openStreams === 0) {
        settle()
        return
      }
      drain = setTimeout(settle, OUTPUT_DRAIN_MS)
    })
  })

  if (result.code !== 0) {
    console.error(
      result.output ||
        '(fixture exited without any captured output — it writes its diagnostic ' +
          'immediately before process.exit, which can truncate a piped write)',
    )
  }
  expect(result.code).toBe(0)
  expect(result.signal).toBeNull()
  expect(result.output).toContain('CLEAN_EXIT_VISIBLE')
  expect(result.output).toContain('CLI_EXITED_AFTER_LAUNCHER')
  expect(result.output).not.toContain('CLI survived after its launcher exited')
}, 90_000)
