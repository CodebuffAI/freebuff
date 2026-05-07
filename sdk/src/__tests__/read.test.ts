import { FILE_READ_STATUS } from '@codebuff/common/old-constants'
import * as projectFileTree from '@codebuff/common/project-file-tree'
import { createNodeError } from '@codebuff/common/testing/errors'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'

import { readFile } from '../tools/read'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { PathLike } from 'node:fs'

function createMockFs(config: {
  files?: Record<
    string,
    { content: string; size?: number; isDirectory?: boolean }
  >
  errors?: Record<string, { code?: string; message?: string }>
}): CodebuffFileSystem {
  const { files = {}, errors = {} } = config

  return {
    readFile: async (filePath: PathLike) => {
      const pathStr = String(filePath)
      if (errors[pathStr]) {
        throw createNodeError(
          errors[pathStr].message || 'Unknown error',
          errors[pathStr].code || 'UNKNOWN',
        )
      }
      if (files[pathStr]) {
        return files[pathStr].content
      }
      throw createNodeError(
        `ENOENT: no such file or directory: ${pathStr}`,
        'ENOENT',
      )
    },
    stat: async (filePath: PathLike) => {
      const pathStr = String(filePath)
      if (errors[pathStr]) {
        throw createNodeError(
          errors[pathStr].message || 'Unknown error',
          errors[pathStr].code || 'UNKNOWN',
        )
      }
      if (files[pathStr]) {
        return {
          size: files[pathStr].size ?? files[pathStr].content.length,
          isDirectory: () => files[pathStr].isDirectory ?? false,
          isFile: () => !(files[pathStr].isDirectory ?? false),
          atimeMs: Date.now(),
          mtimeMs: Date.now(),
        }
      }
      throw createNodeError(
        `ENOENT: no such file or directory: ${pathStr}`,
        'ENOENT',
      )
    },
    readdir: async () => [],
    mkdir: async () => undefined,
    unlink: async () => undefined,
    writeFile: async () => undefined,
  } as unknown as CodebuffFileSystem
}

describe('readFile', () => {
  beforeEach(() => {
    spyOn(projectFileTree, 'isFileIgnored').mockResolvedValue(false)
  })

  afterEach(() => {
    mock.restore()
  })

  test('reads a single text file', async () => {
    const fs = createMockFs({
      files: {
        '/project/src/index.ts': { content: 'console.log("hello")' },
      },
    })

    const result = await readFile({
      filePath: 'src/index.ts',
      cwd: '/project',
      fs,
    })

    expect(result).toEqual({
      path: 'src/index.ts',
      content: 'console.log("hello")',
    })
  })

  test('supports offset and limit with a continuation notice', async () => {
    const fs = createMockFs({
      files: {
        '/project/src/index.ts': {
          content: ['one', 'two', 'three', 'four'].join('\n'),
        },
      },
    })

    const result = await readFile({
      filePath: 'src/index.ts',
      cwd: '/project',
      fs,
      offset: 2,
      limit: 2,
    })

    expect(result).toEqual({
      path: 'src/index.ts',
      content:
        'two\nthree\n\n[1 more lines in file. Use offset=4 to continue.]',
    })
  })

  test('truncates default output after 2000 lines', async () => {
    const fs = createMockFs({
      files: {
        '/project/large.txt': {
          content: Array.from({ length: 2001 }, (_, i) => `line ${i + 1}`).join(
            '\n',
          ),
        },
      },
    })

    const result = await readFile({
      filePath: 'large.txt',
      cwd: '/project',
      fs,
    })

    expect('content' in result ? result.content : '').toContain('line 2000')
    expect('content' in result ? result.content : '').not.toContain('line 2001')
    expect('content' in result ? result.content : '').toContain(
      '[Showing lines 1-2000 of 2001. Use offset=2001 to continue.]',
    )
  })

  test('truncates default output at 50KB', async () => {
    const fs = createMockFs({
      files: {
        '/project/large.txt': {
          content: Array.from({ length: 60 }, () => 'x'.repeat(1000)).join(
            '\n',
          ),
        },
      },
    })

    const result = await readFile({
      filePath: 'large.txt',
      cwd: '/project',
      fs,
    })

    expect('content' in result ? result.content : '').toContain(
      '[Showing lines 1-51 of 60 (50KB limit). Use offset=52 to continue.]',
    )
  })

  test('rejects files over 10MB without reading them', async () => {
    let readCalled = false
    const fs = createMockFs({
      files: {
        '/project/huge.txt': {
          content: 'content should not be read',
          size: 11 * 1024 * 1024,
        },
      },
    })
    fs.readFile = (async () => {
      readCalled = true
      return 'unexpected'
    }) as unknown as CodebuffFileSystem['readFile']

    const result = await readFile({
      filePath: 'huge.txt',
      cwd: '/project',
      fs,
    })

    expect(readCalled).toBe(false)
    expect('errorMessage' in result ? result.errorMessage : '').toContain(
      FILE_READ_STATUS.TOO_LARGE,
    )
  })

  test('returns an error when offset is beyond end of file', async () => {
    const fs = createMockFs({
      files: {
        '/project/src/index.ts': { content: 'one\ntwo' },
      },
    })

    const result = await readFile({
      filePath: 'src/index.ts',
      cwd: '/project',
      fs,
      offset: 3,
    })

    expect(result).toEqual({
      errorMessage: 'Offset 3 is beyond end of file (2 lines total)',
    })
  })

  test('accepts absolute paths inside the project', async () => {
    const fs = createMockFs({
      files: {
        '/project/src/index.ts': { content: 'content' },
      },
    })

    const result = await readFile({
      filePath: '/project/src/index.ts',
      cwd: '/project',
      fs,
    })

    expect(result).toEqual({
      path: 'src/index.ts',
      content: 'content',
    })
  })
})
