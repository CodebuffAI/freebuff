import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const require = createRequire(import.meta.url)

async function withLocalReleaseServer(
  response: {
    statusCode: number
    body: string | Buffer
    headers?: Record<string, string | number>
  },
  run: (requestedPaths: string[]) => Promise<void>,
) {
  const requestedPaths: string[] = []
  const server = createServer((request, serverResponse) => {
    requestedPaths.push(request.url ?? '')
    serverResponse.writeHead(response.statusCode, response.headers)
    serverResponse.end(response.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  const previousAppUrl = process.env.NEXT_PUBLIC_CODEBUFF_APP_URL
  const previousNoProxy = process.env.NO_PROXY
  const address = server.address() as AddressInfo
  process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = `http://127.0.0.1:${address.port}`
  process.env.NO_PROXY = '127.0.0.1'

  try {
    await run(requestedPaths)
  } finally {
    if (previousAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_CODEBUFF_APP_URL
    } else {
      process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = previousAppUrl
    }
    if (previousNoProxy === undefined) {
      delete process.env.NO_PROXY
    } else {
      process.env.NO_PROXY = previousNoProxy
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

const wrappers = [
  {
    name: 'codebuff',
    directory: 'cli/release',
    expectedConfig: {
      packageName: 'codebuff',
      displayName: 'Codebuff',
      tempDownloadDirName: '.download-temp',
    },
  },
  {
    name: 'codecane',
    directory: 'cli/release-staging',
    expectedConfig: {
      packageName: 'codecane',
      displayName: 'Codecane',
      includeTreeSitterWasm: false,
      telemetryProperties: { isStaging: true },
      tempDownloadDirName: '.download-temp-staging',
    },
  },
  {
    name: 'freebuff',
    directory: 'freebuff/cli/release',
    expectedConfig: {
      packageName: 'freebuff',
      displayName: 'Freebuff',
      telemetryEvent: 'cli.update_freebuff_failed',
    },
  },
]

for (const wrapper of wrappers) {
  describe(`${wrapper.name} release wrapper`, () => {
    test('contains only product configuration and package loading', () => {
      const wrapperModule = require(
        join(repoRoot, wrapper.directory, 'index.js'),
      )
      expect(wrapperModule.config).toMatchObject(wrapper.expectedConfig)
      const packageJson = JSON.parse(
        readFileSync(join(repoRoot, wrapper.directory, 'package.json'), 'utf8'),
      )
      expect(wrapperModule.config.wrapperVersion).toBe(packageJson.version)
    })

    test('has package-only lifecycle scripts', () => {
      const packageJson = JSON.parse(
        readFileSync(join(repoRoot, wrapper.directory, 'package.json'), 'utf8'),
      )
      expect(packageJson.scripts?.preinstall).toBeUndefined()
      expect(packageJson.scripts?.install).toBeUndefined()
      expect(packageJson.scripts?.postinstall).toBeUndefined()
      expect(packageJson.scripts?.preuninstall).toBeUndefined()
      expect(packageJson.scripts?.prepack).toContain('prepare-package.js')
      expect(packageJson.scripts?.postpack).toContain('prepare-package.js')
      expect(packageJson.files).toContain('launcher.js')
      expect(packageJson.files).toContain('http.js')
    })

    test('prefers its bundled launcher over a source-path collision', () => {
      const fixtureRoot = mkdtempSync(
        join(tmpdir(), `${wrapper.name}-wrapper-`),
      )
      const fixtureWrapperDir = join(fixtureRoot, wrapper.directory)
      const fixtureSourceDir = join(fixtureRoot, 'cli/release-core')

      try {
        mkdirSync(fixtureWrapperDir, { recursive: true })
        mkdirSync(fixtureSourceDir, { recursive: true })
        copyFileSync(
          join(repoRoot, wrapper.directory, 'index.js'),
          join(fixtureWrapperDir, 'index.js'),
        )
        copyFileSync(
          join(repoRoot, wrapper.directory, 'package.json'),
          join(fixtureWrapperDir, 'package.json'),
        )

        const fakeLauncher = (origin: string) => `
          module.exports = {
            createLauncher(config) {
              return { config, main: async () => {}, origin: '${origin}' }
            },
          }
        `
        writeFileSync(
          join(fixtureWrapperDir, 'launcher.js'),
          fakeLauncher('packaged'),
        )
        writeFileSync(
          join(fixtureSourceDir, 'launcher.js'),
          fakeLauncher('source'),
        )

        const wrapperModule = require(join(fixtureWrapperDir, 'index.js'))
        expect(wrapperModule.origin).toBe('packaged')
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true })
      }
    })
  })
}

describe('shared release launcher safety', () => {
  const launcherPath = join(repoRoot, 'cli/release-core/launcher.js')
  const { createLauncher } = require(launcherPath)

  test('stages an update before stopping the running process', () => {
    const source = readFileSync(launcherPath, 'utf8')
    const updateFunction = source.slice(
      source.indexOf('async function checkForUpdates'),
    )
    const stageIndex = updateFunction.indexOf(
      'const stagedBinary = await stageBinary',
    )
    const stopIndex = updateFunction.indexOf(
      'await stopRunningProcess(runningProcess)',
    )
    const installIndex = updateFunction.indexOf(
      'installStagedBinary(stagedBinary)',
    )

    expect(stageIndex).toBeGreaterThan(-1)
    expect(stopIndex).toBeGreaterThan(stageIndex)
    expect(installIndex).toBeGreaterThan(stopIndex)
  })

  test('requires the wrapper release only for missing or older binaries', () => {
    const cases: Array<{
      wrapperVersion: string
      expectations: Array<[current: string | null, required: string | null]>
    }> = [
      {
        wrapperVersion: '2.0.0',
        expectations: [
          [null, '2.0.0'],
          ['1.9.9', '2.0.0'],
          ['2.0.0-beta.7', '2.0.0'],
          ['2.0.0', null],
          ['2.1.0', null],
          ['02.0.0', '2.0.0'],
          ['2.0.0+cached', null],
        ],
      },
      {
        wrapperVersion: '2.0.0-beta.7',
        expectations: [
          ['2.0.0-beta.6', '2.0.0-beta.7'],
          ['2.0.0-beta.7', null],
          ['2.0.0-beta.8', null],
          ['2.0.0', null],
          ['2.0.0-beta.007', '2.0.0-beta.7'],
        ],
      },
      {
        wrapperVersion: '2.0.0-beta.9007199254740993',
        expectations: [
          ['2.0.0-beta.9007199254740992', '2.0.0-beta.9007199254740993'],
          ['2.0.0-beta.9007199254740994', null],
        ],
      },
    ]

    for (const { wrapperVersion, expectations } of cases) {
      const launcher = createLauncher({
        packageName: 'test',
        displayName: 'Test',
        wrapperVersion,
      })
      for (const [currentVersion, requiredVersion] of expectations) {
        expect(
          launcher.__testing.getRequiredWrapperVersion(currentVersion),
        ).toBe(requiredVersion)
      }
    }
  })

  test('repairs an older cached binary from the wrapper release', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'launcher-repair-'))
    const configDir = join(fixtureRoot, 'config')
    const archiveDir = join(fixtureRoot, 'archive')
    const archivePath = join(fixtureRoot, 'release.tar.gz')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(archiveDir, { recursive: true })

    const launcher = createLauncher({
      packageName: 'repair-test',
      displayName: 'Repair Test',
      wrapperVersion: '2.0.0',
      includeTreeSitterWasm: false,
      configDir,
    })
    const { CONFIG } = launcher.__testing
    writeFileSync(CONFIG.binaryPath, 'stale binary')
    writeFileSync(
      CONFIG.metadataPath,
      JSON.stringify({
        version: '1.0.0',
        target: process.platform + '-' + process.arch,
      }),
    )
    writeFileSync(join(archiveDir, CONFIG.binaryName), 'replacement binary')

    const tar = require('tar') as typeof import('tar')
    await tar.c({ cwd: archiveDir, file: archivePath, gzip: true }, [
      CONFIG.binaryName,
    ])
    const archive = readFileSync(archivePath)
    try {
      await withLocalReleaseServer(
        {
          statusCode: 200,
          body: archive,
          headers: {
            'content-length': archive.byteLength,
            'content-type': 'application/gzip',
          },
        },
        async (requestedPaths) => {
          await launcher.__testing.ensureBinaryReady()

          expect(readFileSync(CONFIG.binaryPath, 'utf8')).toBe(
            'replacement binary',
          )
          expect(
            JSON.parse(readFileSync(CONFIG.metadataPath, 'utf8')),
          ).toMatchObject({ version: '2.0.0' })
          expect(requestedPaths[0]).toContain('/api/releases/download/2.0.0/')

          await launcher.__testing.ensureBinaryReady()
          expect(requestedPaths).toHaveLength(1)
        },
      )
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  test('accepts only non-empty string metadata versions', () => {
    const launcher = createLauncher({
      packageName: 'test',
      displayName: 'Test',
      wrapperVersion: '2.0.0',
    })

    expect(launcher.__testing.getMetadataVersion({ version: 1 })).toBeNull()
    expect(launcher.__testing.getMetadataVersion({ version: '' })).toBeNull()
    expect(launcher.__testing.getMetadataVersion(null)).toBeNull()
  })

  test('keeps a runnable cached binary when repair is unavailable', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'launcher-offline-'))
    const launcher = createLauncher({
      packageName: 'offline-test',
      displayName: 'Offline Test',
      wrapperVersion: '2.0.0',
      includeTreeSitterWasm: false,
      configDir: fixtureRoot,
    })
    const { CONFIG } = launcher.__testing
    writeFileSync(CONFIG.binaryPath, 'cached binary')
    writeFileSync(
      CONFIG.metadataPath,
      JSON.stringify({
        version: '1.0.0',
        target: process.platform + '-' + process.arch,
      }),
    )

    try {
      await withLocalReleaseServer(
        { statusCode: 404, body: 'missing' },
        async () => {
          await launcher.__testing.ensureBinaryReady()
          expect(readFileSync(CONFIG.binaryPath, 'utf8')).toBe('cached binary')
          expect(
            JSON.parse(readFileSync(CONFIG.metadataPath, 'utf8')),
          ).toMatchObject({ version: '1.0.0' })
        },
      )
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  test('gives the binary its launcher pid', () => {
    const source = readFileSync(launcherPath, 'utf8')
    const spawnFunction = source.slice(
      source.indexOf('function spawnInstalledBinary'),
      source.indexOf('function watchLaunch'),
    )
    expect(spawnFunction).not.toBe('')

    expect(spawnFunction).toContain(
      'CODEBUFF_LAUNCHER_PID: String(process.pid)',
    )
    // stderr is teed on Windows to keep native-crash output (see watchLaunch),
    // but stdin/stdout must stay inherited or the TUI loses its tty.
    expect(spawnFunction).toContain("['inherit', 'inherit', 'pipe']")
    expect(spawnFunction).toContain("['inherit', 'inherit', 'inherit']")
  })

  test('cleans up process-stop listeners and timers', async () => {
    const { stopRunningProcess } = createLauncher({
      packageName: 'test',
      displayName: 'Test',
    })
    const runningProcess = new EventEmitter() as EventEmitter & {
      kill(signal: string): boolean
    }
    const signals: string[] = []
    runningProcess.kill = (signal) => {
      signals.push(signal)
      runningProcess.emit('exit', 0, null)
      return true
    }

    await stopRunningProcess(runningProcess)

    expect(signals).toEqual(['SIGTERM'])
    expect(runningProcess.listenerCount('exit')).toBe(0)
  })

  test('cleans up when stopping the process throws', async () => {
    const { stopRunningProcess } = createLauncher({
      packageName: 'test',
      displayName: 'Test',
    })
    const runningProcess = new EventEmitter() as EventEmitter & {
      kill(signal: string): boolean
    }
    runningProcess.kill = () => {
      throw new Error('kill failed')
    }

    await expect(stopRunningProcess(runningProcess)).rejects.toThrow(
      'kill failed',
    )
    expect(runningProcess.listenerCount('exit')).toBe(0)
  })

  test('directs crash reports to the product repository issues tracker', () => {
    const freebuffLauncher = createLauncher({
      packageName: 'freebuff',
      displayName: 'Freebuff',
    })
    const codebuffLauncher = createLauncher({
      packageName: 'codebuff',
      displayName: 'Codebuff',
    })

    const freebuffErrors: string[] = []
    const codebuffErrors: string[] = []

    const originalConsoleError = console.error
    try {
      console.error = (...args: unknown[]) => {
        freebuffErrors.push(args.join(' '))
      }
      freebuffLauncher.__testing.printCrashDiagnostics(null, 'SIGSEGV')

      console.error = (...args: unknown[]) => {
        codebuffErrors.push(args.join(' '))
      }
      codebuffLauncher.__testing.printCrashDiagnostics(null, 'SIGSEGV')
    } finally {
      console.error = originalConsoleError
    }

    expect(
      freebuffErrors.some((line) =>
        line.includes('https://github.com/CodebuffAI/freebuff/issues'),
      ),
    ).toBe(true)
    expect(
      freebuffErrors.some((line) =>
        line.includes('https://github.com/CodebuffAI/codebuff/issues'),
      ),
    ).toBe(false)

    expect(
      codebuffErrors.some((line) =>
        line.includes('https://github.com/CodebuffAI/codebuff/issues'),
      ),
    ).toBe(true)
  })
})
