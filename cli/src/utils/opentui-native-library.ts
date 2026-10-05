import { createHash } from 'crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import os from 'os'
import path from 'path'

import { getCliEnv } from './env'

/**
 * OpenTUI's renderer is a native library (.so/.dylib/.dll) that `bun build
 * --compile` embeds in the binary. Bun cannot dlopen from its virtual
 * filesystem, so on every launch it copies the library into the temp
 * directory (TMPDIR) and dlopens the copy. Two things follow:
 *
 * - If the temp directory is full or read-only the copy fails and dlopen is
 *   handed the virtual `/$bunfs/root/libopentui-*.so` path ("cannot open
 *   shared object file"); if it is mounted noexec the copy lands but cannot
 *   be mapped ("failed to map segment from shared object"). Either way the
 *   CLI died at startup with no hint that the temp directory was the cause.
 * - Bun never deletes the copy. Every launch leaves another full-size
 *   `.<16 hex>-<8 hex>.<ext>` file behind (measured: 3.3 MB per launch on
 *   macOS arm64), which is itself a way to fill a small tmpfs.
 *
 * So: when the bundled load fails, install the library once into the CLI's
 * own config directory (content-addressed, reused across launches) and load
 * it from there; if that fails too, say what to fix. And after a successful
 * start, delete stale byte-identical copies Bun left in the temp directory.
 */

const EMBEDDED_LIBRARY_NAME = /^(?:lib)?opentui-[0-9a-z]+\.(?:so|dylib|dll)$/
const BUN_EXTRACTED_COPY_NAME = /^\.[0-9a-f]{16}-[0-9a-f]{8}\.(?:so|dylib|dll)$/
const CACHED_LIBRARY_PREFIX = 'opentui-'
/** A copy younger than this may belong to a launch that has not dlopened yet. */
const STALE_COPY_AGE_MS = 10 * 60 * 1000
const COMPARE_BYTES = 64 * 1024
const MAX_COPIES_PER_SWEEP = 200

type EmbeddedFile = Blob & { name?: string }

export type RenderLibraryDeps = {
  /** OpenTUI's `resolveRenderLib`: loads the library or throws. */
  resolve: () => unknown
  /** OpenTUI's `setRenderLibPath`: valid until a load has succeeded. */
  setPath: (libraryPath: string) => void
  embeddedFiles: () => readonly EmbeddedFile[]
  /** Directory the fallback copy is installed into. */
  cacheDir: () => string
  tempDir: () => string
}

export type RenderLibrarySource = 'bundled' | 'cache'

export class RenderLibraryLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RenderLibraryLoadError'
    // Shown to the user verbatim by the startup fatal handler, which prints
    // `stack` when present; a JS stack here would only bury the advice.
    this.stack = message
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function findEmbeddedRenderLibrary(
  files: readonly EmbeddedFile[],
): EmbeddedFile | undefined {
  return files.find(
    (file) =>
      typeof file.name === 'string' &&
      EMBEDDED_LIBRARY_NAME.test(path.basename(file.name)),
  )
}

/** Why the temp directory cannot take a new file, or null when it can. */
function probeTempDirectory(directory: string): string | null {
  const probePath = path.join(
    directory,
    `.freebuff-tmp-probe-${process.pid}-${Date.now()}`,
  )
  try {
    writeFileSync(probePath, 'x'.repeat(4096), { flag: 'wx' })
    return null
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOSPC' || code === 'EDQUOT') return 'is full'
    if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
      return 'is not writable'
    }
    if (code === 'ENOENT') return 'does not exist'
    return `could not be written (${code ?? errorMessage(error)})`
  } finally {
    try {
      rmSync(probePath, { force: true })
    } catch {}
  }
}

export function describeRenderLibraryFailure(
  error: unknown,
  tempDir: string,
  fallbackError?: unknown,
): RenderLibraryLoadError {
  const detail = errorMessage(error)
  const tempProblem = probeTempDirectory(tempDir)
  let cause: string
  if (tempProblem) {
    cause = `Your temp directory (${tempDir}) ${tempProblem}, and Freebuff unpacks its terminal renderer there on every start.`
  } else if (/failed to map segment/i.test(detail)) {
    cause = `Your temp directory (${tempDir}) does not allow running programs (it is probably mounted noexec), and Freebuff unpacks its terminal renderer there on every start.`
  } else {
    cause = `Freebuff unpacks its terminal renderer into your temp directory (${tempDir}) on every start, and loading it from there failed.`
  }
  const lines = [
    'Freebuff could not load its terminal renderer.',
    '',
    cause,
    `Free up space there, or start Freebuff with TMPDIR pointing at a writable directory that allows programs, for example:`,
    process.platform === 'win32'
      ? '  set the TMPDIR environment variable to a folder such as %USERPROFILE%\\freebuff-tmp'
      : '  mkdir -p "$HOME/.cache/freebuff-tmp" && TMPDIR="$HOME/.cache/freebuff-tmp" freebuff',
    '',
    `Details: ${detail}`,
  ]
  if (fallbackError !== undefined) {
    lines.push(`Fallback copy: ${errorMessage(fallbackError)}`)
  }
  return new RenderLibraryLoadError(lines.join('\n'))
}

/**
 * Install `library` into `directory` under a content-addressed name, reusing
 * an existing install. Atomic: written beside the target, then renamed, so a
 * crash mid-write never leaves a truncated library to be loaded later.
 */
export async function installRenderLibrary(
  library: EmbeddedFile,
  directory: string,
): Promise<string> {
  const bytes = new Uint8Array(await library.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  const extension = path.extname(library.name ?? '') || '.so'
  const fileName = `${CACHED_LIBRARY_PREFIX}${digest}${extension}`
  const target = path.join(directory, fileName)

  if (existsSync(target) && statSync(target).size === bytes.byteLength) {
    return target
  }

  mkdirSync(directory, { recursive: true })
  const staging = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(staging, bytes, { mode: 0o755 })
    try {
      renameSync(staging, target)
    } catch (error) {
      // Windows refuses to replace a DLL another Freebuff has loaded; that
      // copy is the same content-addressed bytes, so use it.
      if (!existsSync(target) || statSync(target).size !== bytes.byteLength) {
        throw error
      }
    }
  } finally {
    try {
      rmSync(staging, { force: true })
    } catch {}
  }

  // Earlier CLI versions' copies are dead weight once this one is in place.
  try {
    for (const entry of readdirSync(directory)) {
      if (entry !== fileName && entry.startsWith(CACHED_LIBRARY_PREFIX)) {
        try {
          rmSync(path.join(directory, entry), { force: true })
        } catch {}
      }
    }
  } catch {}

  return target
}

/**
 * Load OpenTUI's renderer, falling back to a copy in the CLI's own config
 * directory when the temp-directory copy Bun makes cannot be loaded. Throws a
 * `RenderLibraryLoadError` that tells the user what to change.
 */
export async function ensureRenderLibrary(
  deps: RenderLibraryDeps,
): Promise<RenderLibrarySource> {
  let bundledError: unknown
  try {
    deps.resolve()
    return 'bundled'
  } catch (error) {
    bundledError = error
  }

  // Only a compiled binary has an embedded copy to fall back to. From source
  // the library is a real file in node_modules, so the failure is not ours.
  const library = findEmbeddedRenderLibrary(deps.embeddedFiles())
  if (!library) throw describeRenderLibraryFailure(bundledError, deps.tempDir())

  let libraryPath: string
  try {
    libraryPath = await installRenderLibrary(library, deps.cacheDir())
  } catch (installError) {
    throw describeRenderLibraryFailure(
      bundledError,
      deps.tempDir(),
      installError,
    )
  }

  try {
    deps.setPath(libraryPath)
    deps.resolve()
    return 'cache'
  } catch (fallbackError) {
    throw describeRenderLibraryFailure(
      bundledError,
      deps.tempDir(),
      fallbackError,
    )
  }
}

function readSlice(
  filePath: string,
  position: number,
  length: number,
): Uint8Array {
  const fd = openSync(filePath, 'r')
  try {
    const buffer = new Uint8Array(length)
    const read = readSync(fd, buffer, 0, length, position)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  )
}

/**
 * Delete stale copies of the renderer library that Bun extracted into the
 * temp directory and never removed. A copy qualifies only when it carries
 * Bun's extraction name and extension, is older than ten minutes, and is
 * either empty (an extraction that hit a full disk) or the embedded library's
 * exact size with identical first and last 64 KiB. Removing one is safe
 * even while a running process has it loaded: POSIX keeps the mapping alive,
 * and Windows refuses to delete a loaded DLL (the error is ignored). Bun never
 * reuses a copy, so nothing ever reads these files again.
 */
export async function sweepLeakedRenderLibraryCopies({
  library,
  tempDir,
  now = Date.now(),
  minAgeMs = STALE_COPY_AGE_MS,
  limit = MAX_COPIES_PER_SWEEP,
}: {
  library: EmbeddedFile
  tempDir: string
  now?: number
  minAgeMs?: number
  limit?: number
}): Promise<{ removed: number; bytes: number }> {
  const extension = path.extname(library.name ?? '')
  const size = library.size
  const compareLength = Math.min(COMPARE_BYTES, size)
  const head = new Uint8Array(
    await library.slice(0, compareLength).arrayBuffer(),
  )
  const tail = new Uint8Array(
    await library.slice(size - compareLength, size).arrayBuffer(),
  )

  let entries: string[]
  try {
    entries = readdirSync(tempDir)
  } catch {
    return { removed: 0, bytes: 0 }
  }

  let removed = 0
  let reclaimed = 0
  for (const entry of entries) {
    if (removed >= limit) break
    // Runs beside the live renderer: yield between files so a large backlog
    // never holds the event loop.
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (!BUN_EXTRACTED_COPY_NAME.test(entry)) continue
    if (path.extname(entry) !== extension) continue
    const candidate = path.join(tempDir, entry)
    try {
      const stats = statSync(candidate)
      if (!stats.isFile()) continue
      if (now - stats.mtimeMs < minAgeMs) continue
      if (stats.size === 0) {
        // An extraction that failed on a full disk leaves an empty file.
        rmSync(candidate, { force: true })
        removed++
        continue
      }
      if (stats.size !== size) continue
      if (!sameBytes(readSlice(candidate, 0, compareLength), head)) continue
      if (
        !sameBytes(
          readSlice(candidate, size - compareLength, compareLength),
          tail,
        )
      ) {
        continue
      }
      rmSync(candidate, { force: true })
      removed++
      reclaimed += size
    } catch {
      // In use (Windows), raced with another sweep, or unreadable: skip it.
    }
  }
  return { removed, bytes: reclaimed }
}

export function defaultRenderLibraryCacheDir(configDir: string): string {
  return path.join(configDir, 'native')
}

/** Where Bun extracts embedded libraries: BUN_TMPDIR, then TMPDIR, then the OS default. */
export function bunExtractionTempDir(
  env: { BUN_TMPDIR?: string } = getCliEnv(),
): string {
  return env.BUN_TMPDIR || os.tmpdir()
}
