import * as fs from 'fs'
import { randomUUID } from 'node:crypto'
import * as path from 'path'

// Unique per-write temp suffix. A plain `${pid}.tmp` collides when a sync
// exit-flush and an async checkpoint write target the same file concurrently
// (both share the pid): they'd write and rename the SAME temp path, tearing
// each other's output. A random component makes every write self-contained.
function tempPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`
}

/**
 * Owner read/write only: these files are chat transcripts and run state. The
 * temp file is created with this mode and the rename carries the inode, so
 * every rewrite also replaces an older world-readable file with a private one.
 */
const PRIVATE_FILE_MODE = 0o600

/**
 * Every filesystem call an atomic write makes, as one seam.
 *
 * A successful fsync leaves no trace in the resulting file: the only way to
 * tell a durable write from a non-durable one, short of cutting the machine's
 * power, is the sequence of syscalls it makes. Tests substitute a recording
 * delegate here to assert that sequence. Modelled on freebuff-desktop's
 * `JournalStore` (server/repo/session-journal.ts), which exists for the same
 * reason.
 */
export type AtomicWriteFs = {
  openSync: typeof fs.openSync
  writeFileSync: typeof fs.writeFileSync
  fsyncSync: typeof fs.fsyncSync
  closeSync: typeof fs.closeSync
  renameSync: typeof fs.renameSync
  unlinkSync: typeof fs.unlinkSync
  promises: {
    open: typeof fs.promises.open
    rename: typeof fs.promises.rename
    unlink: typeof fs.promises.unlink
  }
}

const nodeAtomicWriteFs: AtomicWriteFs = fs

let activeFs: AtomicWriteFs = nodeAtomicWriteFs

/**
 * Test-only seam, in the style of `setChatDirOverrideForTesting`: bun's
 * `mock.module` leaks across test files, so the durability tests inject a
 * recording delegate instead (see docs/testing.md: DI over module mocking).
 */
export function setAtomicWriteFsForTesting(
  override: AtomicWriteFs | undefined,
): void {
  activeFs = override ?? nodeAtomicWriteFs
}

/**
 * Flush the directory entry itself, so the *name* created by the rename is on
 * disk too. Best-effort: by the time this runs the rename has already
 * succeeded, so an fsync a filesystem refuses for a directory (win32 cannot
 * open one through node:fs at all; some network and fuse mounts answer EINVAL)
 * must not turn a completed write into a thrown error.
 */
function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  try {
    const handle = activeFs.openSync(directory, 'r')
    try {
      activeFs.fsyncSync(handle)
    } finally {
      activeFs.closeSync(handle)
    }
  } catch {
    // See above: the data and the new name are already published.
  }
}

async function syncDirectoryAsync(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const handle = await activeFs.promises.open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // See syncDirectory.
  }
}

/**
 * Write a file atomically *and durably*: write to a temp file in the same
 * directory, flush it, then rename over the target and flush the directory.
 * Chat files grow to multiple MB and are rewritten on every agent step, so a
 * plain writeFileSync interrupted by a crash/kill leaves truncated JSON that
 * hides the chat from /history.
 *
 * The fsync is not optional. Rename is atomic, not durable: flush the contents
 * before publishing the new name, or a power loss can leave a correctly-sized
 * file of NUL bytes — which is what a user whose machine was hard-crashed
 * mid-session got, in place of their whole transcript. Same reasoning, same
 * discipline, as freebuff-desktop's session journal and state file.
 *
 * The cost is deliberate. Every caller writes session state a user cannot
 * reproduce, at human rates — a few writes per turn, plus a checkpoint drain
 * that coalesces to one in-flight write per chat — so none of them pays an
 * fsync per keystroke or per token.
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const tmpPath = tempPathFor(filePath)
  try {
    // 'wx' so a temp path that somehow already exists is a loud error rather
    // than a silent clobber of another write's bytes.
    const fd = activeFs.openSync(tmpPath, 'wx', PRIVATE_FILE_MODE)
    try {
      // Given an fd, writeFileSync loops until every byte is written; a bare
      // writeSync may not.
      activeFs.writeFileSync(fd, data)
      activeFs.fsyncSync(fd)
    } finally {
      activeFs.closeSync(fd)
    }
    activeFs.renameSync(tmpPath, filePath)
    syncDirectory(path.dirname(filePath))
  } catch (error) {
    try {
      activeFs.unlinkSync(tmpPath)
    } catch {
      // Ignore cleanup errors; the original error is what matters
    }
    throw error
  }
}

/**
 * Async counterpart to writeFileAtomic. Used by the in-flight checkpoint writer
 * so serializing + flushing a multi-MB transcript doesn't block the CLI's
 * render/input thread. Same tmp-flush-rename-flush guarantee; the flushes run
 * on the libuv threadpool, not the render thread.
 */
export async function writeFileAtomicAsync(
  filePath: string,
  data: string,
): Promise<void> {
  const tmpPath = tempPathFor(filePath)
  try {
    const handle = await activeFs.promises.open(
      tmpPath,
      'wx',
      PRIVATE_FILE_MODE,
    )
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await activeFs.promises.rename(tmpPath, filePath)
    await syncDirectoryAsync(path.dirname(filePath))
  } catch (error) {
    try {
      await activeFs.promises.unlink(tmpPath)
    } catch {
      // Ignore cleanup errors; the original error is what matters
    }
    throw error
  }
}

/**
 * The async pair of saves in a checkpoint drain both target files and both
 * flush the same directory after the rename (one fsync per write). The sibling
 * helpers below let a caller rename both files first and pay that directory
 * fsync once: flush each tmp file, publish both names, then flush the
 * directory that now holds both.
 *
 * Splitting the write at the rename changes nothing about ordering — the tmp
 * file is still flushed to the platter before its name exists — it only stops
 * flushing a directory whose entry is about to change again a microtask later.
 */
export type AtomicRename = {
  rename: () => Promise<void>
  tmpPath: string
  targetPath: string
}

export async function prepareAtomicWrite(
  filePath: string,
  data: string,
): Promise<AtomicRename> {
  const tmpPath = tempPathFor(filePath)
  try {
    const handle = await activeFs.promises.open(
      tmpPath,
      'wx',
      PRIVATE_FILE_MODE,
    )
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return {
      tmpPath,
      targetPath: filePath,
      rename: () => activeFs.promises.rename(tmpPath, filePath),
    }
  } catch (error) {
    try {
      await activeFs.promises.unlink(tmpPath)
    } catch {
      // Ignore cleanup errors; the original error is what matters
    }
    throw error
  }
}

/** Commit prepared writes: publish every name, then flush the shared
 *  directory once. `prepareAtomicWrite` already dropped prepared tmp files it
 *  could not flush, so a failure here (a rename error) only needs the same
 *  unlink sweep for whatever has not been renamed yet. */
export async function commitAtomicWrites(
  writes: AtomicRename[],
): Promise<void> {
  try {
    for (const write of writes) {
      await write.rename()
    }
  } catch (error) {
    for (const write of writes) {
      try {
        await activeFs.promises.unlink(write.tmpPath)
      } catch {
        // Either renamed already or already gone.
      }
    }
    throw error
  }
  if (writes.length > 0) {
    await syncDirectoryAsync(path.dirname(writes[0].targetPath))
  }
}
