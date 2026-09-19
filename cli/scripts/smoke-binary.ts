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
 * The positive check matters more than the negative one: a "did the boot
 * screen appear" assertion catches *any* startup failure — known fatals,
 * novel error messages, silent crashes, hangs, segfaults that produce no
 * output. Negative pattern matches are kept only for clearer diagnostics
 * when a known regression recurs.
 *
 * Designed to run on every supported platform (Linux, macOS, Windows) without
 * third-party deps. The binary doesn't need a TTY: OpenTUI emits ANSI escapes
 * to stdout regardless, and the static text we look for renders contiguously.
 *
 * It also proves the binary ignores dotenv files in the working directory
 * (see --no-compile-autoload-dotenv in build-binary.ts): `--smoke-api-url`
 * must print the same backend URL from a directory full of steering `.env*`
 * files as from an empty one.
 *
 * Usage:
 *   bun cli/scripts/smoke-binary.ts <path-to-binary> [seconds]
 *
 * Exits 0 if every stage passes, 1 otherwise.
 */

import { spawn } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve as resolvePath } from 'path'

import { RUNTIME_APP_URL_ENV_VARS } from '@codebuff/common/util/runtime-app-url'

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
//   - "Pick a model to start" — freebuff model-picker landing screen
//   - "Free mode isn't available" — freebuff country-block screen (CI
//     runners with anonymized-network egress like GitHub Actions land here)
//   - "Enter a coding task" — chat input prompt
//   - OpenTUI terminal handshakes such as alternate-screen / Kitty keyboard
//     protocol enablement. On Windows GitHub Actions, the compiled binary can
//     emit the OpenTUI setup escape stream but not flush static React text
//     before the smoke timeout; that still proves the renderer reached the
//     post-init terminal surface. Tree-sitter is checked separately above, and
//     fatal markers below still fail the smoke if async startup breaks later.
const BOOT_SIGNAL_PATTERNS = [
  /will run commands on your behalf/,
  /Pick a model to start/,
  /Free mode isn't available/,
  /Press ENTER to login/,
  /Open this URL/,
  /Enter a coding task/,
  /\x1b\[\?1049h/,
  /\x1b\[\?2031h/,
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

// Windows GitHub Actions runners intermittently hang the binary's startup
// *before any output* — the renderer never reaches its first write, so the
// run captures 0 bytes and trips the boot-signal gate. Healthy runs stream
// ~17KB (alt-screen escapes + the login screen) within the window. This is a
// runner-side flake, not a product regression: the same binary boots on the
// next attempt. Retry the boot attempt a few times so a single transient
// hang doesn't fail the build. Regression detection is preserved — a known
// fatal marker fails immediately (no retry), and a genuine boot failure
// still fails after exhausting every attempt.
const MAX_BOOT_ATTEMPTS = 3

// Upper bound for the one-shot probes (--smoke-tree-sitter, --smoke-api-url),
// which exit within seconds on a healthy runner. Without it a binary that
// never exits stalls the release job until the workflow timeout.
const PROBE_TIMEOUT_MS = 60_000

// Hosts the dotenv-isolation probes point at. `.invalid` is reserved
// (RFC 2606), so even a regression cannot reach a real server from CI.
const DOTENV_STEER_URL = 'https://dotenv-steer.invalid'
const ENV_OVERRIDE_URL = 'https://env-override.invalid'
// The files bun's dotenv autoload reads with NODE_ENV unset, as on CI runners
// (measured on bun 1.3.14; the .env.production* pair is not among them).
const DOTENV_FILENAMES = [
  '.env',
  '.env.development',
  '.env.development.local',
  '.env.local',
]
// Printed by the --smoke-api-url handler in cli/src/index.tsx.
const API_URL_MARKER = /^api-url smoke: (\S+)$/m

/** A stage that ran and judged the binary wrong — exit 1, not 2. */
class SmokeFailure extends Error {
  constructor(
    message: string,
    readonly captured?: string,
  ) {
    super(message)
  }
}

type Capture = {
  captured: string
  exitCode: number | null
  /** The binary was still running at `timeoutMs` and was SIGKILLed. */
  timedOut: boolean
}

/**
 * Spawn the binary, collect stdout+stderr, and SIGKILL it if it is still
 * running after `timeoutMs`. SIGKILL is the only signal that's portable across
 * Linux/macOS/Windows here; SIGTERM may be ignored by the renderer on some
 * platforms. `env` replaces the inherited environment when given.
 */
function spawnAndCapture(
  binary: string,
  args: string[],
  options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...(options.env ?? process.env), NO_COLOR: '1', TERM: 'dumb' },
    })

    let captured = ''
    const append = (chunk: Buffer): void => {
      captured += chunk.toString('utf8')
    }
    proc.stdout?.on('data', append)
    proc.stderr?.on('data', append)

    let timedOut = false
    const killTimer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, options.timeoutMs)

    proc.once('error', (err) => {
      clearTimeout(killTimer)
      reject(err)
    })
    proc.once('exit', (exitCode) => {
      clearTimeout(killTimer)
      resolve({ captured, exitCode, timedOut })
    })
  })
}

async function runTreeSitterSmoke(binary: string): Promise<void> {
  const { captured, exitCode, timedOut } = await spawnAndCapture(
    binary,
    ['--smoke-tree-sitter'],
    { timeoutMs: PROBE_TIMEOUT_MS },
  )
  if (timedOut) {
    throw new SmokeFailure(
      `--smoke-tree-sitter still running after ${PROBE_TIMEOUT_MS / 1000}s.`,
      captured,
    )
  }
  if (exitCode !== 0 || !/tree-sitter smoke ok/.test(captured)) {
    throw new SmokeFailure(`tree-sitter smoke exited ${exitCode}.`, captured)
  }
}

/**
 * Ask the binary which backend URL the SDK resolved. The runner's own
 * environment may carry the override variables (the build step exports
 * NEXT_PUBLIC_* for inlining), and a real variable beats a dotenv file, so
 * they are stripped unless `override` supplies one — otherwise the steered
 * run would pass for the wrong reason.
 */
async function probeApiUrl(
  binary: string,
  cwd: string,
  override?: string,
): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of RUNTIME_APP_URL_ENV_VARS) delete env[key]
  if (override !== undefined) env.NEXT_PUBLIC_CODEBUFF_APP_URL = override

  const { captured, exitCode, timedOut } = await spawnAndCapture(
    binary,
    ['--smoke-api-url'],
    { timeoutMs: PROBE_TIMEOUT_MS, cwd, env },
  )
  if (timedOut) {
    throw new SmokeFailure(
      `--smoke-api-url still running after ${PROBE_TIMEOUT_MS / 1000}s (cwd ${cwd}).`,
      captured,
    )
  }
  const url = API_URL_MARKER.exec(captured)?.[1]
  if (exitCode !== 0 || !url) {
    throw new SmokeFailure(
      `--smoke-api-url exited ${exitCode} without printing a URL (cwd ${cwd}).`,
      captured,
    )
  }
  return url
}

async function runDotenvIsolationSmoke(binary: string): Promise<void> {
  const cleanDir = mkdtempSync(join(tmpdir(), 'smoke-binary-clean-'))
  const steerDir = mkdtempSync(join(tmpdir(), 'smoke-binary-dotenv-'))
  try {
    const steer = RUNTIME_APP_URL_ENV_VARS.map(
      (key) => `${key}=${DOTENV_STEER_URL}\n`,
    ).join('')
    for (const name of DOTENV_FILENAMES)
      writeFileSync(join(steerDir, name), steer)

    const baseline = await probeApiUrl(binary, cleanDir)
    const steered = await probeApiUrl(binary, steerDir)
    if (steered !== baseline) {
      throw new SmokeFailure(
        `dotenv files in the working directory changed the API URL: ` +
          `${baseline} (clean dir) vs ${steered} (dir with .env*). ` +
          `build-binary.ts must pass --no-compile-autoload-dotenv.`,
      )
    }

    // Positive control: a real environment variable must still be honoured,
    // so the equality above is evidence of isolation rather than of a probe
    // that ignores env.
    const overridden = await probeApiUrl(binary, cleanDir, ENV_OVERRIDE_URL)
    if (overridden !== ENV_OVERRIDE_URL) {
      throw new SmokeFailure(
        `NEXT_PUBLIC_CODEBUFF_APP_URL in the environment was not honoured: ` +
          `printed ${overridden}, expected ${ENV_OVERRIDE_URL}.`,
      )
    }
  } finally {
    rmSync(cleanDir, { recursive: true, force: true })
    rmSync(steerDir, { recursive: true, force: true })
  }
}

type AttemptOutcome =
  | { kind: 'boot'; pattern: RegExp; bytes: number; exitCode: number | null }
  | {
      kind: 'fatal'
      pattern: RegExp
      captured: string
      exitCode: number | null
    }
  | { kind: 'no-signal'; captured: string; exitCode: number | null }

/**
 * Spawn the binary, let it run for the full window (so *late* async startup
 * failures still have time to surface through the renderer-cleanup handler),
 * then classify the captured output. Here the kill at the end of the window
 * is the expected exit, not a failure.
 */
async function runBootAttempt(
  binary: string,
  runSeconds: number,
): Promise<AttemptOutcome> {
  const { captured, exitCode } = await spawnAndCapture(binary, [], {
    timeoutMs: runSeconds * 1_000,
  })

  // Negative gate first: a known fatal marker gives us a more specific
  // error message than "no boot signal found" would.
  for (const pattern of FATAL_PATTERNS) {
    if (pattern.test(captured)) {
      return { kind: 'fatal', pattern, captured, exitCode }
    }
  }

  // Positive gate: the binary must have rendered a known boot screen.
  const matched = BOOT_SIGNAL_PATTERNS.find((p) => p.test(captured))
  if (matched) {
    return { kind: 'boot', pattern: matched, bytes: captured.length, exitCode }
  }

  return { kind: 'no-signal', captured, exitCode }
}

async function main(): Promise<void> {
  const binaryArg = process.argv[2]
  const runSeconds = Number(process.argv[3] ?? DEFAULT_RUN_SECONDS)

  if (!binaryArg) {
    console.error('Usage: bun smoke-binary.ts <path-to-binary> [seconds]')
    process.exit(2)
  }
  if (!existsSync(binaryArg)) {
    console.error(`smoke-binary: binary not found: ${binaryArg}`)
    process.exit(2)
  }
  if (!Number.isFinite(runSeconds) || runSeconds <= 0) {
    console.error(`smoke-binary: bad seconds arg: ${process.argv[3]}`)
    process.exit(2)
  }
  // CI passes `./freebuff`; the dotenv probes run from other directories.
  const binary = resolvePath(binaryArg)

  console.log(`smoke-binary: spawning ${binaryArg} for ${runSeconds}s…`)

  await runTreeSitterSmoke(binary)
  console.log('smoke-binary: tree-sitter init OK.')

  await runDotenvIsolationSmoke(binary)
  console.log('smoke-binary: working-directory dotenv files ignored OK.')

  let lastNoSignal: Extract<AttemptOutcome, { kind: 'no-signal' }> | null = null

  for (let attempt = 1; attempt <= MAX_BOOT_ATTEMPTS; attempt++) {
    console.log(
      `smoke-binary: boot attempt ${attempt}/${MAX_BOOT_ATTEMPTS} (running ${runSeconds}s)…`,
    )
    const outcome = await runBootAttempt(binary, runSeconds)

    if (outcome.kind === 'boot') {
      console.log(
        `smoke-binary: OK (matched ${outcome.pattern}, exit code ${outcome.exitCode}, ${outcome.bytes} bytes captured, attempt ${attempt}/${MAX_BOOT_ATTEMPTS}).`,
      )
      return
    }

    if (outcome.kind === 'fatal') {
      // Deterministic crash — a known fatal marker is a real regression, not a
      // flaky hang, so fail immediately without burning the remaining retries.
      throw new SmokeFailure(
        `output matched ${outcome.pattern} (exit code ${outcome.exitCode}).`,
        outcome.captured,
      )
    }

    // no-signal: the binary produced no recognizable boot screen. This is the
    // transient-Windows-hang shape; retry before giving up.
    lastNoSignal = outcome
    console.error(
      `smoke-binary: attempt ${attempt}/${MAX_BOOT_ATTEMPTS} produced no boot signal ` +
        `(${outcome.captured.length} bytes, exit code ${outcome.exitCode})` +
        (attempt < MAX_BOOT_ATTEMPTS ? '; retrying…' : '.'),
    )
  }

  throw new SmokeFailure(
    `binary never reached a known boot screen across ${MAX_BOOT_ATTEMPTS} attempts — ` +
      `checked ${BOOT_SIGNAL_PATTERNS.length} patterns (exit code ${lastNoSignal?.exitCode ?? null}).`,
    lastNoSignal?.captured ?? '',
  )
}

main().catch((err: unknown) => {
  if (err instanceof SmokeFailure) {
    console.error(`smoke-binary: FAIL — ${err.message}`)
    if (err.captured !== undefined) {
      console.error('--- captured output (truncated to 8KB) ---')
      console.error(err.captured.slice(0, 8 * 1024))
    }
    process.exit(1)
  }
  console.error('smoke-binary: unexpected error:', err)
  process.exit(2)
})
