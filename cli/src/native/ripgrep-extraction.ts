import { createHash } from 'crypto'
import { constants } from 'fs'
import * as fs from 'fs/promises'
import path from 'path'

/** Publish only complete, executable binaries, including across concurrent launches. */
async function extractTo(outPath: string, bytes: Uint8Array): Promise<string> {
  const temporaryDir = await fs.mkdtemp(
    path.join(path.dirname(outPath), '.rg-'),
  )
  try {
    const temporaryPath = path.join(temporaryDir, path.basename(outPath))
    await fs.writeFile(temporaryPath, bytes)
    if (process.platform !== 'win32') {
      await fs.chmod(temporaryPath, 0o755)
    }
    await fs.rename(temporaryPath, outPath)
    return outPath
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true })
  }
}

export async function extractRipgrep({
  outPath,
  bytes,
  getCacheDir,
}: {
  outPath: string
  bytes: Uint8Array
  getCacheDir: () => string
}): Promise<string> {
  try {
    return await extractTo(outPath, bytes)
  } catch (error) {
    // System-wide installs can be readable/executable without being writable.
    // Other failures (e.g. disk full) must retain the original error handling.
    const code = (error as NodeJS.ErrnoException)?.code
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') {
      throw error
    }
  }

  // Key by the embedded binary's contents so upgrades never reuse stale bytes.
  const digest = createHash('sha256').update(bytes).digest('hex')
  const cacheDir = path.join(getCacheDir(), digest)
  const cachePath = path.join(cacheDir, path.basename(outPath))
  try {
    await fs.access(cachePath, constants.X_OK)
    return cachePath
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }
  await fs.mkdir(cacheDir, { recursive: true })
  return extractTo(cachePath, bytes)
}
