import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

const binaryName = process.platform === 'win32' ? 'freebuff.exe' : 'freebuff'
const target = `${process.platform}-${process.arch}`

type Fixture = {
  configDir: string
  output: string[]
  errors: string[]
  exits: number[]
  requests: () => number
  setInstalled: (version: string) => void
  installedVersion: () => string | null
  installedBinary: () => string
  update: (options?: {
    version?: string | null
    checksum?: string | null
  }) => Promise<void>
  cleanup: () => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

async function createFixture(installedVersion: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'freebuff-update-command-'))
  const configDir = join(root, 'config')
  const archiveDir = join(root, 'archive')
  mkdirSync(configDir)
  mkdirSync(archiveDir)
  writeFileSync(join(archiveDir, binaryName), 'new binary')
  writeFileSync(join(archiveDir, 'tree-sitter.wasm'), 'new wasm')
  const archivePath = join(root, 'release.tar.gz')
  await tar.c({ cwd: archiveDir, file: archivePath, gzip: true }, [
    binaryName,
    'tree-sitter.wasm',
  ])
  const archive = readFileSync(archivePath)
  const checksum = createHash('sha256').update(archive).digest('hex')

  let requestCount = 0
  const server = createServer((_request, response) => {
    requestCount++
    response.writeHead(200, { 'content-length': archive.length })
    response.end(archive)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  const originalEnv = {
    app: process.env.NEXT_PUBLIC_CODEBUFF_APP_URL,
    noProxy: process.env.NO_PROXY,
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
  }
  setInstalled(installedVersion)

  const cleanup = async () => {
    console.log = originals.log
    console.error = originals.error
    process.exit = originals.exit
    for (const [key, value] of Object.entries({
      NEXT_PUBLIC_CODEBUFF_APP_URL: originalEnv.app,
      NO_PROXY: originalEnv.noProxy,
      FREEBUFF_BINARY_TARGET: originalEnv.target,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
  cleanups.push(cleanup)

  return {
    configDir,
    output,
    errors,
    exits,
    requests: () => requestCount,
    setInstalled,
    installedVersion: () => {
      try {
        return JSON.parse(readFileSync(config.metadataPath, 'utf8')).version
      } catch {
        return null
      }
    },
    installedBinary: () => readFileSync(config.binaryPath, 'utf8'),
    update: ({
      version = '2.0.0',
      checksum: digest = checksum,
    }: { version?: string | null; checksum?: string | null } = {}) =>
      launcher.runUpdateCommand(async () =>
        version === null
          ? null
          : {
              version,
              binaryChecksums: digest ? { [target]: digest } : null,
            },
      ),
    cleanup,
  }
}

describe('freebuff update: command detection', () => {
  const { isUpdateCommand } = createLauncher({
    packageName: 'freebuff',
    displayName: 'Freebuff',
  }).__testing

  test('detects the command as the first positional argument', () => {
    expect(isUpdateCommand(['update'])).toBe(true)
    expect(isUpdateCommand(['--cwd', '/tmp', 'update'])).toBe(true)
    expect(isUpdateCommand(['update', '--cwd', '/tmp'])).toBe(true)
  })

  test('ignores flags and their values', () => {
    expect(isUpdateCommand([])).toBe(false)
    expect(isUpdateCommand(['--version'])).toBe(false)
    expect(isUpdateCommand(['--help'])).toBe(false)
    // A directory named `update` is not the command.
    expect(isUpdateCommand(['--cwd', 'update'])).toBe(false)
    expect(isUpdateCommand(['continue'])).toBe(false)
    expect(isUpdateCommand(['--', 'update'])).toBe(false)
  })
})

describe('freebuff update: installing', () => {
  test('is a no-op when the installed version is current', async () => {
    const fixture = await createFixture('2.0.0')

    await fixture.update({ version: '2.0.0' })

    expect(fixture.requests()).toBe(0)
    expect(fixture.exits).toEqual([])
    expect(fixture.output.join('\n')).toContain('already up to date')
    expect(fixture.installedVersion()).toBe('2.0.0')
  })

  test('downloads, verifies and installs the latest release', async () => {
    const fixture = await createFixture('1.0.0')

    await fixture.update()

    expect(fixture.requests()).toBe(1)
    expect(fixture.exits).toEqual([])
    expect(fixture.installedVersion()).toBe('2.0.0')
    expect(fixture.installedBinary()).toBe('new binary')
    expect(existsSync(join(fixture.configDir, 'tree-sitter.wasm'))).toBe(true)
    expect(fixture.output.join('\n')).toContain('Updated Freebuff to 2.0.0')
    // The staging directory is cleaned up once the binary is installed.
    expect(
      readdirSync(fixture.configDir).filter((name) =>
        name.startsWith('.freebuff-download-temp'),
      ),
    ).toEqual([])
  })

  test('fails without touching the installed binary when the latest version is unknown', async () => {
    const fixture = await createFixture('1.0.0')

    await fixture.update({ version: null })

    expect(fixture.exits).toEqual([1])
    expect(fixture.installedVersion()).toBe('1.0.0')
    expect(fixture.installedBinary()).toBe('binary 1.0.0')
  })

  test('fails closed when the download does not match the published checksum', async () => {
    const fixture = await createFixture('1.0.0')

    await fixture.update({ checksum: '0'.repeat(64) })

    expect(fixture.exits).toEqual([1])
    expect(fixture.installedVersion()).toBe('1.0.0')
    expect(fixture.installedBinary()).toBe('binary 1.0.0')
  })

  test('installs the latest release when nothing is installed yet', async () => {
    const fixture = await createFixture('1.0.0')
    rmSync(join(fixture.configDir, binaryName), { force: true })

    await fixture.update()

    expect(fixture.exits).toEqual([])
    expect(fixture.installedVersion()).toBe('2.0.0')
    expect(fixture.output.join('\n')).toContain('is not installed yet')
  })
})
