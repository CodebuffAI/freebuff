import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { createLauncher } = require('../../../release-core/launcher.js')
const tar = require('tar') as typeof import('tar')

class RunningCli extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  signals: string[] = []

  kill(signal: string) {
    this.signals.push(signal)
    throw new Error('An update must not stop the running CLI')
  }
}

async function withFixture(
  run: (fixture: {
    child: RunningCli
    config: {
      binaryPath: string
      metadataPath: string
      tempDownloadDir: string
    }
    check: (checksum?: string) => Promise<void>
    finish: (code?: number) => Promise<void>
    exits: number[]
    output: string[]
    errors: string[]
    setInstalled: (version: string) => void
    pauseDownload: () => { started: Promise<void>; resume: () => void }
  }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), 'freebuff-deferred-update-'))
  const configDir = join(root, 'config')
  const archiveDir = join(root, 'archive')
  mkdirSync(configDir)
  mkdirSync(archiveDir)
  const binaryName = process.platform === 'win32' ? 'freebuff.exe' : 'freebuff'
  const target = `${process.platform}-${process.arch}`
  writeFileSync(join(archiveDir, binaryName), 'new binary')
  writeFileSync(join(archiveDir, 'tree-sitter.wasm'), 'new wasm')
  const archivePath = join(root, 'release.tar.gz')
  await tar.c({ cwd: archiveDir, file: archivePath, gzip: true }, [
    binaryName,
    'tree-sitter.wasm',
  ])
  const archive = readFileSync(archivePath)
  const checksum = createHash('sha256').update(archive).digest('hex')
  let downloadGate = Promise.resolve()
  let downloadStarted = () => {}
  const server = createServer(async (_request, response) => {
    downloadStarted()
    await downloadGate
    response.writeHead(200, { 'content-length': archive.length })
    response.end(archive)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const originalEnv = {
    app: process.env.NEXT_PUBLIC_CODEBUFF_APP_URL,
    proxy: process.env.NO_PROXY,
    target: process.env.FREEBUFF_BINARY_TARGET,
  }
  process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.NO_PROXY = '127.0.0.1'
  process.env.FREEBUFF_BINARY_TARGET = target
  const output: string[] = []
  const errors: string[] = []
  const exits: number[] = []
  const originals = {
    log: console.log,
    error: console.error,
    exit: process.exit,
  }
  console.log = (...args) => output.push(args.join(' '))
  console.error = (...args) => errors.push(args.join(' '))
  process.exit = ((code: number) => {
    exits.push(code)
  }) as typeof process.exit

  try {
    const launcher = createLauncher({
      packageName: 'freebuff',
      displayName: 'Freebuff',
      configDir,
      deferUpdatesUntilExit: true,
    }).__testing
    const config = launcher.CONFIG
    const setInstalled = (version: string) => {
      writeFileSync(config.binaryPath, `binary ${version}`)
      writeFileSync(config.metadataPath, JSON.stringify({ version, target }))
      writeFileSync(join(configDir, 'tree-sitter.wasm'), `wasm ${version}`)
    }
    setInstalled('1.0.0')
    const child = new RunningCli()
    const exitListener = launcher.attachExitHandler(child)
    await run({
      child,
      config,
      check: (digest = checksum) =>
        launcher.checkForUpdates(child, exitListener, async () => ({
          version: '2.0.0',
          binaryChecksums: { [target]: digest },
        })),
      finish: async (code = 0) => {
        child.exitCode = code
        await exitListener(code, null)
      },
      exits,
      output,
      errors,
      setInstalled,
      pauseDownload: () => {
        let resume = () => {}
        const started = new Promise<void>((resolve) => {
          downloadStarted = resolve
        })
        downloadGate = new Promise<void>((resolve) => {
          resume = resolve
        })
        return { started, resume }
      },
    })
  } finally {
    console.log = originals.log
    console.error = originals.error
    process.exit = originals.exit
    for (const [key, value] of Object.entries({
      NEXT_PUBLIC_CODEBUFF_APP_URL: originalEnv.app,
      NO_PROXY: originalEnv.proxy,
      FREEBUFF_BINARY_TARGET: originalEnv.target,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
}

describe('Freebuff updates wait for exit', () => {
  test('a ready update leaves the process and its binary/WASM untouched until exit', async () => {
    await withFixture(
      async ({ child, config, check, finish, exits, output }) => {
        await check()
        expect(child.signals).toEqual([])
        expect(child.listenerCount('exit')).toBe(1)
        expect(exits).toEqual([])
        expect(output).toEqual([])
        expect(readFileSync(config.binaryPath, 'utf8')).toBe('binary 1.0.0')
        expect(
          readFileSync(
            join(config.binaryPath, '..', 'tree-sitter.wasm'),
            'utf8',
          ),
        ).toBe('wasm 1.0.0')
        expect(existsSync(config.tempDownloadDir)).toBe(true)

        await finish()
        expect(exits).toEqual([0])
        expect(child.signals).toEqual([])
        expect(readFileSync(config.binaryPath, 'utf8')).toBe('new binary')
        expect(
          readFileSync(
            join(config.binaryPath, '..', 'tree-sitter.wasm'),
            'utf8',
          ),
        ).toBe('new wasm')
        expect(
          JSON.parse(readFileSync(config.metadataPath, 'utf8')).version,
        ).toBe('2.0.0')
        expect(existsSync(config.tempDownloadDir)).toBe(false)
        expect(output).toEqual([
          'Updated Freebuff to 2.0.0. Ready for your next launch.',
        ])
      },
    )
  })

  test('does not downgrade a release installed by another invocation', async () => {
    await withFixture(
      async ({ config, check, finish, setInstalled, output, exits }) => {
        await check()
        setInstalled('3.0.0')
        await finish()
        expect(readFileSync(config.binaryPath, 'utf8')).toBe('binary 3.0.0')
        expect(existsSync(config.tempDownloadDir)).toBe(false)
        expect(output).toEqual([])
        expect(exits).toEqual([0])
      },
    )
  })

  test('a failed installation keeps the old binary and preserves the exit code', async () => {
    await withFixture(async ({ config, check, finish, errors, exits }) => {
      await check()
      rmSync(config.tempDownloadDir, { recursive: true })
      await finish(7)
      expect(readFileSync(config.binaryPath, 'utf8')).toBe('binary 1.0.0')
      expect(
        JSON.parse(readFileSync(config.metadataPath, 'utf8')).version,
      ).toBe('1.0.0')
      expect(exits).toEqual([7])
      expect(errors.join('\n')).toContain('Could not install Freebuff update')
    })
  })

  test('a checksum failure never interrupts the process or installs on exit', async () => {
    await withFixture(
      async ({ child, config, check, finish, exits, output }) => {
        await check('0'.repeat(64))
        expect(child.signals).toEqual([])
        expect(exits).toEqual([])
        await finish()
        expect(readFileSync(config.binaryPath, 'utf8')).toBe('binary 1.0.0')
        expect(output).toEqual([])
        expect(exits).toEqual([0])
      },
    )
  })

  test('exit does not wait for an unfinished download or install it later', async () => {
    await withFixture(
      async ({ child, config, check, finish, exits, pauseDownload }) => {
        const gate = pauseDownload()
        const updating = check()
        await gate.started
        try {
          await finish()
          expect(exits).toEqual([0])
        } finally {
          gate.resume()
          await updating
        }
        expect(child.signals).toEqual([])
        expect(readFileSync(config.binaryPath, 'utf8')).toBe('binary 1.0.0')
        expect(exits).toEqual([0])
      },
    )
  })
})
