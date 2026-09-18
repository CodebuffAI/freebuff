/**
 * The npm launcher used to download a tarball, check that a file with the
 * binary's name came out of it, chmod it and run it — no checksum, no
 * signature, an origin read from the environment at runtime, and redirects
 * followed to any host over any protocol. These tests pin the three fences
 * that replaced that:
 *
 *  - the download origin must be https (or http on localhost),
 *  - a redirect may never downgrade to http or leave the release hosts,
 *  - the archive's sha256 must match the one published on npm, and a missing
 *    checksum is a refusal, not a pass.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const releaseCore = join(repoRoot, 'cli/release-core')

const launcherModule = require(join(releaseCore, 'launcher.js'))
const { evaluateRedirect, createReleaseHttpClient } = require(
  join(releaseCore, 'http.js'),
)
const checksumScript = require(join(releaseCore, 'write-binary-checksums.js'))

const sha256 = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex')

describe('download origin', () => {
  const { resolveDownloadOrigin, DEFAULT_DOWNLOAD_ORIGIN } = launcherModule

  test('defaults to codebuff.com over https', () => {
    expect(DEFAULT_DOWNLOAD_ORIGIN).toBe('https://codebuff.com')
    expect(resolveDownloadOrigin(undefined)).toBe(DEFAULT_DOWNLOAD_ORIGIN)
    expect(resolveDownloadOrigin('')).toBe(DEFAULT_DOWNLOAD_ORIGIN)
    expect(resolveDownloadOrigin('   ')).toBe(DEFAULT_DOWNLOAD_ORIGIN)
  })

  test('honours an https override, without a trailing slash', () => {
    expect(resolveDownloadOrigin('https://staging.codebuff.com/')).toBe(
      'https://staging.codebuff.com',
    )
    expect(resolveDownloadOrigin('https://example.internal:8443')).toBe(
      'https://example.internal:8443',
    )
  })

  test('allows plain http only on loopback hosts', () => {
    for (const origin of [
      'http://localhost:3000',
      'http://127.0.0.1:41234',
      'http://[::1]:3000',
      'http://LOCALHOST',
    ]) {
      expect(resolveDownloadOrigin(origin)).toBe(origin)
    }
  })

  test('ignores a plain-http override for any other host and warns', () => {
    const warnings: string[] = []
    const warn = (message: string) => warnings.push(message)

    expect(resolveDownloadOrigin('http://codebuff.com', { warn })).toBe(
      DEFAULT_DOWNLOAD_ORIGIN,
    )
    expect(
      resolveDownloadOrigin('http://evil.example.com/releases', { warn }),
    ).toBe(DEFAULT_DOWNLOAD_ORIGIN)
    // Not even a lookalike of a loopback address.
    expect(
      resolveDownloadOrigin('http://127.0.0.1.evil.example', { warn }),
    ).toBe(DEFAULT_DOWNLOAD_ORIGIN)
    expect(resolveDownloadOrigin('ftp://codebuff.com', { warn })).toBe(
      DEFAULT_DOWNLOAD_ORIGIN,
    )
    expect(resolveDownloadOrigin('not a url', { warn })).toBe(
      DEFAULT_DOWNLOAD_ORIGIN,
    )

    expect(warnings).toHaveLength(5)
    expect(warnings[0]).toContain('http://codebuff.com')
    expect(warnings[0]).toContain('must use https')
  })
})

describe('redirect policy', () => {
  const start = 'https://codebuff.com/api/releases/download/1.0.0/x.tar.gz'

  test('follows the chain the release route actually produces', () => {
    const hop1 = evaluateRedirect(
      start,
      'https://github.com/CodebuffAI/codebuff-community/releases/download/v1.0.0/x.tar.gz',
      { originalUrl: start },
    )
    expect(hop1).toEqual({
      ok: true,
      url: 'https://github.com/CodebuffAI/codebuff-community/releases/download/v1.0.0/x.tar.gz',
    })

    const hop2 = evaluateRedirect(
      hop1.url,
      'https://objects.githubusercontent.com/github-production-release-asset/abc?X-Amz-Signature=1',
      { originalUrl: start },
    )
    expect(hop2.ok).toBe(true)

    const hop3 = evaluateRedirect(
      hop1.url,
      'https://release-assets.githubusercontent.com/asset',
      { originalUrl: start },
    )
    expect(hop3.ok).toBe(true)
  })

  test('allows the freebuff and www hosts and the original host', () => {
    for (const host of [
      'freebuff.com',
      'www.freebuff.com',
      'www.codebuff.com',
      'CODEBUFF.COM',
    ]) {
      expect(evaluateRedirect(start, `https://${host}/asset`).ok).toBe(true)
    }

    const localStart = 'http://127.0.0.1:4321/api/releases/download/1/x'
    expect(
      evaluateRedirect(localStart, 'http://127.0.0.1:4321/files/x', {
        originalUrl: localStart,
      }).ok,
    ).toBe(true)
    // A relative Location stays on the current host.
    expect(evaluateRedirect(start, '/somewhere/else').ok).toBe(true)
  })

  test('refuses an https to http downgrade even to an allowed host', () => {
    const result = evaluateRedirect(start, 'http://codebuff.com/asset')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('insecure http')
    expect(result.reason).toContain('codebuff.com')

    // The original host is not a loophole for the downgrade rule either.
    const original = 'https://releases.example.com/x'
    expect(
      evaluateRedirect(original, 'http://releases.example.com/y', {
        originalUrl: original,
      }).ok,
    ).toBe(false)
  })

  test('refuses any host outside the allowlist and names it', () => {
    for (const location of [
      'https://evil.example.com/asset',
      'https://codebuff.com.evil.example/asset',
      'https://githubusercontent.com.evil.example/asset',
      'https://notgithubusercontent.com/asset',
      'https://github.com.evil/asset',
    ]) {
      const result = evaluateRedirect(start, location, { originalUrl: start })
      expect(result.ok).toBe(false)
      expect(result.reason).toContain(new URL(location).hostname)
    }
  })

  test('the original host means the FIRST url of the chain, not the previous hop', () => {
    // After hopping to github.com, a redirect back to an unrelated host must
    // not be admitted just because github.com was the last hop.
    const viaGithub = 'https://github.com/x/releases/download/v1/x.tar.gz'
    const result = evaluateRedirect(viaGithub, 'https://evil.example.com/x', {
      originalUrl: start,
    })
    expect(result.ok).toBe(false)
  })

  test('refuses non-http protocols and unparsable locations', () => {
    expect(evaluateRedirect(start, 'ftp://codebuff.com/x').ok).toBe(false)
    expect(evaluateRedirect(start, 'file:///etc/passwd').ok).toBe(false)
    expect(evaluateRedirect(start, 'http://').ok).toBe(false)
  })
})

describe('httpGet enforces the redirect policy on the wire', () => {
  function fakeResponse(
    statusCode: number,
    headers: Record<string, string>,
    body = '',
  ) {
    return Object.assign(Readable.from(body ? [body] : []), {
      statusCode,
      headers,
    })
  }

  function clientWithRedirects(hops: Array<[number, string]>) {
    const requested: string[] = []
    let call = 0
    const get = (
      options: Record<string, any>,
      callback: (response: Readable) => void,
    ) => {
      requested.push(`${options.hostname}${options.path}`)
      const hop = hops[call++]
      queueMicrotask(() => {
        callback(
          hop
            ? fakeResponse(hop[0], { location: hop[1] })
            : fakeResponse(200, {}, 'ok'),
        )
      })
      return {
        on() {
          return this
        },
        setTimeout() {
          return this
        },
        destroy() {},
      }
    }
    const client = createReleaseHttpClient({
      env: {},
      userAgent: 'test',
      requestTimeout: 1000,
      httpModule: { get },
      httpsModule: { get },
    })
    return { client, requested }
  }

  test('follows codebuff.com -> github.com -> githubusercontent.com', async () => {
    const { client, requested } = clientWithRedirects([
      [302, 'https://github.com/o/r/releases/download/v1/x.tar.gz'],
      [302, 'https://objects.githubusercontent.com/asset?sig=1'],
    ])
    const response = await client.httpGet(
      'https://codebuff.com/api/releases/download/1/x.tar.gz',
    )
    response.resume()
    expect(response.statusCode).toBe(200)
    expect(requested).toEqual([
      'codebuff.com/api/releases/download/1/x.tar.gz',
      'github.com/o/r/releases/download/v1/x.tar.gz',
      'objects.githubusercontent.com/asset?sig=1',
    ])
  })

  test('stops at a downgrade and does not contact the http host', async () => {
    const { client, requested } = clientWithRedirects([
      [302, 'http://codebuff.com/asset'],
    ])
    await expect(
      client.httpGet('https://codebuff.com/api/releases/download/1/x.tar.gz'),
    ).rejects.toMatchObject({
      code: 'EREDIRECT_REFUSED',
      retryable: false,
    })
    expect(requested).toHaveLength(1)
  })

  test('stops at a foreign host, even after a legitimate hop', async () => {
    const { client, requested } = clientWithRedirects([
      [302, 'https://github.com/o/r/releases/download/v1/x.tar.gz'],
      [307, 'https://evil.example.com/x.tar.gz'],
    ])
    await expect(
      client.httpGet('https://codebuff.com/api/releases/download/1/x.tar.gz'),
    ).rejects.toThrow('evil.example.com')
    expect(requested).toHaveLength(2)
  })
})

describe('archive checksum verification', () => {
  const { verifyFileSha256, computeFileSha256, isSha256Hex } = launcherModule

  function withTempFile(
    contents: string,
    run: (path: string) => Promise<void>,
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'launcher-sha-'))
    const file = join(dir, 'archive.tar.gz')
    writeFileSync(file, contents)
    return run(file).finally(() =>
      rmSync(dir, { recursive: true, force: true }),
    )
  }

  test('computes the sha256 of a file', () =>
    withTempFile('hello world', async (file) => {
      expect(await computeFileSha256(file)).toBe(sha256('hello world'))
    }))

  test('passes on a matching digest, in either case', () =>
    withTempFile('archive bytes', async (file) => {
      const digest = sha256('archive bytes')
      expect(await verifyFileSha256(file, digest)).toEqual({
        ok: true,
        actual: digest,
      })
      expect((await verifyFileSha256(file, digest.toUpperCase())).ok).toBe(true)
    }))

  test('fails on a mismatch and reports both digests', () =>
    withTempFile('archive bytes', async (file) => {
      const expected = sha256('something else')
      const result = await verifyFileSha256(file, expected)
      expect(result.ok).toBe(false)
      expect(result.actual).toBe(sha256('archive bytes'))
      expect(result.reason).toContain(expected)
      expect(result.reason).toContain(sha256('archive bytes'))
    }))

  test('fails CLOSED when no checksum is published', () =>
    withTempFile('archive bytes', async (file) => {
      for (const missing of [undefined, null, '', 'abc', 42, {}]) {
        const result = await verifyFileSha256(file, missing)
        expect(result.ok).toBe(false)
        expect(result.reason).toContain('no sha256 checksum')
      }
    }))

  test('isSha256Hex accepts exactly 64 hex characters', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true)
    expect(isSha256Hex('A'.repeat(64))).toBe(true)
    expect(isSha256Hex('a'.repeat(63))).toBe(false)
    expect(isSha256Hex('g'.repeat(64))).toBe(false)
    expect(isSha256Hex(undefined)).toBe(false)
  })
})

describe('write-binary-checksums.js (release side)', () => {
  const { TARGET_KEYS, computeChecksums, findChecksumProblems } = checksumScript

  test('covers exactly the targets the launcher can download', () => {
    expect(TARGET_KEYS).toEqual(launcherModule.PLATFORM_TARGET_KEYS)
    const launcher = launcherModule.createLauncher({
      packageName: 'freebuff',
      displayName: 'Freebuff',
    })
    expect(Object.keys(launcher.__testing.PLATFORM_TARGETS)).toEqual(
      TARGET_KEYS,
    )
    // And the file it hashes is the file the launcher asks the origin for.
    for (const target of TARGET_KEYS) {
      expect(checksumScript.archiveFileName('freebuff', target)).toBe(
        launcher.__testing.PLATFORM_TARGETS[target],
      )
    }
  })

  function fixtureBinaries(binaryName: string, targets: string[]) {
    const root = mkdtempSync(join(tmpdir(), 'release-binaries-'))
    const digests: Record<string, string> = {}
    for (const target of targets) {
      const dir = join(root, `${binaryName}-${target}`)
      mkdirSync(dir, { recursive: true })
      const contents = `archive for ${target}`
      writeFileSync(join(dir, `${binaryName}-${target}.tar.gz`), contents)
      digests[target] = sha256(contents)
    }
    return { root, digests }
  }

  test('hashes every archive from the artifact layout the workflows download', () => {
    const { root, digests } = fixtureBinaries('freebuff', TARGET_KEYS)
    try {
      expect(computeChecksums(root, 'freebuff')).toEqual({
        checksums: digests,
        missing: [],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('write refuses when an archive is missing or empty', () => {
    const { root } = fixtureBinaries(
      'freebuff',
      TARGET_KEYS.filter((t: string) => t !== 'darwin-arm64'),
    )
    const emptyDir = join(root, 'freebuff-linux-arm64')
    writeFileSync(join(emptyDir, 'freebuff-linux-arm64.tar.gz'), '')
    const packageDir = join(root, 'pkg')
    mkdirSync(packageDir)
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: 'freebuff', version: '9.9.9' }),
    )
    try {
      const { missing } = computeChecksums(root, 'freebuff')
      expect(missing.map((p: string) => p.split('/').pop())).toEqual([
        'freebuff-linux-arm64.tar.gz',
        'freebuff-darwin-arm64.tar.gz',
      ])
      expect(() =>
        checksumScript.writeChecksums({
          binariesDir: root,
          binaryName: 'freebuff',
          packageDir,
        }),
      ).toThrow('Missing or empty release archives')
      // Nothing was stamped.
      expect(
        JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
          .binaryChecksums,
      ).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('write stamps the map and verify accepts it; verify rejects a gap', () => {
    const { root, digests } = fixtureBinaries('codebuff', TARGET_KEYS)
    const packageDir = join(root, 'pkg')
    mkdirSync(packageDir)
    const packageJsonPath = join(packageDir, 'package.json')
    writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: 'codebuff', version: '1.2.3', bin: {} }, null, 2) +
        '\n',
    )
    try {
      checksumScript.writeChecksums({
        binariesDir: root,
        binaryName: 'codebuff',
        packageDir,
      })
      const written = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
      expect(written).toMatchObject({ name: 'codebuff', version: '1.2.3' })
      expect(written.binaryChecksums).toEqual(digests)
      expect(() => checksumScript.verifyChecksums({ packageDir })).not.toThrow()

      delete written.binaryChecksums['win32-x64-baseline']
      writeFileSync(packageJsonPath, JSON.stringify(written))
      expect(() => checksumScript.verifyChecksums({ packageDir })).toThrow(
        'win32-x64-baseline: missing',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("write refuses to stamp one product into another product's manifest", () => {
    const { root } = fixtureBinaries('freebuff', TARGET_KEYS)
    const packageDir = join(root, 'pkg')
    mkdirSync(packageDir)
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: 'codebuff', version: '1.0.0' }),
    )
    try {
      expect(() =>
        checksumScript.writeChecksums({
          binariesDir: root,
          binaryName: 'freebuff',
          packageDir,
        }),
      ).toThrow('Refusing to stamp')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('findChecksumProblems flags missing, malformed and unknown entries', () => {
    const complete = Object.fromEntries(
      TARGET_KEYS.map((t: string) => [t, 'b'.repeat(64)]),
    )
    expect(findChecksumProblems(complete)).toEqual([])
    expect(findChecksumProblems(undefined)).toEqual([
      'package.json has no binaryChecksums object',
    ])
    expect(
      findChecksumProblems({
        ...complete,
        'linux-x64': 'nope',
        'plan9-mips': 'c'.repeat(64),
      }),
    ).toEqual([
      'linux-x64: not a sha256 hex digest ("nope")',
      'plan9-mips: not a known target',
    ])
  })
})

describe('the launcher end to end', () => {
  const tar = require('tar') as typeof import('tar')
  const target = `${process.platform}-${process.arch}`

  async function withReleaseServer(
    archives: Record<string, Buffer>,
    run: (requestedPaths: string[]) => Promise<void>,
  ) {
    const requestedPaths: string[] = []
    const server = createServer((request, response) => {
      requestedPaths.push(request.url ?? '')
      const file = (request.url ?? '').split('/').pop() ?? ''
      const body = archives[file]
      if (!body) {
        response.writeHead(404)
        response.end('missing')
        return
      }
      response.writeHead(200, {
        'content-length': body.byteLength,
        'content-type': 'application/gzip',
      })
      response.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const previous = {
      app: process.env.NEXT_PUBLIC_CODEBUFF_APP_URL,
      noProxy: process.env.NO_PROXY,
    }
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = `http://127.0.0.1:${port}`
    process.env.NO_PROXY = '127.0.0.1'
    try {
      await run(requestedPaths)
    } finally {
      if (previous.app === undefined) {
        delete process.env.NEXT_PUBLIC_CODEBUFF_APP_URL
      } else process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = previous.app
      if (previous.noProxy === undefined) delete process.env.NO_PROXY
      else process.env.NO_PROXY = previous.noProxy
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  /** A launcher over a fresh config dir, and an archive of `files`. */
  async function fixture(
    packageName: string,
    files: Record<string, string>,
    config: Record<string, unknown> = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), 'launcher-integrity-'))
    const configDir = join(root, 'config')
    const archiveDir = join(root, 'archive')
    mkdirSync(configDir)
    mkdirSync(archiveDir)
    const launcher = launcherModule.createLauncher({
      packageName,
      displayName: packageName,
      wrapperVersion: '2.0.0',
      includeTreeSitterWasm: false,
      configDir,
      ...config,
    })
    const { CONFIG } = launcher.__testing
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(archiveDir, name), contents)
    }
    const archivePath = join(root, 'release.tar.gz')
    await tar.c(
      { cwd: archiveDir, file: archivePath, gzip: true },
      Object.keys(files),
    )
    const archive = readFileSync(archivePath)
    return {
      root,
      launcher,
      CONFIG,
      archive,
      archiveName: `${packageName}-${target}.tar.gz`,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    }
  }

  const silence = () => {
    const original = { error: console.error, log: console.log }
    console.error = () => {}
    console.log = () => {}
    return () => {
      console.error = original.error
      console.log = original.log
    }
  }

  test('installs an archive whose sha256 matches the published one', async () => {
    const f = await fixture('integ-ok', { 'integ-ok': 'good binary' })
    const restore = silence()
    try {
      const binaryChecksums = { [target]: sha256(f.archive) }
      await withReleaseServer({ [f.archiveName]: f.archive }, async () => {
        const staged = await f.launcher.__testing.stageBinary('2.0.0', target, {
          binaryChecksums,
        })
        expect(readFileSync(staged.tempBinaryPath, 'utf8')).toBe('good binary')
      })
    } finally {
      restore()
      f.cleanup()
    }
  })

  test('refuses an archive whose sha256 does not match, and leaves nothing behind', async () => {
    const f = await fixture('integ-bad', { 'integ-bad': 'substituted binary' })
    const restore = silence()
    try {
      const binaryChecksums = { [target]: sha256('the real archive') }
      await withReleaseServer(
        { [f.archiveName]: f.archive },
        async (requestedPaths) => {
          await expect(
            f.launcher.__testing.stageBinary('2.0.0', target, {
              binaryChecksums,
            }),
          ).rejects.toMatchObject({
            code: 'ECHECKSUM',
            stage: 'checksum',
            retryable: false,
          })
          // A mismatch is final: no retry re-downloads the same bytes.
          expect(requestedPaths).toHaveLength(1)
          expect(existsSync(f.CONFIG.binaryPath)).toBe(false)
          expect(existsSync(f.CONFIG.tempDownloadDir)).toBe(false)
          // The partial archive was discarded so the next run cannot resume
          // — and re-verify — the rejected bytes.
          expect(
            readdirSync(f.CONFIG.configDir).filter((n) => n.endsWith('.part')),
          ).toEqual([])
        },
      )
    } finally {
      restore()
      f.cleanup()
    }
  })

  test('refuses to download at all when no checksum is published (fail closed)', async () => {
    const f = await fixture('integ-none', { 'integ-none': 'binary' })
    const restore = silence()
    try {
      await withReleaseServer(
        { [f.archiveName]: f.archive },
        async (requestedPaths) => {
          // An empty map for this very version: the package says nothing
          // about this target, so nothing is fetched and nothing installed.
          await expect(
            f.launcher.__testing.stageBinary('2.0.0', target, {
              binaryChecksums: {},
            }),
          ).rejects.toMatchObject({ code: 'ECHECKSUM', stage: 'checksum' })
          expect(requestedPaths).toHaveLength(0)
          expect(existsSync(f.CONFIG.binaryPath)).toBe(false)
        },
      )
    } finally {
      restore()
      f.cleanup()
    }
  })

  test('reads the checksums of its own version from its own manifest', async () => {
    const f = await fixture('integ-own', { 'integ-own': 'own binary' })
    const restore = silence()
    try {
      // What index.js passes from package.json: the wrapper is 2.0.0 and its
      // manifest carries the digest of 2.0.0's archive.
      const own = await fixture(
        'integ-own',
        { 'integ-own': 'own binary' },
        {
          binaryChecksums: { [target]: sha256(f.archive) },
        },
      )
      try {
        const map = await own.launcher.__testing.resolveBinaryChecksums('2.0.0')
        expect(map).toEqual({ [target]: sha256(f.archive) })
        // A map handed in by the caller (the registry document that named the
        // version) wins over the wrapper's own.
        const provided = { [target]: 'f'.repeat(64) }
        expect(
          await own.launcher.__testing.resolveBinaryChecksums(
            '2.0.0',
            provided,
          ),
        ).toBe(provided)
        expect(
          await own.launcher.__testing.getExpectedChecksum('2.0.0', target),
        ).toBe(sha256(f.archive))
        await expect(
          own.launcher.__testing.getExpectedChecksum('2.0.0', 'linux-arm64'),
        ).rejects.toMatchObject({ code: 'ECHECKSUM' })
      } finally {
        own.cleanup()
      }
    } finally {
      restore()
      f.cleanup()
    }
  })

  test('extracts only the binary (and tree-sitter.wasm), never anything else in the archive', async () => {
    const f = await fixture(
      'integ-filter',
      {
        'integ-filter': 'the binary',
        'tree-sitter.wasm': 'wasm',
        'evil.sh': 'rm -rf /',
        '.bashrc': 'export PATH=/tmp:$PATH',
      },
      { includeTreeSitterWasm: true },
    )
    const restore = silence()
    try {
      const binaryChecksums = { [target]: sha256(f.archive) }
      await withReleaseServer({ [f.archiveName]: f.archive }, async () => {
        await f.launcher.__testing.stageBinary('2.0.0', target, {
          binaryChecksums,
        })
        expect(readdirSync(f.CONFIG.tempDownloadDir).sort()).toEqual(
          [f.CONFIG.binaryName, 'tree-sitter.wasm'].sort(),
        )
      })

      const { isAllowedArchiveEntry } = f.launcher.__testing
      const file = { type: 'File' }
      expect(isAllowedArchiveEntry(f.CONFIG.binaryName, file)).toBe(true)
      expect(isAllowedArchiveEntry(`./${f.CONFIG.binaryName}`, file)).toBe(true)
      expect(isAllowedArchiveEntry('tree-sitter.wasm', file)).toBe(true)
      expect(isAllowedArchiveEntry(`bin/${f.CONFIG.binaryName}`, file)).toBe(
        false,
      )
      expect(isAllowedArchiveEntry(`../${f.CONFIG.binaryName}`, file)).toBe(
        false,
      )
      expect(
        isAllowedArchiveEntry(f.CONFIG.binaryName, { type: 'SymbolicLink' }),
      ).toBe(false)
      expect(isAllowedArchiveEntry('evil.sh', file)).toBe(false)
    } finally {
      restore()
      f.cleanup()
    }
  })

  test('builds the download URL through the origin resolver, after the checksum gate', () => {
    // The pure resolver carries the https rule (pinned above); this makes
    // sure stageBinary cannot reach the environment variable around it, and
    // that an unverifiable release is refused before any URL is built.
    const source = readFileSync(join(releaseCore, 'launcher.js'), 'utf8')
    const stage = source.slice(
      source.indexOf('async function stageBinary'),
      source.indexOf('function replaceFileWithRollback'),
    )
    expect(stage).toContain('resolveDownloadOrigin(')
    expect(stage).toContain('process.env.NEXT_PUBLIC_CODEBUFF_APP_URL')
    expect(stage.indexOf('getExpectedChecksum(')).toBeLessThan(
      stage.indexOf('resolveDownloadOrigin('),
    )
    // Nowhere else reads the override.
    expect(source.split('NEXT_PUBLIC_CODEBUFF_APP_URL').length - 1).toBe(
      (stage.match(/NEXT_PUBLIC_CODEBUFF_APP_URL/g) ?? []).length +
        (
          source
            .slice(0, source.indexOf('function createLauncher'))
            .match(/NEXT_PUBLIC_CODEBUFF_APP_URL/g) ?? []
        ).length,
    )
  })
})
