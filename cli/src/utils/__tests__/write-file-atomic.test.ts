import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  setAtomicWriteFsForTesting,
  writeFileAtomic,
  writeFileAtomicAsync,
} from '../write-file-atomic'

import type { AtomicWriteFs } from '../write-file-atomic'

let tempDir = ''

describe('writeFileAtomic', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuff-atomic-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('writes a new file', () => {
    const target = path.join(tempDir, 'out.json')

    writeFileAtomic(target, '{"a":1}')

    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}')
  })

  test('replaces an existing file', () => {
    const target = path.join(tempDir, 'out.json')
    fs.writeFileSync(target, 'old content')

    writeFileAtomic(target, 'new content')

    expect(fs.readFileSync(target, 'utf8')).toBe('new content')
  })

  test('leaves no temp file behind on success', () => {
    const target = path.join(tempDir, 'out.json')

    writeFileAtomic(target, 'data')

    expect(fs.readdirSync(tempDir)).toEqual(['out.json'])
  })

  test('cleans up the temp file and rethrows on failure', () => {
    // Renaming a file over an existing directory fails on all platforms
    const target = path.join(tempDir, 'target-dir')
    fs.mkdirSync(target)

    expect(() => writeFileAtomic(target, 'data')).toThrow()

    expect(fs.readdirSync(tempDir)).toEqual(['target-dir'])
  })

  test('uses a unique temp name per write (no collision between calls)', () => {
    // Two writes to different targets must not share a temp path, otherwise
    // concurrent sync + async writes would tear each other. The temp name
    // includes a random component, so back-to-back writes never collide.
    const a = path.join(tempDir, 'a.json')
    const b = path.join(tempDir, 'b.json')

    writeFileAtomic(a, 'a')
    writeFileAtomic(b, 'b')

    expect(fs.readdirSync(tempDir).sort()).toEqual(['a.json', 'b.json'])
  })
})

describe('writeFileAtomicAsync', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuff-atomic-async-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('writes a new file', async () => {
    const target = path.join(tempDir, 'out.json')

    await writeFileAtomicAsync(target, '{"a":1}')

    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}')
  })

  test('replaces an existing file', async () => {
    const target = path.join(tempDir, 'out.json')
    fs.writeFileSync(target, 'old content')

    await writeFileAtomicAsync(target, 'new content')

    expect(fs.readFileSync(target, 'utf8')).toBe('new content')
  })

  test('leaves no temp file behind on success', async () => {
    const target = path.join(tempDir, 'out.json')

    await writeFileAtomicAsync(target, 'data')

    expect(fs.readdirSync(tempDir)).toEqual(['out.json'])
  })

  test('cleans up the temp file and rejects on failure', async () => {
    const target = path.join(tempDir, 'target-dir')
    fs.mkdirSync(target)

    await expect(writeFileAtomicAsync(target, 'data')).rejects.toThrow()

    expect(fs.readdirSync(tempDir)).toEqual(['target-dir'])
  })

  test('concurrent writes to the same file do not tear (last write wins)', async () => {
    const target = path.join(tempDir, 'out.json')

    await Promise.all([
      writeFileAtomicAsync(target, 'first'),
      writeFileAtomicAsync(target, 'second'),
      writeFileAtomicAsync(target, 'third'),
    ])

    // Whichever rename lands last wins, but the file is always one intact
    // value — never a torn mix — and no temp files remain.
    expect(['first', 'second', 'third']).toContain(
      fs.readFileSync(target, 'utf8'),
    )
    expect(fs.readdirSync(tempDir)).toEqual(['out.json'])
  })
})

/**
 * A successful fsync leaves no trace in the file it flushed, so durability can
 * only be asserted through the syscalls. These wrap the real fs — every call
 * still happens for real — and record the order, which is the thing that
 * matters: the contents must be on disk before the rename publishes the name,
 * or a crash can leave a correctly-sized file of NUL bytes where the user's
 * transcript was.
 */
function recordingFs(): { calls: string[]; fs: AtomicWriteFs } {
  const calls: string[] = []
  return {
    calls,
    fs: {
      openSync: (...args: Parameters<typeof fs.openSync>) => {
        calls.push('openSync')
        return fs.openSync(...args)
      },
      writeFileSync: ((...args: any[]) => {
        calls.push('writeFileSync')
        return (fs.writeFileSync as any)(...args)
      }) as typeof fs.writeFileSync,
      fsyncSync: (fd: number) => {
        calls.push('fsyncSync')
        return fs.fsyncSync(fd)
      },
      closeSync: (fd: number) => {
        calls.push('closeSync')
        return fs.closeSync(fd)
      },
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        calls.push('renameSync')
        return fs.renameSync(from, to)
      },
      unlinkSync: (target: fs.PathLike) => {
        calls.push('unlinkSync')
        return fs.unlinkSync(target)
      },
      promises: {
        open: async (...args: Parameters<typeof fs.promises.open>) => {
          calls.push('open')
          const handle = await fs.promises.open(...args)
          return {
            writeFile: (data: any) => {
              calls.push('writeFile')
              return handle.writeFile(data)
            },
            sync: () => {
              calls.push('sync')
              return handle.sync()
            },
            close: () => {
              calls.push('close')
              return handle.close()
            },
          } as any
        },
        rename: (from: fs.PathLike, to: fs.PathLike) => {
          calls.push('rename')
          return fs.promises.rename(from, to)
        },
        unlink: (target: fs.PathLike) => {
          calls.push('unlink')
          return fs.promises.unlink(target)
        },
      },
    },
  }
}

describe('durability', () => {
  let recorder: ReturnType<typeof recordingFs>

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuff-atomic-fsync-'))
    recorder = recordingFs()
    setAtomicWriteFsForTesting(recorder.fs)
  })

  afterEach(() => {
    setAtomicWriteFsForTesting(undefined)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('flushes the contents before the rename publishes the name', () => {
    writeFileAtomic(path.join(tempDir, 'out.json'), '{"a":1}')

    const fsyncBeforeRename =
      recorder.calls.indexOf('fsyncSync') < recorder.calls.indexOf('renameSync')
    expect(recorder.calls).toContain('fsyncSync')
    expect(recorder.calls).toContain('renameSync')
    expect(fsyncBeforeRename).toBe(true)
    expect(recorder.calls.slice(0, 5)).toEqual([
      'openSync',
      'writeFileSync',
      'fsyncSync',
      'closeSync',
      'renameSync',
    ])
  })

  test('flushes the directory entry after the rename', () => {
    writeFileAtomic(path.join(tempDir, 'out.json'), '{"a":1}')

    // openSync(dir, 'r') + fsyncSync + closeSync, after the rename.
    expect(recorder.calls.slice(5)).toEqual([
      'openSync',
      'fsyncSync',
      'closeSync',
    ])
  })

  test('does not publish the name when the flush fails', () => {
    const target = path.join(tempDir, 'out.json')
    fs.writeFileSync(target, 'the previous good transcript')
    recorder.fs.fsyncSync = () => {
      throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' })
    }

    expect(() => writeFileAtomic(target, 'replacement')).toThrow()

    // An unflushed write is exactly the one that must not take the name: the
    // caller keeps the old file, which is readable, instead of a new one that
    // might not be.
    expect(fs.readFileSync(target, 'utf8')).toBe('the previous good transcript')
    expect(recorder.calls).not.toContain('renameSync')
    expect(fs.readdirSync(tempDir)).toEqual(['out.json'])
  })

  test('async: flushes the contents before the rename publishes the name', async () => {
    await writeFileAtomicAsync(path.join(tempDir, 'out.json'), '{"a":1}')

    expect(recorder.calls.slice(0, 5)).toEqual([
      'open',
      'writeFile',
      'sync',
      'close',
      'rename',
    ])
  })

  test('async: flushes the directory entry after the rename', async () => {
    await writeFileAtomicAsync(path.join(tempDir, 'out.json'), '{"a":1}')

    expect(recorder.calls.slice(5)).toEqual(['open', 'sync', 'close'])
  })

  test('async: does not publish the name when the flush fails', async () => {
    const target = path.join(tempDir, 'out.json')
    fs.writeFileSync(target, 'the previous good transcript')
    const realOpen = recorder.fs.promises.open
    recorder.fs.promises.open = (async (...args: any[]) => {
      const handle = await (realOpen as any)(...args)
      return {
        ...handle,
        writeFile: (data: any) => handle.writeFile(data),
        sync: () => Promise.reject(new Error('EIO: i/o error, fsync')),
        close: () => handle.close(),
      }
    }) as any

    await expect(writeFileAtomicAsync(target, 'replacement')).rejects.toThrow()

    expect(fs.readFileSync(target, 'utf8')).toBe('the previous good transcript')
    expect(recorder.calls).not.toContain('rename')
    expect(fs.readdirSync(tempDir)).toEqual(['out.json'])
  })
})

// POSIX mode bits only; Windows has no owner/group/other split to assert.
describe.skipIf(process.platform === 'win32')('private file mode', () => {
  const modeOf = (file: string) => fs.statSync(file).mode & 0o777

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuff-atomic-mode-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('creates the file owner read/write only', () => {
    const target = path.join(tempDir, 'chat-messages.json')

    writeFileAtomic(target, '[]')

    expect(modeOf(target)).toBe(0o600)
  })

  test('replacing a world-readable file leaves it owner-only', () => {
    const target = path.join(tempDir, 'run-state.json')
    fs.writeFileSync(target, 'old', { mode: 0o644 })
    fs.chmodSync(target, 0o644)

    writeFileAtomic(target, 'new')

    expect(modeOf(target)).toBe(0o600)
  })

  test('async: replacing a world-readable file leaves it owner-only', async () => {
    const target = path.join(tempDir, 'chat-messages.json')
    fs.writeFileSync(target, 'old', { mode: 0o644 })
    fs.chmodSync(target, 0o644)

    await writeFileAtomicAsync(target, '[]')

    expect(modeOf(target)).toBe(0o600)
  })
})
