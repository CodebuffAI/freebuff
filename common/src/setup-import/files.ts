import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export async function regularText(
  path: string,
  cap: number,
): Promise<string | undefined> {
  try {
    if ((await realpath(path)) !== resolve(path)) throw new Error('Linked file')
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    )
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > cap) throw new Error('Unsupported file')
      const bytes = Buffer.alloc(Math.min(stat.size, cap) + 1)
      let offset = 0
      while (offset < bytes.length) {
        const read = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        )
        if (read.bytesRead === 0) break
        offset += read.bytesRead
      }
      if (offset !== stat.size) throw new Error('File changed while reading')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, offset),
      )
      if (text.includes('\0')) throw new Error('Binary file')
      return text
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

// Bound directory enumeration too: a missing root is ordinary, an unsafe root needs a result.
export async function entries(path: string, limit = 512): Promise<string[]> {
  try {
    if (
      (await realpath(path)) !== resolve(path) ||
      !(await lstat(path)).isDirectory()
    )
      throw new Error('Unsupported directory')
    const dir = await opendir(path)
    const names: string[] = []
    for await (const item of dir) {
      if (item.name.startsWith('.')) continue
      if (names.length >= limit) throw new Error('Too many files')
      names.push(item.name)
    }
    return names.sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function skillResources(root: string) {
  const files: { path: string; contents: string }[] = []
  let total = 0
  let visited = 0
  async function collect(relative: string): Promise<void> {
    for (const name of await entries(join(root, relative), 101)) {
      const path = relative ? relative + '/' + name : name
      if (path === 'SKILL.md') continue
      if (++visited > 200 || path.length > 256)
        throw new Error('Too many resources')
      const stat = await lstat(join(root, path))
      if (stat.isDirectory()) {
        await collect(path)
      } else {
        const contents = await regularText(join(root, path), 100_000)
        if (contents === undefined || files.length >= 100)
          throw new Error('Unsupported resource')
        total += Buffer.byteLength(contents)
        if (total > 2_500_000) throw new Error('Skill is too large')
        files.push({ path, contents })
      }
    }
  }
  await collect('')
  return files
}
