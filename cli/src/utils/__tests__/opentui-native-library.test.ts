import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'

import { dlopen } from 'bun:ffi'

import {
  RenderLibraryLoadError,
  bunExtractionTempDir,
  ensureRenderLibrary,
  findEmbeddedRenderLibrary,
  installRenderLibrary,
  sweepLeakedRenderLibraryCopies,
} from '../opentui-native-library'

// The two shapes `cli.fatal_crash` reports from Linux binaries.
const EXTRACTION_FAILED =
  'Failed to initialize OpenTUI render library: Failed to open library "/$bunfs/root/libopentui-c48jzvfh.so": /$bunfs/root/libopentui-c48jzvfh.so: cannot open shared object file: No such file or directory'
const NOEXEC_TMP =
  'Failed to initialize OpenTUI render library: Failed to open library "/tmp/.5bfffdeb1fb7e7d2-00000001.so": /tmp/.5bfffdeb1fb7e7d2-00000001.so: failed to map segment from shared object'

function embedded(name: string, bytes: Uint8Array) {
  return Object.assign(new Blob([bytes]), { name })
}

function fakeLibraryBytes(size = 200 * 1024, seed = 7): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) % 251
  return bytes
}

/** The real native library for this platform, when it is installed. */
async function realLibraryPath(): Promise<string | null> {
  try {
    const mod = await import(
      `@opentui/core-${process.platform}-${process.arch}`
    )
    const libraryPath = mod.default as string
    return existsSync(libraryPath) ? libraryPath : null
  } catch {
    return null
  }
}

let workDir: string
beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'freebuff-render-lib-'))
})
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('ensureRenderLibrary', () => {
  test('uses the bundled library when it loads', async () => {
    let installs = 0
    const source = await ensureRenderLibrary({
      resolve: () => {},
      setPath: () => {
        installs++
      },
      embeddedFiles: () => [
        embedded('libopentui-abc123.so', fakeLibraryBytes()),
      ],
      cacheDir: () => path.join(workDir, 'cache'),
      tempDir: () => workDir,
    })
    expect(source).toBe('bundled')
    expect(installs).toBe(0)
    expect(existsSync(path.join(workDir, 'cache'))).toBe(false)
  })

  test('falls back to a loadable copy in the config directory when the temp copy fails', async () => {
    const libraryPath = await realLibraryPath()
    if (!libraryPath) return // no native package for this platform here
    const bytes = new Uint8Array(readFileSync(libraryPath))
    const name = `libopentui-c48jzvfh${path.extname(libraryPath)}`
    const cacheDir = path.join(workDir, 'config', 'native')
    let chosenPath: string | undefined
    const resolve = () => {
      // Reproduces the field failure: Bun could not unpack into TMPDIR, so
      // dlopen was handed the virtual /$bunfs path.
      if (!chosenPath) throw new Error(EXTRACTION_FAILED)
      dlopen(chosenPath, {
        setLogCallback: { args: ['ptr'], returns: 'void' },
      }).close()
    }

    const source = await ensureRenderLibrary({
      resolve,
      setPath: (p) => {
        chosenPath = p
      },
      embeddedFiles: () => [embedded(name, bytes)],
      cacheDir: () => cacheDir,
      tempDir: () => workDir,
    })

    expect(source).toBe('cache')
    expect(path.dirname(chosenPath!)).toBe(cacheDir)
    expect(readFileSync(chosenPath!).equals(Buffer.from(bytes))).toBe(true)
  })

  test('reuses the installed copy and prunes copies from older versions', async () => {
    const cacheDir = path.join(workDir, 'native')
    const stale = path.join(cacheDir, 'opentui-0000000000000000.so')
    const library = embedded('libopentui-abc123.so', fakeLibraryBytes())

    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(stale, 'previous CLI version')
    const first = await installRenderLibrary(library, cacheDir)
    const before = statSync(first).mtimeMs
    await Bun.sleep(5)
    const second = await installRenderLibrary(library, cacheDir)

    expect(second).toBe(first)
    expect(statSync(second).mtimeMs).toBe(before)
    expect(readdirSync(cacheDir)).toEqual([path.basename(first)])
    expect(existsSync(stale)).toBe(false)
  })

  test('explains a noexec temp directory instead of crashing with the raw OpenTUI error', async () => {
    let error: unknown
    try {
      await ensureRenderLibrary({
        resolve: () => {
          throw new Error(NOEXEC_TMP)
        },
        setPath: () => {},
        embeddedFiles: () => [
          embedded('libopentui-abc123.so', fakeLibraryBytes()),
        ],
        cacheDir: () => path.join(workDir, 'native'),
        tempDir: () => workDir,
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(RenderLibraryLoadError)
    const message = (error as Error).message
    expect(message).toStartWith(
      'Freebuff could not load its terminal renderer.',
    )
    expect(message).toContain('mounted noexec')
    expect(message).toContain('TMPDIR')
    expect(message).toContain(`Details: ${NOEXEC_TMP}`)
    expect(message).toContain('Fallback copy:')
    // The fatal handler prints `stack`; it must be the advice, not a trace.
    expect((error as Error).stack).toBe(message)
  })

  test('names a missing temp directory when there is nothing to fall back to', async () => {
    const missing = path.join(workDir, 'gone')
    let message = ''
    try {
      await ensureRenderLibrary({
        resolve: () => {
          throw new Error(EXTRACTION_FAILED)
        },
        setPath: () => {},
        embeddedFiles: () => [],
        cacheDir: () => path.join(workDir, 'native'),
        tempDir: () => missing,
      })
    } catch (caught) {
      message = (caught as Error).message
    }
    expect(message).toContain(`Your temp directory (${missing}) does not exist`)
    expect(message).not.toContain('Fallback copy:')
  })

  test('only matches the renderer among embedded files', () => {
    const files = [
      embedded('tree-sitter-zig-e78zbjpm.wasm', new Uint8Array(1)),
      embedded('opentui-c5en9p2g.dll', new Uint8Array(1)),
    ]
    expect(findEmbeddedRenderLibrary(files)?.name).toBe('opentui-c5en9p2g.dll')
    expect(findEmbeddedRenderLibrary(files.slice(0, 1))).toBeUndefined()
  })

  test('Bun extracts into BUN_TMPDIR ahead of TMPDIR', () => {
    expect(bunExtractionTempDir({ BUN_TMPDIR: '/x' })).toBe('/x')
    expect(bunExtractionTempDir({})).toBe(tmpdir())
  })
})

describe('sweepLeakedRenderLibraryCopies', () => {
  test('removes only stale byte-identical copies Bun left behind', async () => {
    const bytes = fakeLibraryBytes()
    const library = embedded('libopentui-abc123.so', bytes)
    const old = Date.now() / 1000 - 3600
    const write = (name: string, content: Uint8Array, stale = true) => {
      const file = path.join(workDir, name)
      writeFileSync(file, content)
      if (stale) utimesSync(file, old, old)
      return file
    }
    const leaked = write('.5bfffdeb1fb7e7d2-00000001.so', bytes)
    const leaked2 = write('.5bfffdf09b97ddee-00000000.so', bytes)
    const young = write('.5bfffff83dbfcffa-00000001.so', bytes, false)
    const tampered = new Uint8Array(bytes)
    tampered[tampered.length - 1] ^= 1
    const otherLibrary = write('.5bfffdbb0fbf5fc3-00000001.so', tampered)
    const otherName = write('libopentui-abc123.so', bytes)
    const otherExt = write('.5bfffdeb1fb7e7d2-00000002.dylib', bytes)
    const emptyFromFullDisk = write(
      '.3dffecff73ff7df6-00000000.so',
      new Uint8Array(0),
    )
    const youngEmpty = write(
      '.3dffecff77d77ffe-00000001.so',
      new Uint8Array(0),
      false,
    )

    const result = await sweepLeakedRenderLibraryCopies({
      library,
      tempDir: workDir,
    })

    expect(result).toEqual({ removed: 3, bytes: 2 * bytes.length })
    expect(existsSync(leaked)).toBe(false)
    expect(existsSync(leaked2)).toBe(false)
    expect(existsSync(emptyFromFullDisk)).toBe(false)
    for (const kept of [young, youngEmpty, otherLibrary, otherName, otherExt]) {
      expect(existsSync(kept)).toBe(true)
    }
  })

  test('tolerates an unreadable temp directory', async () => {
    expect(
      await sweepLeakedRenderLibraryCopies({
        library: embedded('libopentui-abc123.so', fakeLibraryBytes()),
        tempDir: path.join(workDir, 'missing'),
      }),
    ).toEqual({ removed: 0, bytes: 0 })
  })
})
