#!/usr/bin/env bun
/**
 * Long-running smoke test for a compiled CLI binary.
 *
 * `--version` and `--help` exit via commander synchronously, before async
 * startup failures (e.g. the unhandled rejection from Parser.init when the
 * tree-sitter wasm load fails) get a chance to fire. This script spawns the
 * binary, lets it run for a few seconds, then kills it and asserts the TUI
 * actually rendered a known boot screen.
 *
 * Before the long-running UI check, this also invokes explicit compiled
 * runtime smoke flags in the binary. Those cover startup-sensitive assets
 * (tree-sitter) and non-UI runtime integrations (network, subprocesses,
 * vendored native tools, filesystem IO).
 *
 * The positive boot check matters more than the negative one: a "did the
 * boot screen appear" assertion catches *any* startup failure — known fatals,
 * novel error messages, silent crashes, hangs, segfaults that produce no
 * output. Negative pattern matches are kept only for clearer diagnostics
 * when a known regression recurs.
 *
 * Designed to run on every supported platform (Linux, macOS, Windows) without
 * extra deps. The binary doesn't need a TTY: OpenTUI emits ANSI escapes to
 * stdout regardless, and the static text we look for renders contiguously.
 *
 * Usage:
 *   bun cli/scripts/smoke-binary.ts <path-to-binary> [seconds]
 *
 * Exits 0 if a boot signal is detected and no fatal markers are present, 1
 * otherwise.
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'

// Any one of these strings appearing in stdout/stderr proves the binary
// reached its post-init UI: React tree mounted, OpenTUI rendered, async
// wasm init survived. Strings are static text from rendered components
// (not shimmer / animated) so they survive ANSI styling as contiguous
// substrings. Cover the multiple boot states the binary might land on:
//
//   - "will run commands on your behalf" — codebuff/freebuff main surface
//     header (authed + session ready)
//   - "Press ENTER to login" / "Open this URL" — login modal (no cached
//     creds — typical CI smoke)
//   - "Pick a model to start" / waiting-room copy — freebuff queue gate
//   - "Free mode isn't available" — freebuff country-block screen (CI
//     runners with anonymized-network egress like GitHub Actions land here)
//   - "Enter a coding task" — chat input prompt
const BOOT_SIGNAL_PATTERNS = [
  /will run commands on your behalf/,
  /Pick a model to start/,
  /You're in the waiting room/,
  /You're next in line/,
  /Free mode isn't available/,
  /Press ENTER to login/,
  /Open this URL/,
  /Enter a coding task/,
] as const

// Fatal markers we already know about — kept for nicer error messages on
// regressions of bugs we've already seen. The boot-signal check above is
// the real gate: it fails on *any* startup problem, including ones whose
// error text we never thought to add here.
//
// Note both paths the cli error handlers print: "Fatal error during
// startup" (earlyFatalHandler in cli/src/index.tsx, fires while main()
// is still wiring up) and "Unhandled rejection:" / "Uncaught exception:"
// (installProcessCleanupHandlers in cli/src/utils/renderer-cleanup.ts,
// fires after the renderer is up). The wasm-load rejection on freebuff
// 0.0.62 surfaced through the *late* renderer-cleanup path, after the
// boot screen had already rendered.
const FATAL_PATTERNS = [
  /Fatal error during startup/i,
  /Unhandled rejection:/i,
  /Uncaught exception:/i,
  /Internal error: tree-sitter\.wasm not found/i,
  /UnhandledPromiseRejection/i,
  /Cannot find module/i,
] as const

// Long enough that an unhandled rejection from the eager Parser.init has
// time to surface through the renderer-cleanup handler — that path is
// what tripped freebuff 0.0.62 in the wild while a 5s window let CI pass.
// Async wasm rejections can fire >5s after spawn (after React mounts and
// the renderer is up).
const DEFAULT_RUN_SECONDS = 10

function runFlagSmoke({
  binary,
  flag,
  label,
  okPattern,
  timeoutMs,
}: {
  binary: string
  flag: string
  label: string
  okPattern: RegExp
  timeoutMs: number
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, [flag], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    })

    let captured = ''
    const append = (chunk: Buffer): void => {
      captured += chunk.toString('utf8')
    }
    proc.stdout?.on('data', append)
    proc.stderr?.on('data', append)

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)

    proc.once('error', reject)
    proc.once('exit', (code) => {
      clearTimeout(timeout)

      if (timedOut) {
        reject(
          new Error(
            `${label} smoke timed out after ${timeoutMs}ms\n${captured.slice(
              0,
              8 * 1024,
            )}`,
          ),
        )
        return
      }

      if (code === 0 && okPattern.test(captured)) {
        resolve()
        return
      }

      reject(
        new Error(
          `${label} smoke failed with exit code ${code}\n${captured.slice(
            0,
            8 * 1024,
          )}`,
        ),
      )
    })
  })
}

async function main(): Promise<void> {
  const binary = process.argv[2]
  const runSeconds = Number(process.argv[3] ?? DEFAULT_RUN_SECONDS)

  if (!binary) {
    console.error('Usage: bun smoke-binary.ts <path-to-binary> [seconds]')
    process.exit(2)
  }
  if (!existsSync(binary)) {
    console.error(`smoke-binary: binary not found: ${binary}`)
    process.exit(2)
  }
  if (!Number.isFinite(runSeconds) || runSeconds <= 0) {
    console.error(`smoke-binary: bad seconds arg: ${process.argv[3]}`)
    process.exit(2)
  }

  console.log(`smoke-binary: spawning ${binary} for ${runSeconds}s…`)

  await runFlagSmoke({
    binary,
    flag: '--smoke-tree-sitter',
    label: 'tree-sitter',
    okPattern: /tree-sitter smoke ok/,
    timeoutMs: 30_000,
  })
  console.log('smoke-binary: tree-sitter init OK.')

  await runFlagSmoke({
    binary,
    flag: '--smoke-runtime-primitives',
    label: 'runtime primitives',
    okPattern: /runtime primitives smoke ok/,
    timeoutMs: 90_000,
  })
  console.log('smoke-binary: runtime primitives OK.')

  const proc = spawn(binary, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  })

  let captured = ''
  const append = (chunk: Buffer): void => {
    captured += chunk.toString('utf8')
  }
  proc.stdout?.on('data', append)
  proc.stderr?.on('data', append)

  let earlyExitCode: number | null = null
  const exited = new Promise<void>((resolve) => {
    proc.once('exit', (code) => {
      earlyExitCode = code
      resolve()
    })
  })

  const killTimer = setTimeout(() => {
    // SIGKILL is the only signal that's portable across Linux/macOS/Windows
    // here; SIGTERM may be ignored by the renderer on some platforms.
    proc.kill('SIGKILL')
  }, runSeconds * 1_000)

  await exited
  clearTimeout(killTimer)

  const fail = (reason: string): never => {
    console.error(`smoke-binary: FAIL — ${reason} (exit code ${earlyExitCode}).`)
    console.error('--- captured output (truncated to 8KB) ---')
    console.error(captured.slice(0, 8 * 1024))
    process.exit(1)
  }

  // Negative gate first: a known fatal marker gives us a more specific error
  // message than "no boot signal found" would. Both gates would fire on a
  // crash; preferring the negative one just makes the failure log clearer.
  for (const pattern of FATAL_PATTERNS) {
    if (pattern.test(captured)) {
      fail(`output matched ${pattern}`)
    }
  }

  // Positive gate: the binary must have rendered a known boot screen. This
  // is the load-bearing assertion — it catches *any* startup failure (silent
  // crashes, hangs, novel error messages, segfaults), not just the listed
  // fatals.
  const matchedSignal = BOOT_SIGNAL_PATTERNS.find((p) => p.test(captured))
  if (!matchedSignal) {
    fail(
      `binary never reached a known boot screen — checked ${BOOT_SIGNAL_PATTERNS.length} patterns`,
    )
  }

  console.log(
    `smoke-binary: OK (matched ${matchedSignal}, exit code ${earlyExitCode}, ${captured.length} bytes captured).`,
  )
}

main().catch((err: unknown) => {
  console.error('smoke-binary: unexpected error:', err)
  process.exit(2)
})
