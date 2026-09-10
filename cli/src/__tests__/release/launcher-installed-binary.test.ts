/**
 * The launcher's startup and background-update decisions must be driven by the
 * installed binary, not by the freebuff-metadata.json cache that records it.
 *
 * Regression: when the metadata file was missing or unreadable (a lost cache,
 * a cleaned ~/.config/manicode, an interrupted install), getCurrentVersion()
 * returned null and the launcher read that as "not installed" — re-downloading
 * the full platform binary on EVERY launch even though the correct binary was
 * sitting at ~/.config/manicode/freebuff, and hard-failing at startup when the
 * release host was unreachable. The metadata is only a cache of what was
 * installed; a lost cache must not cost a full re-download.
 */
import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const { createLauncher } = require('../../../release-core/launcher.js')

const VERSION = '0.0.172'
const NEXT_VERSION = '0.0.173'

let tempConfigDir: string

function makeLauncher(options: Record<string, unknown> = {}) {
  return createLauncher({
    packageName: 'freebuff',
    displayName: 'Freebuff',
    wrapperVersion: VERSION,
    includeTreeSitterWasm: false,
    configDir: tempConfigDir,
    ...options,
  }).__testing
}

/** The target this machine's launcher would select for a fresh install. */
function defaultTarget() {
  return `${process.platform}-${process.arch}`
}

/** Poll until `done()`, so tests wait on the event rather than on a timer. */
async function waitFor(done: () => boolean, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Capture process.exit: a relaunched child's handler firing after a test would
 * otherwise call the real process.exit and take the runner down. Output is
 * silenced so passing runs stay quiet.
 */
let restoreLauncherCapture = () => {}

function captureLauncherOutput() {
  const original = {
    error: console.error,
    write: process.stderr.write.bind(process.stderr),
    exit: process.exit,
  }
  console.error = () => {}
  ;(process.stderr as { write: unknown }).write = () => true
  ;(process as { exit: unknown }).exit = (code?: number) => {
    void code
  }
  return () => {
    console.error = original.error
    ;(process.stderr as { write: unknown }).write = original.write
    ;(process as { exit: unknown }).exit = original.exit
  }
}

/** A tar.gz holding a single binary named like this platform's install. */
function makeReleaseTarball(binaryName: string, script?: string) {
  const stageDir = mkdtempSync(join(tmpdir(), 'launcher-release-'))
  writeFileSync(
    join(stageDir, binaryName),
    script ? `#!/bin/sh\n${script}\n` : 'pretend binary',
    { mode: 0o755 },
  )
  const archive = join(stageDir, 'out.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', stageDir, binaryName])
  const contents = readFileSync(archive)
  rmSync(stageDir, { recursive: true, force: true })
  return contents
}

/**
 * A running CLI process the background update can stop: emits 'exit' when
 * killed and records that it was asked to stop.
 */
function makeStubProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    exitCode: number | null
    signalCode: string | null
    killed: boolean
    kill(signal: string): boolean
  }
  proc.exitCode = null
  proc.signalCode = null
  proc.killed = false
  proc.kill = (signal) => {
    proc.killed = true
    proc.emit('exit', 0, null)
    return true
  }
  return proc
}

/**
 * Stand-ins for the release host and the npm registry for one test. The
 * release server counts every tarball request; leave `tarball` unset to 404,
 * which the retry policy treats as final so failure paths fail fast. The
 * registry answers with `registryVersion` (null 404s, which getLatestVersion
 * turns into "no update available").
 */
async function withLocalServers(
  options: { registryVersion: string | null; tarball: Buffer | null },
  run: (requests: {
    downloadRequests: string[]
    registryRequests: string[]
  }) => Promise<void>,
) {
  const downloadRequests: string[] = []
  const registryRequests: string[] = []

  const releaseServer = createServer((request, response) => {
    downloadRequests.push(request.url ?? '')
    if (options.tarball && request.url?.includes('/api/releases/download/')) {
      response.writeHead(200)
      response.end(options.tarball)
    } else {
      response.writeHead(404)
      response.end('missing')
    }
  })
  const registryServer = createServer((request, response) => {
    registryRequests.push(request.url ?? '')
    if (options.registryVersion) {
      response.writeHead(200)
      response.end(JSON.stringify({ version: options.registryVersion }))
    } else {
      response.writeHead(404)
      response.end('missing')
    }
  })
  await new Promise<void>((resolve) =>
    releaseServer.listen(0, '127.0.0.1', resolve),
  )
  await new Promise<void>((resolve) =>
    registryServer.listen(0, '127.0.0.1', resolve),
  )
  const releasePort = (releaseServer.address() as AddressInfo).port
  const registryPort = (registryServer.address() as AddressInfo).port

  const previous = {
    app: process.env.NEXT_PUBLIC_CODEBUFF_APP_URL,
    registry: process.env.CODEBUFF_NPM_REGISTRY_URL,
    noProxy: process.env.NO_PROXY,
  }
  process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = `http://127.0.0.1:${releasePort}`
  process.env.CODEBUFF_NPM_REGISTRY_URL = `http://127.0.0.1:${registryPort}`
  process.env.NO_PROXY = '127.0.0.1'

  try {
    await run({ downloadRequests, registryRequests })
  } finally {
    if (previous.app === undefined) {
      delete process.env.NEXT_PUBLIC_CODEBUFF_APP_URL
    } else {
      process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = previous.app
    }
    if (previous.registry === undefined) {
      delete process.env.CODEBUFF_NPM_REGISTRY_URL
    } else {
      process.env.CODEBUFF_NPM_REGISTRY_URL = previous.registry
    }
    if (previous.noProxy === undefined) delete process.env.NO_PROXY
    else process.env.NO_PROXY = previous.noProxy
    await new Promise<void>((resolve, reject) =>
      releaseServer.close((error) => (error ? reject(error) : resolve())),
    )
    await new Promise<void>((resolve, reject) =>
      registryServer.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

beforeEach(() => {
  tempConfigDir = mkdtempSync(join(tmpdir(), 'launcher-installed-'))
  restoreLauncherCapture = captureLauncherOutput()
})

afterEach(() => {
  restoreLauncherCapture()
  rmSync(tempConfigDir, { recursive: true, force: true })
})

describe('an already-installed binary is not re-downloaded', () => {
  test('binary and metadata both present and current', async () => {
    const t = makeLauncher()
    writeFileSync(t.CONFIG.binaryPath, 'installed binary')
    writeFileSync(
      t.CONFIG.metadataPath,
      JSON.stringify({ version: VERSION, target: defaultTarget() }),
    )

    await withLocalServers(
      { registryVersion: null, tarball: null },
      async ({ downloadRequests }) => {
        await t.ensureBinaryReady()
        expect(downloadRequests).toHaveLength(0)
        expect(readFileSync(t.CONFIG.binaryPath, 'utf8')).toBe(
          'installed binary',
        )
      },
    )
  })

  test('binary present, metadata cache lost', async () => {
    const t = makeLauncher()
    writeFileSync(t.CONFIG.binaryPath, 'installed binary')

    await withLocalServers(
      { registryVersion: null, tarball: null },
      async ({ downloadRequests }) => {
        await t.ensureBinaryReady()
        expect(downloadRequests).toHaveLength(0)
        expect(readFileSync(t.CONFIG.binaryPath, 'utf8')).toBe(
          'installed binary',
        )
      },
    )
  })

  test('binary present, metadata cache corrupt', async () => {
    const t = makeLauncher()
    writeFileSync(t.CONFIG.binaryPath, 'installed binary')
    writeFileSync(t.CONFIG.metadataPath, 'not json{')

    await withLocalServers(
      { registryVersion: null, tarball: null },
      async ({ downloadRequests }) => {
        await t.ensureBinaryReady()
        expect(downloadRequests).toHaveLength(0)
        expect(readFileSync(t.CONFIG.binaryPath, 'utf8')).toBe(
          'installed binary',
        )
      },
    )
  })

  test('background check stands down when the cache is lost but nothing is newer', async () => {
    const t = makeLauncher()
    writeFileSync(t.CONFIG.binaryPath, 'installed binary')
    const runningProcess = makeStubProcess()

    await withLocalServers(
      { registryVersion: VERSION, tarball: null },
      async ({ downloadRequests, registryRequests }) => {
        await t.checkForUpdates(runningProcess, () => {})
        // It did consult the registry, and decided nothing was worth fetching.
        expect(registryRequests.length).toBeGreaterThan(0)
        expect(downloadRequests).toHaveLength(0)
        expect(runningProcess.killed).toBe(false)
      },
    )
  })

  test('background check stands down when binary and metadata are current', async () => {
    const t = makeLauncher()
    writeFileSync(t.CONFIG.binaryPath, 'installed binary')
    writeFileSync(
      t.CONFIG.metadataPath,
      JSON.stringify({ version: VERSION, target: defaultTarget() }),
    )
    const runningProcess = makeStubProcess()

    await withLocalServers(
      { registryVersion: VERSION, tarball: null },
      async ({ downloadRequests }) => {
        await t.checkForUpdates(runningProcess, () => {})
        expect(downloadRequests).toHaveLength(0)
        expect(runningProcess.killed).toBe(false)
      },
    )
  })
})

describe('the update comparison version', () => {
  test('prefers the verified version, then the wrapper, then nothing', () => {
    const t = makeLauncher()

    // Nothing installed: nothing to compare, the caller must download.
    expect(t.getUpdateComparisonVersion(null)).toBe(null)

    // Binary present but the cache is lost: the wrapper version is the best
    // available record of a binary this wrapper installed.
    writeFileSync(t.CONFIG.binaryPath, 'installed binary')
    expect(t.getUpdateComparisonVersion(null)).toBe(VERSION)

    // A verified version always wins over the wrapper fallback.
    writeFileSync(
      t.CONFIG.metadataPath,
      JSON.stringify({ version: '9.9.9', target: defaultTarget() }),
    )
    expect(t.getUpdateComparisonVersion('9.9.9')).toBe('9.9.9')
  })

  test('does not invent a comparison version without an installed binary', () => {
    const t = makeLauncher()
    expect(t.getUpdateComparisonVersion(null)).toBe(null)
  })
})

describe('download fallback behavior', () => {
  test('downloads when the binary is missing', async () => {
    const t = makeLauncher()
    writeFileSync(
      t.CONFIG.metadataPath,
      JSON.stringify({ version: '1.0.0', target: defaultTarget() }),
    )
    const tarball = makeReleaseTarball(t.CONFIG.binaryName)

    await withLocalServers(
      { registryVersion: null, tarball },
      async ({ downloadRequests }) => {
        await t.ensureBinaryReady()
        expect(downloadRequests).toHaveLength(1)
        expect(existsSync(t.CONFIG.binaryPath)).toBe(true)
        expect(
          JSON.parse(readFileSync(t.CONFIG.metadataPath, 'utf8')),
        ).toMatchObject({ version: VERSION })
      },
    )
  })

  test('downloads when there is no binary and no metadata', async () => {
    const t = makeLauncher()
    const tarball = makeReleaseTarball(t.CONFIG.binaryName)

    await withLocalServers(
      { registryVersion: null, tarball },
      async ({ downloadRequests }) => {
        await t.ensureBinaryReady()
        expect(downloadRequests).toHaveLength(1)
        expect(existsSync(t.CONFIG.binaryPath)).toBe(true)
      },
    )
  })

  // The relaunched "binary" is a POSIX shell script (see makeReleaseTarball),
  // which the launcher spawns directly and Windows cannot execute — so the
  // marker the relaunch writes would never appear there. The download, install,
  // and process-stop behavior this test proves is exercised on the platforms
  // CI runs; skip the relaunch on Windows.
  test.skipIf(process.platform === 'win32')(
    'background update still runs when the cache is lost but the wrapper is behind the registry',
    async () => {
      // The wrapper is a release behind the registry; the metadata cache is gone.
      // The wrapper version is the only record left of what was installed, and it
      // is older than the registry — so the update must still happen.
      const t = makeLauncher({ wrapperVersion: '0.0.171' })
      writeFileSync(t.CONFIG.binaryPath, 'installed binary')
      const marker = join(tempConfigDir, 'updated-ran')
      const tarball = makeReleaseTarball(
        t.CONFIG.binaryName,
        `echo ran > ${marker}`,
      )
      const runningProcess = makeStubProcess()

      await withLocalServers(
        { registryVersion: NEXT_VERSION, tarball },
        async ({ downloadRequests }) => {
          // checkForUpdates never resolves once it relaunches the CLI, so drive
          // the test off the relaunched binary's marker file instead; the
          // promise is only observed for its rejection.
          let updateError: unknown = null
          void t
            .checkForUpdates(runningProcess, () => {})
            .catch((error: unknown) => {
              updateError = error
            })
          await waitFor(() => existsSync(marker))
          expect(updateError).toBe(null)
          expect(downloadRequests).toHaveLength(1)
          expect(runningProcess.killed).toBe(true)
          expect(
            JSON.parse(readFileSync(t.CONFIG.metadataPath, 'utf8')),
          ).toMatchObject({ version: NEXT_VERSION })
        },
      )
    },
  )
})
