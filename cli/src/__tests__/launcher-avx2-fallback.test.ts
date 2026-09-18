/**
 * The Windows AVX2 path is optimistic-then-corrected: we assume AVX2 rather
 * than probing for it, because the probe used to be a PowerShell one-liner that
 * compiled a C# stub and P/Invoked kernel32!IsProcessorFeaturePresent — which
 * Windows Defender flagged as a "Suspicious PowerShell command line".
 *
 * That trade is only acceptable if the correction is airtight: a machine
 * without AVX2 must pay exactly ONE failed launch. These tests pin that down,
 * since no CI runner can actually lack AVX2.
 *
 * The correction has to fire on BOTH Windows spellings of the failure. It
 * originally only knew STATUS_ILLEGAL_INSTRUCTION, so the machines in
 * codebuff#792 — which die on Bun's Zig panic, 0xC0000409 — crash-looped
 * forever instead.
 */
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'

import { ensureCliTestEnv } from './test-utils'

ensureCliTestEnv()

const { createLauncher } = require('../../release-core/launcher.js')

let tempConfigDir: string
let originalPlatform: PropertyDescriptor | undefined
let originalArch: PropertyDescriptor | undefined

/**
 * configDir is injected rather than faked through $HOME: under `bun test`,
 * os.homedir() ignores $HOME, so a test that only set HOME would silently read
 * and WRITE the developer's real ~/.config/manicode/cpu-features.json.
 *
 * platform AND arch are both faked: the branch under test is win32-only, and
 * detectMachineHasAvx2 returns early for any non-x64 arch — so on the arm64
 * runners these tests would otherwise pass without executing a line of it.
 */
function makeLauncher(
  platform: NodeJS.Platform = 'win32',
  arch: string = 'x64',
) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  })
  Object.defineProperty(process, 'arch', { value: arch, configurable: true })
  return createLauncher({
    packageName: 'freebuff',
    configDir: tempConfigDir,
    // The wrapper shares the installed version, so the archive checksums come
    // from its own manifest — `releaseChecksums`, filled by the test — and
    // never from a registry lookup.
    wrapperVersion: '1.2.3',
    binaryChecksums: releaseChecksums,
  }).__testing
}

/** Poll until `done()`, so tests wait on the event rather than on a timer. */
async function waitFor(done: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Everything the launcher says and every exit it attempts. Capturing exit
 * matters beyond the assertions: a relaunched child's handler firing after a
 * test would otherwise call the real process.exit and take the runner down.
 */
const launcher = {
  lines: [] as string[],
  exitCodes: [] as (number | undefined)[],
}
let restoreLauncherCapture = () => {}

function captureLauncherOutput() {
  const original = {
    error: console.error,
    write: process.stderr.write.bind(process.stderr),
    exit: process.exit,
  }
  launcher.lines = []
  launcher.exitCodes = []
  console.error = (...args: unknown[]) => launcher.lines.push(args.join(' '))
  ;(process.stderr as { write: unknown }).write = () => true
  ;(process as { exit: unknown }).exit = (code?: number) => {
    launcher.exitCodes.push(code)
  }
  return () => {
    console.error = original.error
    ;(process.stderr as { write: unknown }).write = original.write
    ;(process as { exit: unknown }).exit = original.exit
  }
}

/** A tar.gz holding a single `freebuff.exe` that runs `script`. */
function baselineTarball(script: string) {
  const stageDir = mkdtempSync(join(tmpdir(), 'launcher-baseline-'))
  writeFileSync(join(stageDir, 'freebuff.exe'), `#!/bin/sh\n${script}\n`, {
    mode: 0o755,
  })
  const archive = join(stageDir, 'out.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', stageDir, 'freebuff.exe'])
  return readFileSync(archive)
}

/**
 * Stands in for the release host for the whole file. Tests that want a working
 * fallback set `releaseTarball`; leaving it unset 404s, which the retry policy
 * treats as final — so failure paths fail fast instead of backing off.
 */
let releaseTarball: Buffer | null = null
/**
 * What the wrapper's package.json says the baseline archive hashes to. A
 * placeholder by default so a download is attempted (and 404s) as it always
 * did; `serveBaselineTarball` replaces it with the real digest.
 */
let releaseChecksums: Record<string, string> = {}
let releaseServer: ReturnType<typeof createServer>

function serveBaselineTarball(script: string) {
  releaseTarball = baselineTarball(script)
  releaseChecksums['win32-x64-baseline'] = createHash('sha256')
    .update(releaseTarball)
    .digest('hex')
}
let restoreReleaseEnv = () => {}

beforeAll(async () => {
  releaseServer = createServer((request, response) => {
    const wantsBaseline = request.url?.endsWith(
      'freebuff-win32-x64-baseline.tar.gz',
    )
    if (releaseTarball && wantsBaseline) {
      response.writeHead(200)
      response.end(releaseTarball)
    } else {
      response.writeHead(404)
      response.end('missing')
    }
  })
  await new Promise<void>((resolve) =>
    releaseServer.listen(0, '127.0.0.1', resolve),
  )
  const { port } = releaseServer.address() as AddressInfo
  const original = {
    app: process.env.NEXT_PUBLIC_CODEBUFF_APP_URL,
    noProxy: process.env.NO_PROXY,
  }
  process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = `http://127.0.0.1:${port}`
  process.env.NO_PROXY = '127.0.0.1'
  restoreReleaseEnv = () => {
    if (original.app === undefined) {
      delete process.env.NEXT_PUBLIC_CODEBUFF_APP_URL
    } else {
      process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = original.app
    }
    if (original.noProxy === undefined) delete process.env.NO_PROXY
    else process.env.NO_PROXY = original.noProxy
  }
})

afterAll(async () => {
  restoreReleaseEnv()
  await new Promise<void>((resolve) => releaseServer.close(() => resolve()))
})

beforeEach(() => {
  tempConfigDir = mkdtempSync(join(tmpdir(), 'launcher-avx2-'))
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  originalArch = Object.getOwnPropertyDescriptor(process, 'arch')
  releaseTarball = null
  releaseChecksums = { 'win32-x64-baseline': '0'.repeat(64) }
  restoreLauncherCapture = captureLauncherOutput()
})

afterEach(() => {
  restoreLauncherCapture()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  if (originalArch) Object.defineProperty(process, 'arch', originalArch)
  rmSync(tempConfigDir, { recursive: true, force: true })
})

describe('windows AVX2 detection', () => {
  test('assumes AVX2 on a machine it knows nothing about', () => {
    const t = makeLauncher()
    // The point of the change: no probe, no subprocess, just an optimistic yes.
    expect(t.detectMachineHasAvx2()).toBe(true)
    expect(t.readCachedAvx2()).toBe(null)
  })

  test('picks the optimized target while the answer is unknown', () => {
    const t = makeLauncher()
    expect(t.getDefaultTargetKey()).toBe('win32-x64')
  })

  test('recording a failure flips the answer and persists it', () => {
    const t = makeLauncher()
    t.recordMachineLacksAvx2()

    expect(t.detectMachineHasAvx2()).toBe(false)
    expect(t.readCachedAvx2()).toBe(false)
    expect(
      JSON.parse(readFileSync(t.getCpuFeatureCachePath(), 'utf8')),
    ).toEqual({ avx2: false })
  })

  test('a recorded failure selects baseline up front on the NEXT launch', () => {
    const first = makeLauncher()
    first.recordMachineLacksAvx2()

    // A brand-new launcher over the same HOME — i.e. the next process.
    const second = makeLauncher()
    expect(second.detectMachineHasAvx2()).toBe(false)
    expect(second.getDefaultTargetKey()).toBe('win32-x64-baseline')
  })

  test('a corrupt cache file is ignored rather than throwing', () => {
    const t = makeLauncher()
    const cachePath = t.getCpuFeatureCachePath()
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, 'not json{')

    expect(t.readCachedAvx2()).toBe(null)
    expect(t.detectMachineHasAvx2()).toBe(true)
  })

  test('a cache file without an avx2 boolean is ignored', () => {
    const t = makeLauncher()
    const cachePath = t.getCpuFeatureCachePath()
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify({ avx2: 'yes' }))

    expect(t.readCachedAvx2()).toBe(null)
    expect(t.detectMachineHasAvx2()).toBe(true)
  })

  test('a recorded failure outranks CPU inference on linux too', () => {
    // Without the recorded answer this comes back true either way — a linux
    // runner advertises avx2, and on a mac runner the /proc/cpuinfo read throws
    // and defaults to true. Either way the recorded crash has to win: a binary
    // that actually died with SIGILL beats parsing a flags line.
    const t = makeLauncher('linux')
    expect(t.detectMachineHasAvx2()).toBe(true)

    t.recordMachineLacksAvx2()
    expect(makeLauncher('linux').detectMachineHasAvx2()).toBe(false)
    expect(makeLauncher('linux').getDefaultTargetKey()).toBe(
      'linux-x64-baseline',
    )
  })

  test('a cached true does not send us to baseline', () => {
    const t = makeLauncher()
    const cachePath = t.getCpuFeatureCachePath()
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify({ avx2: true }))

    expect(t.detectMachineHasAvx2()).toBe(true)
    expect(t.getDefaultTargetKey()).toBe('win32-x64')
  })
})

describe('recovery after a recorded failure', () => {
  /** Simulate a completed install of `target` at `version`. */
  function installBinary(t: ReturnType<typeof makeLauncher>, target: string) {
    writeFileSync(
      t.CONFIG.metadataPath,
      JSON.stringify({ version: '1.2.3', target }),
    )
    writeFileSync(t.CONFIG.binaryPath, 'pretend binary')
  }

  // This is the whole "costs one crash ever" claim. Recording the failure has
  // to invalidate the ALREADY-INSTALLED optimized binary, or the next launch
  // would happily re-run the exact binary that just died and crash again.
  test('the installed AVX2 binary stops counting as usable', () => {
    const first = makeLauncher()
    installBinary(first, 'win32-x64')
    expect(first.getCurrentVersion()).toBe('1.2.3')

    first.recordMachineLacksAvx2()

    const next = makeLauncher()
    expect(next.isTargetAllowedForThisMachine('win32-x64')).toBe(false)
    // null forces ensureBinaryExists() to re-download, and getDownloadTargetKey
    // then resolves to baseline.
    expect(next.getCurrentVersion()).toBe(null)
    expect(next.getDefaultTargetKey()).toBe('win32-x64-baseline')
  })

  test('an installed baseline binary keeps working after the record', () => {
    const first = makeLauncher()
    first.recordMachineLacksAvx2()
    installBinary(first, 'win32-x64-baseline')

    const next = makeLauncher()
    // Nothing should invalidate the binary we just fell back to, or the CLI
    // would re-download it on every single launch.
    expect(next.isTargetAllowedForThisMachine('win32-x64-baseline')).toBe(true)
    expect(next.getCurrentVersion()).toBe('1.2.3')
  })
})

describe('illegal-instruction detection', () => {
  test('recognizes STATUS_ILLEGAL_INSTRUCTION on windows', () => {
    const t = makeLauncher()
    // Node surfaces the NTSTATUS as a signed 32-bit int; both spellings must
    // count, because which one arrives depends on how the child was reaped.
    expect(t.isIllegalInstructionExit(0xc000001d, null)).toBe(true)
    expect(t.isIllegalInstructionExit(-1073741795, null)).toBe(true)
  })

  test('does not treat ordinary failures as an AVX2 problem', () => {
    const t = makeLauncher()
    // A false positive here would permanently pin a capable machine to the
    // slower baseline build, so the guard matters.
    expect(t.isIllegalInstructionExit(1, null)).toBe(false)
    expect(t.isIllegalInstructionExit(0, null)).toBe(false)
    // Access violation and stack overflow are native crashes, but not this one.
    expect(t.isIllegalInstructionExit(0xc0000005, null)).toBe(false)
    expect(t.isIllegalInstructionExit(0xc0000409, null)).toBe(false)
  })

  test('honors SIGILL on POSIX', () => {
    const t = makeLauncher('linux')
    expect(t.isIllegalInstructionExit(null, 'SIGILL')).toBe(true)
    expect(t.isIllegalInstructionExit(null, 'SIGTERM')).toBe(false)
  })

  test('does not read the windows status code on POSIX', () => {
    const t = makeLauncher('linux')
    // 0xc000001d is a plausible ordinary exit code elsewhere; only Windows
    // should read it as an illegal instruction.
    expect(t.isIllegalInstructionExit(0xc000001d, null)).toBe(false)
  })
})
/**
 * The reported crash (codebuff#792) is 3221226505 / 0xC0000409, not the
 * illegal-instruction code the fallback was wired to. Bun panics through Zig's
 * __fastfail on Windows, so a CPU that can't run the optimized build reports
 * STATUS_STACK_BUFFER_OVERRUN instead — and those users crash-looped forever.
 */
describe('windows startup-abort detection', () => {
  test('recognizes an immediate 0xC0000409 as a CPU-feature suspect', () => {
    const t = makeLauncher()
    expect(t.isStartupCpuFeatureCrash(0xc0000409, null, 40)).toBe(true)
    // Node surfaces the NTSTATUS signed, same as the SIGILL spelling.
    expect(t.isStartupCpuFeatureCrash(-1073740791, null, 40)).toBe(true)
  })

  test('a crash long after startup is an ordinary bug, not the CPU', () => {
    const t = makeLauncher()
    // This is the guard that keeps a mid-session Bun panic from banishing a
    // capable machine to the slower build.
    expect(t.isStartupCpuFeatureCrash(0xc0000409, null, 60_000)).toBe(false)
    // An unwatched child reports Infinity rather than a suspiciously young age.
    expect(t.isStartupCpuFeatureCrash(0xc0000409, null, Infinity)).toBe(false)
  })

  test('other native crashes and signals are not this one', () => {
    const t = makeLauncher()
    expect(t.isStartupCpuFeatureCrash(0xc0000005, null, 40)).toBe(false)
    expect(t.isStartupCpuFeatureCrash(0xc000001d, null, 40)).toBe(false)
    expect(t.isStartupCpuFeatureCrash(1, null, 40)).toBe(false)
    expect(t.isStartupCpuFeatureCrash(0xc0000409, 'SIGTERM', 40)).toBe(false)
  })

  test('does not read the windows status code on POSIX', () => {
    const t = makeLauncher('linux')
    expect(t.isStartupCpuFeatureCrash(0xc0000409, null, 40)).toBe(false)
  })
})

describe('what the fallback persists', () => {
  /** Simulate a completed install of `target` at `version`. */
  function installBinary(t: ReturnType<typeof makeLauncher>, target: string) {
    writeFileSync(
      t.CONFIG.metadataPath,
      JSON.stringify({ version: '1.2.3', target }),
    )
    writeFileSync(t.CONFIG.binaryPath, 'pretend binary')
  }

  // Downloads 404 here (releaseTarball is left unset), which the retry policy
  // treats as final — so the fallback fails fast and each test sees only what
  // was written on the way there.
  test('a confirmed illegal instruction records the CPU verdict', async () => {
    const t = makeLauncher()
    installBinary(t, 'win32-x64')

    expect(await t.tryFallbackToBaseline(0xc000001d, null, 40)).toBe(false)
    // Recorded before the download so a failed download can't resurrect the
    // AVX2 build.
    expect(t.readCachedAvx2()).toBe(false)
  })

  test('a merely suspected abort records nothing about the CPU', async () => {
    const t = makeLauncher()
    installBinary(t, 'win32-x64')

    expect(await t.tryFallbackToBaseline(0xc0000409, null, 40)).toBe(false)
    // 0xC0000409 is "the binary aborted", which an unrelated bug can also
    // produce. Writing avx2:false here would leave the next crash report
    // asserting a CPU limitation nobody ever observed.
    expect(t.readCachedAvx2()).toBe(null)
  })

  test('does not fight an explicitly chosen target', async () => {
    const t = makeLauncher()
    installBinary(t, 'win32-x64')
    process.env.FREEBUFF_BINARY_TARGET = 'win32-x64'
    try {
      expect(await t.tryFallbackToBaseline(0xc000001d, null, 40)).toBe(false)
      expect(t.readCachedAvx2()).toBe(null)
    } finally {
      delete process.env.FREEBUFF_BINARY_TARGET
    }
  })

  test('gives up instead of looping when baseline crashes too', async () => {
    const t = makeLauncher()
    installBinary(t, 'win32-x64-baseline')
    expect(await t.tryFallbackToBaseline(0xc0000409, null, 40)).toBe(false)
  })
})

describe('the crash report a windows user sees', () => {
  /** Install a "binary" that runs `script` and dies, plus its metadata. */
  function installCrashingBinary(
    t: ReturnType<typeof makeLauncher>,
    target: string,
    script: string,
  ) {
    writeFileSync(t.CONFIG.binaryPath, `#!/bin/sh\n${script}\nexit 3\n`, {
      mode: 0o755,
    })
    writeFileSync(
      t.CONFIG.metadataPath,
      JSON.stringify({ version: '1.2.3', target }),
    )
  }

  /**
   * Run a launch to completion, then replay the reported NTSTATUS through the
   * very listener a real crash reaches. The child can't return an NTSTATUS on
   * this platform, so the code is the one thing that has to be synthetic.
   */
  async function crashWith(
    t: ReturnType<typeof makeLauncher>,
    code: number,
  ): Promise<void> {
    const child = t.spawnInstalledBinary()
    await new Promise((resolve) => child.once('close', resolve))
    await t.attachExitHandler(child)(code, null)
  }

  test('keeps the panic text and names the CPU', async () => {
    const t = makeLauncher()
    // A "binary" that panics on startup the way Bun does on a non-AVX2 CPU,
    // already on baseline so the fallback declines and we reach the report.
    installCrashingBinary(
      t,
      'win32-x64-baseline',
      'echo "panic(main thread): attempt to use null value" >&2\n' +
        'echo "CPU lacks AVX support." >&2',
    )

    await crashWith(t, 0xc0000409)

    const output = launcher.lines.join('\n')
    expect(output).toContain('exited immediately (code 3221226505)')
    expect(output).toContain('aborted while starting up')
    // Without the tee this is gone: the terminal reset leaves the alternate
    // screen, discarding whatever the binary printed into it.
    expect(output).toContain('panic(main thread): attempt to use null value')
    expect(output).toContain('already the older-CPU (baseline) build')
    expect(launcher.exitCodes).toContain(0xc0000409)
  })

  test('points a standard-build machine at the baseline override', async () => {
    const t = makeLauncher()
    installCrashingBinary(t, 'win32-x64', 'true')
    // The fallback is what normally handles this; the hint is the escape hatch
    // for when it can't (no network, a download that keeps failing).
    t.recordMachineLacksAvx2()

    await crashWith(t, 0xc0000409)

    const output = launcher.lines.join('\n')
    expect(output).toContain('without AVX2 support')
    expect(output).toContain('FREEBUFF_BINARY_TARGET=win32-x64-baseline')
    expect(output).toContain('AVX2:     no (recorded crash)')
  })

  test('never claims AVX2 is present on a machine it never asked', async () => {
    const t = makeLauncher()
    installCrashingBinary(t, 'win32-x64', 'true')

    await crashWith(t, 0xc0000409)

    // The three reports on codebuff#792 all read "AVX2: yes" from an
    // assumption, which is precisely the line that would have named the cause.
    expect(launcher.lines.join('\n')).toContain(
      'AVX2:     not checked (assumed present)',
    )
  })

  test('a long-lived abort is reported as an ordinary crash', async () => {
    const t = makeLauncher()
    installCrashingBinary(t, 'win32-x64', 'true')

    const child = t.spawnInstalledBinary()
    await new Promise((resolve) => child.once('close', resolve))
    child.launch.msAlive = () => 60_000
    await t.attachExitHandler(child)(0xc0000409, null)

    const output = launcher.lines.join('\n')
    expect(output).toContain('crashed with an abort signal')
    expect(output).not.toContain('without AVX2 support')
    expect(output).not.toContain('FREEBUFF_BINARY_TARGET=')
  })

  test('never lets captured escapes undo the terminal reset', async () => {
    const t = makeLauncher()
    // The report is printed after resetTerminal(), so replaying a mode-set
    // escape verbatim would re-enter the alternate screen and hide it.
    installCrashingBinary(
      t,
      'win32-x64-baseline',
      String.raw`printf "\033[?1049h\033[?1003h\033[31mpanic: boom\033[0m\r\n" >&2`,
    )

    await crashWith(t, 0xc0000409)

    const output = launcher.lines.join('\n')
    expect(output).toContain('panic: boom')
    expect(output).not.toContain('\x1b')
    expect(output).not.toContain('\r')
  })

  test('the drained wait settles without leaning on a timer', async () => {
    const t = makeLauncher()
    installCrashingBinary(t, 'win32-x64-baseline', 'echo late >&2')

    const child = t.spawnInstalledBinary()
    await new Promise((resolve) => child.once('close', resolve))

    // Regression: this used to be resolvable only by an unref'd timer, which
    // lets node exit first — the crash report vanished and the launcher exited
    // 0. An already-drained stream has to resolve on the microtask queue.
    const settled = await Promise.race([
      child.launch.drained().then(() => 'drained'),
      new Promise((resolve) => setImmediate(() => resolve('timer'))),
    ])
    expect(settled).toBe('drained')
  })

  test('keeps only the tail of a chatty binary', async () => {
    const t = makeLauncher()
    installCrashingBinary(
      t,
      'win32-x64-baseline',
      'i=0; while [ $i -lt 3000 ]; do echo "line $i" >&2; i=$((i+1)); done',
    )

    await crashWith(t, 0xc0000409)

    const output = launcher.lines.join('\n')
    // A runaway logger must not turn the crash report into megabytes.
    expect(output).toContain('line 2999')
    expect(output).not.toContain('line 0\n')
    expect(output.length).toBeLessThan(12_000)
  })
})

/**
 * The whole point, end to end: a machine that dies with the reported code must
 * come back up on the baseline build without the user doing anything.
 */
describe('recovering from the reported crash', () => {
  test('0xC0000409 during startup lands the user on the baseline build', async () => {
    const t = makeLauncher()
    const ranMarker = join(tempConfigDir, 'baseline-ran')
    serveBaselineTarball(`echo ran > ${ranMarker}`)

    writeFileSync(t.CONFIG.binaryPath, '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    writeFileSync(
      t.CONFIG.metadataPath,
      JSON.stringify({ version: '1.2.3', target: 'win32-x64' }),
    )

    const child = t.spawnInstalledBinary()
    await new Promise((resolve) => child.once('close', resolve))
    await t.attachExitHandler(child)(0xc0000409, null)
    // The relaunched binary runs asynchronously; wait for ITS exit handler
    // rather than for a timer, so the test never outlives its own children.
    await waitFor(() => launcher.exitCodes.length > 0)

    // Before the fix the fallback declined, so the listener fell through to the
    // crash report and exited with the crash code.
    expect(launcher.exitCodes).not.toContain(0xc0000409)
    // Installed, recorded, and actually run.
    expect(
      JSON.parse(readFileSync(t.CONFIG.metadataPath, 'utf8')),
    ).toMatchObject({ target: 'win32-x64-baseline' })
    expect(existsSync(ranMarker)).toBe(true)
    // A suspicion, so still nothing written about the CPU itself.
    expect(t.readCachedAvx2()).toBe(null)
    // The next launch keeps that binary instead of re-downloading it.
    const next = makeLauncher()
    expect(next.isTargetAllowedForThisMachine('win32-x64-baseline')).toBe(true)
    expect(next.getCurrentVersion()).toBe('1.2.3')
  }, 20000)
})

describe('the background update check', () => {
  test('stands down when the process it watches is already gone', async () => {
    const t = makeLauncher()
    // main() schedules this 100ms after launch, so a startup crash that handed
    // off to the baseline fallback leaves it holding a corpse. Carrying on
    // from there races that relaunch for the shared temp download directory,
    // then burns six seconds SIGKILLing a process that already exited.
    const settled = await Promise.race([
      t
        .checkForUpdates({ exitCode: 3, signalCode: null })
        .then(() => 'stood down'),
      new Promise((resolve) => setImmediate(() => resolve('kept going'))),
    ])
    expect(settled).toBe('stood down')
  })
})
