import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { evaluateSponsoredWritePath } from '@codebuff/common/ads/sponsored-capabilities'

import { containSponsoredPath } from './sponsored-sandbox'
import {
  sameWindowsPath,
  sponsoredWindowsSegmentRefusal,
  windowsNativePath,
  windowsNativeRelative,
} from './sponsored-windows-paths'

import type { TerminalCommandBroker } from './run-terminal-command'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { FileHandle } from 'node:fs/promises'

type SponsoredFsVerb = 'read files' | 'write'

/** The most a sponsored read returns, as the brokered `cat` it replaced did. */
const READ_LIMIT_BYTES = 16 * 1024 * 1024

/**
 * How a sponsored file operation names a directory WITHOUT re-resolving the
 * path that led to it.
 *
 *  - `proc-fd` (Linux): the directory is held open and named
 *    `/proc/self/fd/<fd>`. The kernel resolves that magic link to the open
 *    directory itself, so `/proc/self/fd/<fd>/<name>` is `openat(fd, name)`.
 *  - `volfs` (macOS): the directory is held open and named by its identity,
 *    `/.vol/<dev>/<ino>`. The kernel looks the directory up by inode, so
 *    `/.vol/<dev>/<ino>/<name>` is `openat` on that directory. Measured on
 *    macOS 26.5 under Node 22 and Bun 1.4: `open`, `lstat`, `mkdir`, `unlink`,
 *    `rename` and `readdir` all resolve through it, and it follows the inode
 *    after the directory is renamed. A volume that does not implement it
 *    (measured: exFAT answers `ENOENT`) is REFUSED by name, never walked by
 *    pathname instead.
 *  - `lstat` (Windows): Node exposes no handle-relative open there, so each
 *    component is `lstat`ed and refused if it is a symlink or a junction, AND
 *    refused unless Windows' own final path for it (`realpathSync.native`) is
 *    the path the walk expects — `lstat` reports only some reparse points as
 *    links and silently follows the rest. Spellings Win32 would reinterpret
 *    (trailing dot or space, `:`, an 8.3 short name) are refused before any
 *    of that; see `sponsored-windows-paths.ts`. READ
 *    `docs/freebuff-sponsored-local-execution.md`, "The file layer without a
 *    shell (COD-642)", before giving Windows an OS sandbox.
 *
 * Every other platform is refused: there is no mechanism, so there is no run.
 */
export type SponsoredDirectoryPinning = 'proc-fd' | 'volfs' | 'lstat'

export function sponsoredDirectoryPinning(
  platform: NodeJS.Platform,
): SponsoredDirectoryPinning | null {
  if (platform === 'linux') return 'proc-fd'
  if (platform === 'darwin') return 'volfs'
  if (platform === 'win32') return 'lstat'
  return null
}

function errorCode(error: unknown): string | null {
  return error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : null
}

/** An error the SDK's tools can branch on by `code`, with a message the run can read. */
function fsError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

function symlinkRefusal(verb: SponsoredFsVerb): NodeJS.ErrnoException {
  return fsError(
    'ELOOP',
    `A sponsored run may not ${verb} through a symlink in its worktree.`,
  )
}

/** A Windows reparse point `lstat` did not report as a link, or any redirect. */
function redirectRefusal(verb: SponsoredFsVerb): NodeJS.ErrnoException {
  return fsError(
    'ELOOP',
    `A sponsored run may not ${verb} through a symlink, junction or mount point in its worktree.`,
  )
}

/**
 * The name a write is staged under, beside its target, before it is renamed
 * over it. Unguessable, so it cannot already exist, and created exclusively.
 */
function stagingName(): string {
  return `.sponsored-write-${randomUUID()}.tmp`
}

function rootedPath(
  workspaceRoot: string,
  requested: unknown,
  verb: SponsoredFsVerb,
  allowMissing: boolean,
): string {
  if (typeof requested !== 'string') {
    throw new Error(`A sponsored run must name the path it wants to ${verb}.`)
  }
  const root = fs.realpathSync(path.resolve(workspaceRoot))
  const resolved = containSponsoredPath(root, requested, verb)
  const relative = path.relative(root, resolved)
  let current = root

  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink()) {
        throw symlinkRefusal(verb)
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT' && allowMissing) break
      throw error
    }
  }
  return resolved
}

/** A directory the next operation is relative to. */
interface DirectoryAnchor {
  /** The canonical path the directory had when it was pinned. Messages only. */
  readonly logical: string
  /** A path naming THIS directory through the pin. */
  readonly self: string
  /** A path naming `name` inside THIS directory through the pin. */
  child(name: string): string
  /**
   * Windows only: where Windows itself resolves this directory, which every
   * step below it must extend by exactly one name.
   */
  readonly native?: string
  close(): Promise<void>
}

interface Identity {
  dev: bigint
  ino: bigint
}

/** The path that names an open directory through the pin, never by its pathname. */
function pinPath(
  pinning: 'proc-fd' | 'volfs',
  fd: number,
  identity: Identity,
): string {
  return pinning === 'proc-fd'
    ? `/proc/self/fd/${fd}`
    : `/.vol/${identity.dev}/${identity.ino}`
}

export type SponsoredFileLayerSupport =
  | { available: true; pinning: SponsoredDirectoryPinning }
  | {
      available: false
      reason: 'no-pin-mechanism' | 'volume-cannot-pin' | 'worktree-unreadable'
    }

/**
 * Whether the sponsored file tools can work in `workspaceRoot` on THIS host,
 * asked the way they will ask: open the worktree, and prove the pin names the
 * directory that was opened.
 *
 * For a surface to call BEFORE Accept. Without it, a macOS project on a volume
 * with no `/.vol` (exFAT, and very likely FAT, SMB or NFS) is accepted and then
 * refused at its first file operation. `platform` exists so a test can name a
 * platform with no mechanism; the probe itself only means anything for the
 * platform it runs on.
 */
export function probeSponsoredFileLayer(
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): SponsoredFileLayerSupport {
  const pinning = sponsoredDirectoryPinning(platform)
  if (!pinning) return { available: false, reason: 'no-pin-mechanism' }
  let root: string
  try {
    root = fs.realpathSync(path.resolve(workspaceRoot))
  } catch {
    return { available: false, reason: 'worktree-unreadable' }
  }
  if (pinning === 'lstat') {
    try {
      windowsNativePath(root)
      return { available: true, pinning }
    } catch {
      return { available: false, reason: 'worktree-unreadable' }
    }
  }
  let fd: number
  try {
    fd = fs.openSync(
      root,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    )
  } catch {
    return { available: false, reason: 'worktree-unreadable' }
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    const named = fs.statSync(pinPath(pinning, fd, opened), {
      bigint: true,
      throwIfNoEntry: false,
    })
    return named && named.dev === opened.dev && named.ino === opened.ino
      ? { available: true, pinning }
      : { available: false, reason: 'volume-cannot-pin' }
  } catch {
    return { available: false, reason: 'volume-cannot-pin' }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * A filesystem capability rooted at one sponsored worktree, with no shell and
 * no process at all (COD-642).
 *
 * It used to run every read, listing and mutation as `/bin/sh` inside the OS
 * broker, so the kernel sandbox bounded whatever a race made the helper touch.
 * That needed a shell and a sandbox, which is why a procedure that only edited
 * files could not run on Windows. It now runs in this process, as the user,
 * and so it has to be race-free ON ITS OWN — a concurrent sandboxed command
 * (a background loop the run started) can swap any directory in the worktree
 * for a symlink at any moment, and a host-side operation that followed it
 * would be the confused deputy the sandbox exists to prevent.
 *
 * So every operation does two things:
 *
 *  1. The existing checks, unchanged: {@link containSponsoredPath} (lexical,
 *     then realpath) and the component-wise `lstat` walk that refuses any
 *     symlink. These produce the NAMED refusals a run reads.
 *  2. The operation itself, resolved by the kernel one component at a time
 *     from a held-open handle on the worktree root — each directory opened
 *     `O_NOFOLLOW` relative to the one before it, the leaf opened `O_NOFOLLOW`
 *     relative to its pinned parent. A component swapped for a symlink after
 *     step 1 is refused by the kernel (`ELOOP`), not followed. A directory
 *     moved after it was pinned can only have been moved by the sandbox, and
 *     so only to somewhere the sandbox may already write.
 *
 * Writes also refuse every class `evaluateSponsoredWritePath` refuses, asked
 * of the path as it resolves AT CHECK TIME, so a symlink inside the worktree
 * that aliases `.git` cannot carry a write the surface guard approved by
 * spelling. And a write never opens its target: the content goes to a fresh
 * file created exclusively beside it and is renamed over it through the pin,
 * so a hard-linked name is replaced rather than written through (this process
 * is not sandboxed, and the other name may be outside the worktree).
 *
 * Directory enumeration reads the pinned directory, never the pathname.
 *
 * The measurements behind this, and what it does not stop, are in
 * `docs/freebuff-sponsored-local-execution.md`, "The file layer without a
 * shell (COD-642)" — private, for the reason `sponsored-sandbox.ts` gives.
 */
export function createSponsoredRootedFileSystem(options: {
  workspaceRoot: string
  /**
   * @deprecated Ignored since COD-642. Write content used to be staged here
   * for the brokered `cp`; the file layer no longer stages anything.
   */
  runtimeDir?: string
  /**
   * @deprecated Ignored since COD-642. The file layer no longer starts a
   * process, so it has no broker to be handed.
   */
  processBroker?: TerminalCommandBroker
  /**
   * TEST SEAM. Called in the two windows a concurrent swap would aim for:
   * `checked`, after the lexical and realpath checks and before the kernel
   * resolves anything; and `pinned`, after each directory on the way (the
   * root first) is held open and before the next step resolves inside it.
   * Production callers never pass it.
   */
  raceWindow?: (
    phase: 'checked' | 'pinned',
    path: string,
  ) => void | Promise<void>
}): CodebuffFileSystem {
  const { workspaceRoot, raceWindow } = options
  const pinning = sponsoredDirectoryPinning(process.platform)
  if (!pinning) {
    // Refuse, never downgrade: see `sponsored-sandbox.ts`.
    throw new Error(
      `A sponsored run's file tools cannot pin a directory on ${process.platform}, so they will not run.`,
    )
  }
  const canonicalRoot = fs.realpathSync(path.resolve(workspaceRoot))
  const rootStat = fs.statSync(canonicalRoot, { bigint: true })
  if (!rootStat.isDirectory()) {
    throw new Error('A sponsored run requires a worktree directory.')
  }
  const rootIdentity: Identity = { dev: rootStat.dev, ino: rootStat.ino }
  // Windows: where Windows itself puts the worktree. Every walk re-derives it
  // and every component must extend it by exactly its own name.
  const nativeRoot =
    pinning === 'lstat' ? windowsNativePath(canonicalRoot) : undefined

  const posix = pinning !== 'lstat'
  const O_NOFOLLOW = posix ? fs.constants.O_NOFOLLOW : 0
  const O_NONBLOCK = posix ? fs.constants.O_NONBLOCK : 0
  const O_DIRECTORY = posix ? fs.constants.O_DIRECTORY : 0
  const DIRECTORY_FLAGS = fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW
  // O_NONBLOCK so a FIFO planted in the worktree fails its regular-file check
  // instead of blocking the open forever. It changes nothing for a file.
  const LEAF_FLAGS = O_NOFOLLOW | O_NONBLOCK

  const segments = (resolved: string): string[] => {
    const parts = path
      .relative(canonicalRoot, resolved)
      .split(path.sep)
      .filter(Boolean)
    for (const part of parts) {
      // `containSponsoredPath` already guarantees this; the pinned walk must
      // not depend on it, because `..` through a pin climbs out of it.
      if (
        part === '.' ||
        part === '..' ||
        part.includes('/') ||
        part.includes('\\') ||
        part.includes('\0')
      ) {
        throw new Error(
          'A sponsored run may only name paths inside its worktree.',
        )
      }
    }
    return parts
  }

  const logicalError = (
    error: unknown,
    verb: SponsoredFsVerb,
    logical: string,
  ): unknown => {
    const code = errorCode(error)
    if (code === 'ELOOP') return symlinkRefusal(verb)
    if (!code) return error
    // Never hand the run a `/proc/self/fd/…` or `/.vol/…` spelling: name the
    // path it asked about, and keep the code the SDK's tools branch on.
    return fsError(code, `${code}: could not ${verb} '${logical}'`)
  }

  const sameIdentity = (a: Identity, b: Identity) =>
    a.dev === b.dev && a.ino === b.ino

  const unsupported = () =>
    fsError(
      'ENOTSUP',
      "A sponsored run cannot use its file tools on this folder's filesystem: it cannot address a directory by identity, which is what keeps these tools inside the worktree.",
    )

  // Whether a pin has been PROVEN to name the directory its handle holds:
  // once per host for /proc, once per volume for /.vol. A property of the
  // mechanism, not of a directory, so it is not re-proven on every step.
  const provenPins = new Set<string>()

  /** Wrap an open directory handle as an anchor, and prove the pin names it. */
  const pinnedAnchor = async (
    handle: FileHandle,
    logical: string,
    expected?: Identity,
  ): Promise<DirectoryAnchor> => {
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isDirectory()) {
        throw fsError('ENOTDIR', `ENOTDIR: '${logical}' is not a directory`)
      }
      if (expected && !sameIdentity(opened, expected)) {
        throw new Error('A sponsored run’s worktree was replaced while it ran.')
      }
      const self = pinPath(pinning as 'proc-fd' | 'volfs', handle.fd, opened)
      // The pin must name the very directory the handle holds. Where it does
      // not (no /proc, a volume without volfs), every operation below would
      // be resolving something else, so refuse rather than walk by pathname.
      const proofKey = pinning === 'proc-fd' ? 'proc' : `vol:${opened.dev}`
      if (!provenPins.has(proofKey)) {
        const named = await fs.promises
          .stat(self, { bigint: true })
          .catch(() => null)
        if (!named || !sameIdentity(named, opened)) throw unsupported()
        provenPins.add(proofKey)
      }
      return {
        logical,
        self,
        child: (name) => `${self}/${name}`,
        close: () => handle.close(),
      }
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  const pathAnchor = (directory: string, native: string): DirectoryAnchor => ({
    logical: directory,
    self: directory,
    child: (name) => path.join(directory, name),
    native,
    close: async () => {},
  })

  /**
   * Windows: refuse `target` unless Windows resolves it to exactly `expected`.
   * `lstat` reports a symlink and a drive-letter junction as links, but not a
   * junction onto a volume GUID path, a mount point, or a reparse tag it does
   * not know — those it FOLLOWS. The final path of an open handle follows all
   * of them, so a difference is a redirect, whatever kind it is.
   */
  const assertWindowsInPlace = (
    target: string,
    expected: string,
    verb: SponsoredFsVerb,
    logical: string,
  ): void => {
    let actual: string
    try {
      actual = windowsNativePath(target)
    } catch (error) {
      throw logicalError(error, verb, logical)
    }
    if (!sameWindowsPath(actual, expected)) throw redirectRefusal(verb)
  }

  const openRoot = async (verb: SponsoredFsVerb): Promise<DirectoryAnchor> => {
    if (pinning === 'lstat') {
      const stat = await fs.promises.lstat(canonicalRoot, { bigint: true })
      if (stat.isSymbolicLink()) throw symlinkRefusal(verb)
      if (!sameIdentity(stat, rootIdentity)) {
        throw new Error('A sponsored run’s worktree was replaced while it ran.')
      }
      assertWindowsInPlace(canonicalRoot, nativeRoot!, verb, canonicalRoot)
      return pathAnchor(canonicalRoot, nativeRoot!)
    }
    const handle = await fs.promises
      .open(canonicalRoot, DIRECTORY_FLAGS)
      .catch((error: unknown) => {
        throw logicalError(error, verb, canonicalRoot)
      })
    // The canonical root's ancestors are outside anything the run may write,
    // but checking the identity means that is not an assumption this relies on.
    return pinnedAnchor(handle, canonicalRoot, rootIdentity)
  }

  const descend = async (
    parent: DirectoryAnchor,
    name: string,
    create: boolean,
    verb: SponsoredFsVerb,
  ): Promise<DirectoryAnchor> => {
    const logical = path.join(parent.logical, name)
    const target = parent.child(name)
    if (create) {
      try {
        await fs.promises.mkdir(target)
      } catch (error) {
        // An existing entry is fine to walk into; the open below decides
        // whether it is a real directory.
        if (errorCode(error) !== 'EEXIST') {
          throw logicalError(error, verb, logical)
        }
      }
    }
    if (pinning === 'lstat') {
      const stat = await fs.promises.lstat(target).catch((error: unknown) => {
        throw logicalError(error, verb, logical)
      })
      if (stat.isSymbolicLink()) throw symlinkRefusal(verb)
      if (!stat.isDirectory()) {
        throw fsError('ENOTDIR', `ENOTDIR: '${logical}' is not a directory`)
      }
      const expected = path.join(parent.native!, name)
      assertWindowsInPlace(target, expected, verb, logical)
      return pathAnchor(target, expected)
    }
    let handle: FileHandle
    try {
      handle = await fs.promises.open(target, DIRECTORY_FLAGS)
    } catch (error) {
      // macOS answers `O_DIRECTORY | O_NOFOLLOW` on a symlink with ENOTDIR
      // rather than ELOOP; say which it was, since only one is a boundary.
      if (errorCode(error) === 'ENOTDIR') {
        const stat = await fs.promises.lstat(target).catch(() => null)
        if (stat?.isSymbolicLink()) throw symlinkRefusal(verb)
      }
      throw logicalError(error, verb, logical)
    }
    return pinnedAnchor(handle, logical)
  }

  /** Walk to the directory named by `parts` and run `operation` against its pin. */
  const withDirectory = async <T>(
    parts: readonly string[],
    create: boolean,
    verb: SponsoredFsVerb,
    operation: (anchor: DirectoryAnchor) => Promise<T>,
  ): Promise<T> => {
    let anchor = await openRoot(verb)
    try {
      await raceWindow?.('pinned', anchor.logical)
      for (const part of parts) {
        const next = await descend(anchor, part, create, verb)
        await anchor.close()
        anchor = next
        await raceWindow?.('pinned', anchor.logical)
      }
      return await operation(anchor)
    } finally {
      await anchor.close()
    }
  }

  const openLeaf = async (
    anchor: DirectoryAnchor,
    leaf: string,
    flags: number,
    verb: SponsoredFsVerb,
    mode?: number,
  ): Promise<FileHandle> => {
    const logical = path.join(anchor.logical, leaf)
    if (pinning === 'lstat') {
      const stat = await fs.promises.lstat(anchor.child(leaf)).catch(() => null)
      if (stat?.isSymbolicLink()) throw symlinkRefusal(verb)
      if (stat) {
        assertWindowsInPlace(
          anchor.child(leaf),
          path.join(anchor.native!, leaf),
          verb,
          logical,
        )
      }
    }
    try {
      return await fs.promises.open(
        anchor.child(leaf),
        flags | LEAF_FLAGS,
        mode,
      )
    } catch (error) {
      throw logicalError(error, verb, logical)
    }
  }

  /**
   * Rename `from` over `to`, both inside the pinned directory. `rename` never
   * follows its destination, so a `to` swapped for a symlink is replaced, not
   * written through. Windows refuses to replace a file another process has
   * open (an editor, an indexer, antivirus), briefly and for no reason of
   * ours, so it gets a few short retries there and nowhere else.
   */
  const renameInDirectory = async (
    anchor: DirectoryAnchor,
    from: string,
    to: string,
    logical: string,
  ): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(anchor.child(from), anchor.child(to))
        return
      } catch (error) {
        const code = errorCode(error)
        const transient =
          pinning === 'lstat' &&
          (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')
        if (!transient || attempt >= 4) {
          throw logicalError(error, 'write', logical)
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
      }
    }
  }

  const lstatLeaf = async (
    anchor: DirectoryAnchor,
    leaf: string,
    verb: SponsoredFsVerb,
  ): Promise<fs.Stats> => {
    const stat = await fs.promises
      .lstat(anchor.child(leaf))
      .catch((error: unknown) => {
        throw logicalError(error, verb, path.join(anchor.logical, leaf))
      })
    if (stat.isSymbolicLink()) throw symlinkRefusal(verb)
    if (pinning === 'lstat') {
      assertWindowsInPlace(
        anchor.child(leaf),
        path.join(anchor.native!, leaf),
        verb,
        path.join(anchor.logical, leaf),
      )
    }
    return stat
  }

  /**
   * The surface's path-CLASS refusals, applied to the path the write resolves
   * to AT CHECK TIME. What resolves later is the walk's business, not this
   * check's: a swap after it is refused by the pin, not by the class table.
   *
   * On Windows the table is asked twice: of the spelling, and of where Windows
   * itself resolves that spelling, so a name the table does not recognise
   * cannot land on one it would refuse.
   */
  const assertWritableClass = (resolved: string) => {
    const relative = path.relative(canonicalRoot, resolved)
    if (!relative) return
    const candidates = [relative]
    if (pinning === 'lstat') {
      const native = windowsNativeRelative(nativeRoot!, resolved)
      // The spelled path already passed containment, so landing outside can
      // only mean something on the way redirects: say that, not "outside".
      if (native === null) throw redirectRefusal('write')
      if (native) candidates.push(native)
    }
    for (const candidate of candidates) {
      const decision = evaluateSponsoredWritePath(
        candidate.split(path.sep).join('/'),
        { workspaceRoot: canonicalRoot },
      )
      if (!decision.allowed) throw fsError('EACCES', decision.message)
    }
  }

  /** Windows: refuse a spelling Win32 would open as something else. */
  const assertWindowsSpelling = (target: string) => {
    const relative = path.relative(canonicalRoot, target)
    // Outside the root lexically: the containment check says so, by name.
    if (relative.startsWith('..') || path.isAbsolute(relative)) return
    for (const part of relative.split(path.sep).filter(Boolean)) {
      const refusal = sponsoredWindowsSegmentRefusal(part)
      if (refusal) throw fsError('EINVAL', refusal)
    }
  }

  const checked = async (
    requested: unknown,
    verb: SponsoredFsVerb,
    allowMissing: boolean,
  ): Promise<string> => {
    // Windows: the spelling is judged BEFORE anything is looked up by it, or
    // `name::$DATA` would be resolved (to `name`) before it was refused.
    if (pinning === 'lstat' && typeof requested === 'string') {
      assertWindowsSpelling(path.resolve(canonicalRoot, requested))
    }
    const resolved = rootedPath(workspaceRoot, requested, verb, allowMissing)
    if (pinning === 'lstat') assertWindowsSpelling(resolved)
    await raceWindow?.('checked', resolved)
    return resolved
  }

  return {
    mkdir: async (
      requested: string,
      options?: fs.MakeDirectoryOptions & { recursive?: boolean },
    ) => {
      const resolved = await checked(requested, 'write', true)
      assertWritableClass(resolved)
      const parts = segments(resolved)
      // Recursive unless told otherwise, as the brokered helper was.
      if (options?.recursive === false) {
        const leaf = parts.pop()
        if (!leaf) return undefined
        await withDirectory(parts, false, 'write', async (anchor) => {
          await fs.promises
            .mkdir(anchor.child(leaf))
            .catch((error: unknown) => {
              throw logicalError(error, 'write', resolved)
            })
        })
      } else {
        await withDirectory(parts, true, 'write', async () => {})
      }
      return undefined
    },
    readdir: async (requested: string, options?: unknown) => {
      const resolved = await checked(requested, 'read files', false)
      const parts = segments(resolved)
      const listed = await withDirectory(parts, false, 'read files', (anchor) =>
        fs.promises
          .readdir(anchor.self, { withFileTypes: true })
          .catch((error: unknown) => {
            throw logicalError(error, 'read files', resolved)
          }),
      )
      const entries = listed.map((entry) => ({
        name: entry.name,
        parentPath: resolved,
        path: resolved,
        isBlockDevice: () => entry.isBlockDevice(),
        isCharacterDevice: () => entry.isCharacterDevice(),
        isDirectory: () => entry.isDirectory(),
        isFIFO: () => entry.isFIFO(),
        isFile: () => entry.isFile(),
        isSocket: () => entry.isSocket(),
        isSymbolicLink: () => entry.isSymbolicLink(),
      }))
      const withFileTypes =
        options !== null &&
        typeof options === 'object' &&
        'withFileTypes' in options &&
        options.withFileTypes === true
      return (
        withFileTypes ? entries : entries.map((entry) => entry.name)
      ) as never
    },
    readFile: async (requested: string, options?: unknown) => {
      const resolved = await checked(requested, 'read files', false)
      const parts = segments(resolved)
      const leaf = parts.pop()
      if (!leaf) {
        throw fsError(
          'EISDIR',
          'EISDIR: a sponsored run cannot read a directory as a file',
        )
      }
      const output = await withDirectory(
        parts,
        false,
        'read files',
        async (anchor) => {
          const handle = await openLeaf(
            anchor,
            leaf,
            fs.constants.O_RDONLY,
            'read files',
          )
          try {
            const stat = await handle.stat()
            if (stat.isDirectory()) {
              throw fsError('EISDIR', `EISDIR: '${resolved}' is a directory`)
            }
            if (!stat.isFile()) {
              throw fsError(
                'EINVAL',
                'A sponsored run may only read regular files in its worktree.',
              )
            }
            // Bounded by what is read, not by what `stat` said: a file that
            // grows while it is read must not outrun the limit.
            const chunks: Buffer[] = []
            let length = 0
            for (;;) {
              const chunk = Buffer.allocUnsafe(64 * 1024)
              const { bytesRead } = await handle.read(
                chunk,
                0,
                chunk.length,
                null,
              )
              if (bytesRead === 0) break
              length += bytesRead
              if (length > READ_LIMIT_BYTES) {
                throw fsError(
                  'EFBIG',
                  'A sponsored run may not read a file larger than 16 MiB.',
                )
              }
              chunks.push(chunk.subarray(0, bytesRead))
            }
            return Buffer.concat(chunks, length)
          } finally {
            await handle.close()
          }
        },
      )
      const encoding =
        typeof options === 'string'
          ? options
          : options && typeof options === 'object' && 'encoding' in options
            ? options.encoding
            : null
      return encoding ? output.toString(encoding as BufferEncoding) : output
    },
    stat: async (requested: string) => {
      const resolved = await checked(requested, 'read files', false)
      const parts = segments(resolved)
      const leaf = parts.pop()
      return withDirectory(parts, false, 'read files', async (anchor) => {
        if (leaf) return lstatLeaf(anchor, leaf, 'read files')
        // The worktree root itself. Through the pin, never by pathname.
        return pinning === 'lstat'
          ? fs.promises.lstat(anchor.self)
          : fs.promises.stat(anchor.self)
      })
    },
    unlink: async (requested: string) => {
      const resolved = await checked(requested, 'write', false)
      assertWritableClass(resolved)
      const parts = segments(resolved)
      const leaf = parts.pop()
      if (!leaf) {
        throw new Error('A sponsored run cannot remove its worktree root.')
      }
      await withDirectory(parts, false, 'write', async (anchor) => {
        // A symlink leaf is refused rather than removed, as it always was.
        await lstatLeaf(anchor, leaf, 'write')
        await fs.promises.unlink(anchor.child(leaf)).catch((error: unknown) => {
          throw logicalError(error, 'write', resolved)
        })
      })
    },
    writeFile: async (
      requested: string,
      data: string | NodeJS.ArrayBufferView,
      options?: unknown,
    ) => {
      const resolved = await checked(requested, 'write', true)
      const optionObject =
        options && typeof options === 'object'
          ? (options as {
              flag?: string
              mode?: number
              encoding?: BufferEncoding
            })
          : null
      if (optionObject?.flag && optionObject.flag !== 'w') {
        throw new Error('Sponsored file writes only support replacing a file.')
      }
      const encoding =
        typeof options === 'string'
          ? (options as BufferEncoding)
          : (optionObject?.encoding ?? 'utf8')
      let content: Buffer
      if (typeof data === 'string') {
        content = Buffer.from(data, encoding)
      } else if (ArrayBuffer.isView(data)) {
        content = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      } else {
        throw new TypeError('Sponsored file writes take a string or bytes.')
      }
      assertWritableClass(resolved)
      const parts = segments(resolved)
      const leaf = parts.pop()
      if (!leaf) {
        throw new Error('A sponsored run cannot replace its worktree root.')
      }
      await withDirectory(parts, true, 'write', async (anchor) => {
        // ATOMIC: the content is written to a fresh file beside the target,
        // created exclusively and without following links, and then RENAMED
        // over the target through the same pin. The target's inode is never
        // opened for writing, so a hard-linked name is replaced rather than
        // written through, and no reader ever sees half a file.
        const existing = await lstatLeaf(anchor, leaf, 'write').catch(
          (error: unknown) => {
            if (errorCode(error) === 'ENOENT') return null
            throw error
          },
        )
        if (existing?.isDirectory()) {
          throw fsError('EISDIR', `EISDIR: '${resolved}' is a directory`)
        }
        if (existing && !existing.isFile()) {
          throw fsError(
            'EINVAL',
            'A sponsored run may only write regular files in its worktree.',
          )
        }
        // A replaced file keeps its permission bits (an executable script
        // stays executable); a new one gets the usual 0666 less the umask.
        const mode = existing ? existing.mode & 0o777 : 0o666
        const staged = stagingName()
        const handle = await openLeaf(
          anchor,
          staged,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
          'write',
          mode,
        )
        let renamed = false
        try {
          try {
            // The umask narrowed the create; the replacement must not.
            if (posix && existing) await handle.chmod(mode)
            let offset = 0
            while (offset < content.length) {
              const { bytesWritten } = await handle.write(
                content,
                offset,
                content.length - offset,
                offset,
              )
              offset += bytesWritten
            }
          } finally {
            await handle.close()
          }
          await renameInDirectory(anchor, staged, leaf, resolved)
          renamed = true
        } finally {
          if (!renamed) {
            await fs.promises.unlink(anchor.child(staged)).catch(() => {})
          }
        }
      })
    },
  } as unknown as CodebuffFileSystem
}
