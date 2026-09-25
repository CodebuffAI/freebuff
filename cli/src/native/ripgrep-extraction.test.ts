import { existsSync } from 'fs'
import * as fs from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { extractRipgrep } from './ripgrep-extraction'

describe('ripgrep extraction', () => {
  let directory: string
  let installDir: string
  let cacheDir: string
  const bytes = Buffer.from('#!/bin/sh\necho bundled-ripgrep\n')

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(tmpdir(), 'ripgrep-extraction-'))
    installDir = path.join(directory, 'install')
    cacheDir = path.join(directory, 'cache')
    await fs.mkdir(installDir)
  })

  afterEach(async () => {
    await fs.chmod(installDir, 0o755)
    await fs.rm(directory, { recursive: true, force: true })
  })

  const extract = (content = bytes) =>
    extractRipgrep({
      outPath: path.join(installDir, 'rg'),
      bytes: content,
      getCacheDir: () => cacheDir,
    })

  test('prefers the installation directory without creating a cache', async () => {
    const result = await extract()
    expect(result).toBe(path.join(installDir, 'rg'))
    expect(await fs.readFile(result)).toEqual(bytes)
    expect(existsSync(cacheDir)).toBe(false)
    if (process.platform !== 'win32') {
      expect((await fs.stat(result)).mode & 0o777).toBe(0o755)
    }
    expect(await fs.readdir(installDir)).toEqual(['rg'])
  })

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'runs the extracted binary when the real installation directory is read-only',
    async () => {
      await fs.chmod(installDir, 0o555)
      const results = await Promise.all([extract(), extract(), extract()])
      const result = results[0]
      expect(new Set(results).size).toBe(1)
      expect(result.startsWith(cacheDir + path.sep)).toBe(true)
      expect(await fs.readdir(installDir)).toEqual([])
      expect(await fs.readdir(path.dirname(result))).toEqual(['rg'])
      const proc = Bun.spawn([result], { stdout: 'pipe' })
      expect(await new Response(proc.stdout).text()).toBe('bundled-ripgrep\n')
      expect(await proc.exited).toBe(0)
      // A later launch reuses the cache; a changed bundled binary gets a new path.
      const before = await fs.stat(result)
      expect(await extract()).toBe(result)
      expect((await fs.stat(result)).mtimeMs).toBe(before.mtimeMs)
      const updated = Buffer.from('#!/bin/sh\necho updated-ripgrep\n')
      const updatedPath = await extract(updated)
      expect(updatedPath).not.toBe(result)
      expect(await fs.readFile(updatedPath)).toEqual(updated)
    },
  )

  test('propagates a failed cache write without leaving a partial binary', async () => {
    const cacheError = Object.assign(new Error('cache unavailable'), {
      code: 'EIO',
    })
    const spy = spyOn(fs, 'rename').mockImplementation((_from, to) =>
      Promise.reject(
        String(to).startsWith(installDir + path.sep)
          ? Object.assign(new Error('access denied'), { code: 'EACCES' })
          : cacheError,
      ),
    )
    try {
      await expect(extract()).rejects.toBe(cacheError)
      expect(await fs.readdir(installDir)).toEqual([])
      const [digest] = await fs.readdir(cacheDir)
      expect(await fs.readdir(path.join(cacheDir, digest))).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EIO']) {
    test(`${code}: falls back only for access failures`, async () => {
      const original = fs.rename
      const error = Object.assign(new Error(code), { code })
      const spy = spyOn(fs, 'rename').mockImplementation((from, to) => {
        if (String(to).startsWith(installDir + path.sep)) {
          return Promise.reject(error)
        }
        return original(from, to)
      })
      try {
        if (['EACCES', 'EPERM', 'EROFS'].includes(code)) {
          const result = await extract()
          expect(result.startsWith(cacheDir + path.sep)).toBe(true)
          expect(await fs.readFile(result)).toEqual(bytes)
        } else {
          await expect(extract()).rejects.toBe(error)
          expect(existsSync(cacheDir)).toBe(false)
        }
        expect(await fs.readdir(installDir)).toEqual([])
      } finally {
        spy.mockRestore()
      }
    })
  }
})
