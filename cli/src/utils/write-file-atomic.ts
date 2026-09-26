import * as fs from 'fs'
import { randomUUID } from 'node:crypto'

// Unique per-write temp suffix. A plain `${pid}.tmp` collides when a sync
// exit-flush and an async checkpoint write target the same file concurrently
// (both share the pid): they'd write and rename the SAME temp path, tearing
// each other's output. A random component makes every write self-contained.
function tempPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`
}

/**
 * Flush a file's data to disk before its name goes live. Without this, the
 * rename is durable but the data blocks behind it are not: after a power cut
 * or hard hang the rename can survive while the file's contents were never
 * written, leaving a truncated/garbage file exactly where the atomic rename
 * was supposed to guarantee a complete one. Cheap on tmpfs-sized writes and
 * called at most a few times per second per chat, so correctness wins.
 */
function fsyncFile(fd: number): void {
  try {
    fs.fsyncSync(fd)
  } catch {
    // EINVAL on some filesystems that do not support fsync; nothing useful to
    // do — the rename below is still atomic against concurrent processes.
  }
}

/**
 * Write a file atomically AND durably: write to a temp file in the same
 * directory, fsync it, then rename over the target. Chat files grow to
 * multiple MB and are rewritten on every agent step, so a plain
 * writeFileSync interrupted by a crash/kill leaves truncated JSON that hides
 * the chat from /history — and without the fsync, even this rename pattern
 * leaves a truncated file after a power loss (the rename survives, the data
 * does not; that torn file is what made resumed chats amnesiac).
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const tmpPath = tempPathFor(filePath)
  try {
    const fd = fs.openSync(tmpPath, 'w')
    try {
      fs.writeFileSync(fd, data)
      fsyncFile(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmpPath, filePath)
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // Ignore cleanup errors; the original error is what matters
    }
    throw error
  }
}

/**
 * Rename with a short bounded retry. On Windows the handle closed moments
 * earlier can take a beat to be released by the OS (antivirus/indexer hold a
 * scan lock), and the rename fails with EPERM/EBUSY/EACCES until it is — a
 * transient the sync path also experiences but rarely sees in tests.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to)
      return
    } catch (error) {
      const code = (error as { code?: string }).code ?? ''
      if (attempt >= 4 || !/^(EPERM|EBUSY|EACCES)$/.test(code)) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt))
    }
  }
}

/**
 * Async counterpart to writeFileAtomic. Used by the in-flight checkpoint
 * writer so serializing + flushing a multi-MB transcript doesn't block the
 * CLI's render/input thread. Same tmp-fsync-rename guarantee.
 */
export async function writeFileAtomicAsync(
  filePath: string,
  data: string,
): Promise<void> {
  const tmpPath = tempPathFor(filePath)
  let fileHandle: fs.promises.FileHandle | undefined
  try {
    fileHandle = await fs.promises.open(tmpPath, 'w')
    await fileHandle.writeFile(data)
    try {
      await fileHandle.sync()
    } catch {
      // See the sync path.
    }
    await fileHandle.close()
    fileHandle = undefined
    await renameWithRetry(tmpPath, filePath)
  } catch (error) {
    // closeSync equivalents: FileHandle.close is idempotent-safe to attempt.
    try {
      await fileHandle?.close()
    } catch {
      // Ignore; the original error is what matters.
    }
    try {
      await fs.promises.unlink(tmpPath)
    } catch {
      // Ignore cleanup errors; the original error is what matters
    }
    throw error
  }
}
