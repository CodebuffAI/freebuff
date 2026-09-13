import { describe, expect, it, mock } from 'bun:test'

import path from 'path'

import { listDirectory } from '../tools/list-directory'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { Dirent, PathLike, Stats } from 'node:fs'

const PROJECT_ROOT = path.resolve('workspace', 'project')

function createFs(
  realpaths: Record<string, string>,
  options: {
    /** Called for each stat, so a test can make the directory change identity. */
    identities?: Array<{ dev: number; ino: number }>
    /** Realpath answers to use once the listing has been read. */
    realpathsAfterRead?: Record<string, string>
  } = {},
) {
  const readdir = mock(async (_path: PathLike) => {
    return [
      {
        name: 'index.ts',
        isDirectory: () => false,
        isFile: () => true,
      },
    ] as Dirent[]
  })

  const identities = options.identities ?? []
  let statCalls = 0
  const stat = mock(async (_path: PathLike) => {
    const identity = identities[statCalls] ?? { dev: 1, ino: 1 }
    statCalls += 1
    return identity as unknown as Stats
  })

  let listed = false
  readdir.mockImplementation(async (_path: PathLike) => {
    listed = true
    return [
      {
        name: 'index.ts',
        isDirectory: () => false,
        isFile: () => true,
      },
    ] as Dirent[]
  })

  const fs = {
    realpath: mock(async (path: PathLike) => {
      const pathString = String(path)
      const table =
        listed && options.realpathsAfterRead ? options.realpathsAfterRead : realpaths
      return table[pathString] ?? realpaths[pathString] ?? pathString
    }),
    readdir,
    stat,
  } as unknown as CodebuffFileSystem

  return { fs, readdir, stat }
}

describe('listDirectory', () => {
  it('allows listing the project root itself', async () => {
    const { fs, readdir } = createFs({
      [PROJECT_ROOT]: PROJECT_ROOT,
    })

    const result = await listDirectory({
      directoryPath: '.',
      projectPath: PROJECT_ROOT,
      fs,
    })

    expect(result[0]).toEqual({
      type: 'json',
      value: {
        files: ['index.ts'],
        directories: [],
        path: '.',
      },
    })
    expect(readdir).toHaveBeenCalledWith(PROJECT_ROOT, {
      withFileTypes: true,
    })
  })

  it('lists a directory inside the project and preserves the requested path', async () => {
    const childPath = path.join(PROJECT_ROOT, 'src')
    const { fs, readdir } = createFs({
      [PROJECT_ROOT]: PROJECT_ROOT,
      [childPath]: childPath,
    })

    const result = await listDirectory({
      directoryPath: 'src',
      projectPath: PROJECT_ROOT,
      fs,
    })

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          files: ['index.ts'],
          directories: [],
          path: 'src',
        },
      },
    ])
    expect(readdir).toHaveBeenCalledWith(childPath, {
      withFileTypes: true,
    })
  })

  it('returns the normal list error when the requested directory is missing', async () => {
    const missingPath = path.join(PROJECT_ROOT, 'missing')
    const readdir = mock(async (_path: PathLike) => [] as Dirent[])
    const fs = {
      realpath: mock(async (requestedPath: PathLike) => {
        const requestedPathString = String(requestedPath)
        if (requestedPathString === missingPath) {
          throw new Error(
            `ENOENT: no such file or directory, realpath '${missingPath}'`,
          )
        }
        return requestedPathString
      }),
      readdir,
    } as unknown as CodebuffFileSystem

    const result = await listDirectory({
      directoryPath: 'missing',
      projectPath: PROJECT_ROOT,
      fs,
    })

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          errorMessage: `Failed to list directory: ENOENT: no such file or directory, realpath '${missingPath}'`,
        },
      },
    ])
    expect(readdir).not.toHaveBeenCalled()
  })

  it('rejects sibling paths that only share the project prefix', async () => {
    const siblingPath = path.resolve(PROJECT_ROOT, '..', 'project-evil')
    const { fs, readdir } = createFs({
      [PROJECT_ROOT]: PROJECT_ROOT,
      [siblingPath]: siblingPath,
    })

    const result = await listDirectory({
      directoryPath: '../project-evil',
      projectPath: PROJECT_ROOT,
      fs,
    })

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          errorMessage:
            "Invalid path: Path '../project-evil' is outside the project directory.",
        },
      },
    ])
    expect(readdir).not.toHaveBeenCalled()
  })

  it('rejects the project parent directory', async () => {
    const parentPath = path.dirname(PROJECT_ROOT)
    const { fs, readdir } = createFs({
      [PROJECT_ROOT]: PROJECT_ROOT,
      [parentPath]: parentPath,
    })

    const result = await listDirectory({
      directoryPath: '..',
      projectPath: PROJECT_ROOT,
      fs,
    })

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          errorMessage:
            "Invalid path: Path '..' is outside the project directory.",
        },
      },
    ])
    expect(readdir).not.toHaveBeenCalled()
  })

  it('rejects directories that escape through a symlink', async () => {
    const symlinkPath = path.join(PROJECT_ROOT, 'link')
    const outsidePath = path.resolve(PROJECT_ROOT, '..', 'outside')
    const { fs, readdir } = createFs({
      [PROJECT_ROOT]: PROJECT_ROOT,
      [symlinkPath]: outsidePath,
    })

    const result = await listDirectory({
      directoryPath: 'link',
      projectPath: PROJECT_ROOT,
      fs,
    })

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          errorMessage:
            "Invalid path: Path 'link' is outside the project directory.",
        },
      },
    ])
    expect(readdir).not.toHaveBeenCalled()
  })

  it('refuses a listing whose directory was swapped while it was read', async () => {
    // The check approved one inode; by the time the read finished the path was a
    // different one. Returning that listing is the escape the check exists to stop.
    const { fs } = createFs(
      { [PROJECT_ROOT]: PROJECT_ROOT },
      {
        identities: [
          { dev: 1, ino: 1 },
          { dev: 1, ino: 2 },
        ],
      },
    )

    const result = await listDirectory({
      directoryPath: '.',
      projectPath: PROJECT_ROOT,
      fs,
    })

    expect(result[0]).toEqual({
      type: 'json',
      value: {
        errorMessage: `Invalid path: Path '.' changed while it was being read.`,
      },
    })
  })

  it('refuses a listing whose path started resolving outside the project', async () => {
    const childPath = path.join(PROJECT_ROOT, 'src')
    const outsidePath = path.resolve('workspace', 'other', 'src')
    const { fs } = createFs(
      { [PROJECT_ROOT]: PROJECT_ROOT, [childPath]: childPath },
      { realpathsAfterRead: { [childPath]: outsidePath } },
    )

    const result = await listDirectory({
      directoryPath: 'src',
      projectPath: PROJECT_ROOT,
      fs,
    })

    expect(result[0]).toEqual({
      type: 'json',
      value: {
        errorMessage: `Invalid path: Path 'src' changed while it was being read.`,
      },
    })
  })

  it('allows a symlink that resolves inside the project', async () => {
    const symlinkPath = path.join(PROJECT_ROOT, 'link')
    const realTarget = path.join(PROJECT_ROOT, 'src')
    const { fs, readdir } = createFs({
      [PROJECT_ROOT]: PROJECT_ROOT,
      [symlinkPath]: realTarget,
    })

    const result = await listDirectory({
      directoryPath: 'link',
      projectPath: PROJECT_ROOT,
      fs,
    })

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          files: ['index.ts'],
          directories: [],
          path: 'link',
        },
      },
    ])
    expect(readdir).toHaveBeenCalledWith(realTarget, {
      withFileTypes: true,
    })
  })
})
