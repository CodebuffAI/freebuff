import { describe, expect, test } from 'bun:test'
import { truncateFileTreeBasedOnTokenBudget } from '../truncate-file-tree'
import type {
  FileTreeNode,
  ProjectFileContext,
} from '@codebuff/common/util/file'

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any

describe('truncateFileTreeBasedOnTokenBudget', () => {
  test('returns none truncation level when within budget', () => {
    const fileTree: FileTreeNode[] = [
      {
        name: 'index.ts',
        type: 'file',
        filePath: 'src/index.ts',
        lastReadTime: 0,
      },
      {
        name: 'util.ts',
        type: 'file',
        filePath: 'src/util.ts',
        lastReadTime: 0,
      },
    ]

    const fileContext = {
      fileTree,
      fileTokenScores: {
        'src/index.ts': { main: 10 },
      },
    } as unknown as ProjectFileContext

    const result = truncateFileTreeBasedOnTokenBudget({
      fileContext,
      tokenBudget: 5000,
      logger: mockLogger,
    })

    expect(result.truncationLevel).toBe('none')
    expect(result.printedTree).toContain('index.ts')
    expect(result.printedTree).toContain('util.ts')
    expect(result.tokenCount).toBeGreaterThan(0)
    expect(result.tokenCount).toBeLessThanOrEqual(5000)
  })

  test('filters out unimportant build directories and files', () => {
    const fileTree: FileTreeNode[] = [
      {
        name: 'src',
        type: 'directory',
        filePath: '/project/src/',
        children: [
          {
            name: 'main.ts',
            type: 'file',
            filePath: '/project/src/main.ts',
            lastReadTime: 0,
          },
          {
            name: 'bundle.min.js',
            type: 'file',
            filePath: '/project/src/bundle.min.js',
            lastReadTime: 0,
          },
        ],
      },
      {
        name: 'dist',
        type: 'directory',
        filePath: '/project/dist/',
        children: [
          {
            name: 'out.js',
            type: 'file',
            filePath: '/project/dist/out.js',
            lastReadTime: 0,
          },
        ],
      },
    ]

    const fileContext = {
      fileTree,
      fileTokenScores: {},
    } as unknown as ProjectFileContext

    const result = truncateFileTreeBasedOnTokenBudget({
      fileContext,
      tokenBudget: 5000,
      logger: mockLogger,
    })

    expect(result.printedTree).toContain('main.ts')
    expect(result.printedTree).not.toContain('bundle.min.js')
    expect(result.printedTree).not.toContain('dist')
  })

  test('truncates depth-based when token budget is very small', () => {
    const fileTree: FileTreeNode[] = Array.from({ length: 100 }, (_, i) => ({
      name: `file_${i}.ts`,
      type: 'file',
      filePath: `src/deep/nested/sub/path/file_${i}.ts`,
      lastReadTime: 0,
    }))

    const fileContext = {
      fileTree,
      fileTokenScores: {},
    } as unknown as ProjectFileContext

    const result = truncateFileTreeBasedOnTokenBudget({
      fileContext,
      tokenBudget: 50,
      logger: mockLogger,
    })

    expect(result.tokenCount).toBeLessThanOrEqual(150)
    expect(result.truncationLevel).toBe('depth-based')
  })

  test('filters out compiled binary and library files including .so', () => {
    const fileTree: FileTreeNode[] = [
      {
        name: 'app.exe',
        type: 'file',
        filePath: '/project/bin/app.exe',
        lastReadTime: 0,
      },
      {
        name: 'libfoo.so',
        type: 'file',
        filePath: '/project/lib/libfoo.so',
        lastReadTime: 0,
      },
      {
        name: 'libbar.dll',
        type: 'file',
        filePath: '/project/lib/libbar.dll',
        lastReadTime: 0,
      },
      {
        name: 'libbaz.lib',
        type: 'file',
        filePath: '/project/lib/libbaz.lib',
        lastReadTime: 0,
      },
      {
        name: 'valid.ts',
        type: 'file',
        filePath: '/project/src/valid.ts',
        lastReadTime: 0,
      },
    ]

    const fileContext = {
      fileTree,
      fileTokenScores: {},
    } as unknown as ProjectFileContext

    const result = truncateFileTreeBasedOnTokenBudget({
      fileContext,
      tokenBudget: 5000,
      logger: mockLogger,
    })

    expect(result.printedTree).toContain('valid.ts')
    expect(result.printedTree).not.toContain('libfoo.so')
    expect(result.printedTree).not.toContain('app.exe')
    expect(result.printedTree).not.toContain('libbar.dll')
    expect(result.printedTree).not.toContain('libbaz.lib')
  })
})
