import os from 'os'
import path from 'path'

import { describe, expect, it } from 'bun:test'

import {
  flattenTree,
  getAllPathsWithDirectories,
  getProjectFileTree,
  isFileIgnored,
} from '../project-file-tree'
import { createMockFs } from '../testing/mocks/filesystem'

/**
 * Builds a mock fs from relative file paths under `root`, inferring
 * intermediate directories.
 */
function createFsWithFiles(root: string, files: string[]) {
  const fileRecords: Record<string, string> = {}
  const dirChildren: Record<string, Set<string>> = { [root]: new Set() }
  for (const file of files) {
    fileRecords[path.join(root, file)] = ''
    let child = path.join(root, file)
    let dir = path.dirname(child)
    while (true) {
      ;(dirChildren[dir] ??= new Set()).add(path.basename(child))
      if (dir === root) break
      child = dir
      dir = path.dirname(dir)
    }
  }
  return createMockFs({
    files: fileRecords,
    directories: Object.fromEntries(
      Object.entries(dirChildren).map(([dir, names]) => [dir, [...names]]),
    ),
  })
}

describe('getProjectFileTree', () => {
  it('scans the home directory shallowly instead of returning nothing', async () => {
    const home = os.homedir()
    const fs = createFsWithFiles(home, [
      'top-level.txt',
      'proj/README.md',
      'proj/docs/guide.md',
      'proj/docs/deep/too-deep.md',
      '.hidden/secret.txt',
    ])

    const tree = await getProjectFileTree({ projectRoot: home, fs })
    const paths = getAllPathsWithDirectories(tree).map((p) => p.path)

    // Files up to 3 levels deep are included
    expect(paths).toContain('top-level.txt')
    expect(paths).toContain(path.join('proj', 'README.md'))
    expect(paths).toContain(path.join('proj', 'docs', 'guide.md'))
    // The depth-3 directory shows up as a node, but its contents do not
    expect(paths).toContain(path.join('proj', 'docs', 'deep'))
    expect(paths).not.toContain(
      path.join('proj', 'docs', 'deep', 'too-deep.md'),
    )
    // Dotfiles are still excluded
    expect(paths.some((p) => p.includes('.hidden'))).toBe(false)
  })

  it('scans regular project roots without a depth limit', async () => {
    const root = '/repo'
    const fs = createFsWithFiles(root, ['a/b/c/d/e.txt'])

    const tree = await getProjectFileTree({ projectRoot: root, fs })
    const paths = getAllPathsWithDirectories(tree).map((p) => p.path)

    expect(paths).toContain(path.join('a', 'b', 'c', 'd', 'e.txt'))
  })

  it('records file paths with forward slashes', async () => {
    // `ignore` and the glob patterns the model writes are both POSIX-only, and
    // `ignore` answers false for a backslash path rather than throwing. Storing
    // anything but forward slashes here makes nested rules stop pruning on
    // Windows, which is how build output ends up eating the maxFiles budget.
    const root = '/repo'
    const fs = createFsWithFiles(root, ['app/src/main/Inventory.kt'])

    const tree = await getProjectFileTree({ projectRoot: root, fs })

    const filePaths = flattenTree(tree).map((node) => node.filePath)
    expect(filePaths).toEqual(['app/src/main/Inventory.kt'])
  })

  it('does not stat ignore files when none exist in directory entries', async () => {
    const root = '/repo'
    const fs = createFsWithFiles(root, ['src/index.ts', 'src/util.ts'])
    const statCalls: string[] = []
    const originalStat = fs.stat
    ;(fs as any).stat = async (p: any, ...args: any[]) => {
      statCalls.push(String(p))
      return (originalStat as any)(p, ...args)
    }

    await getProjectFileTree({ projectRoot: root, fs })

    // None of the stat calls should be for ignore files
    const ignoreStatCalls = statCalls.filter(
      (p) =>
        p.endsWith('.gitignore') ||
        p.endsWith('.codebuffignore') ||
        p.endsWith('.manicodeignore'),
    )
    expect(ignoreStatCalls).toHaveLength(0)
  })

  it('prunes directories ignored by a rule in a nested .gitignore', async () => {
    const root = '/repo'
    const fs = createFsWithFiles(root, [
      'app/.gitignore',
      'app/build/output.class',
      'app/src/Inventory.kt',
    ])
    ;(fs.readFile as any).mockImplementation(async (filePath: string) =>
      String(filePath).endsWith('.gitignore') ? 'build/\n' : '',
    )

    const tree = await getProjectFileTree({ projectRoot: root, fs })

    const filePaths = flattenTree(tree).map((node) => node.filePath)
    expect(filePaths).toContain('app/src/Inventory.kt')
    expect(filePaths).not.toContain('app/build/output.class')
  })

  it('keeps nested rules scoped to their own directory even when its name contains glob syntax', async () => {
    const root = '/repo'
    const fs = createFsWithFiles(root, [
      '[4K- HDR]/.gitignore',
      '[4K- HDR]/x/logs',
      '[4K- HDR]/keep.ts',
      'a/x/logs',
    ])
    ;(fs.readFile as any).mockImplementation(async (filePath: string) =>
      String(filePath).endsWith('.gitignore') ? 'logs\n' : '',
    )

    const filePaths = flattenTree(
      await getProjectFileTree({ projectRoot: root, fs }),
    ).map((node) => node.filePath)

    expect(filePaths).toContain('[4K- HDR]/keep.ts')
    expect(filePaths).not.toContain('[4K- HDR]/x/logs')
    expect(filePaths).toContain('a/x/logs')
  })

  it('keeps anchored rules in a nested .gitignore anchored to that directory', async () => {
    const root = '/repo'
    const fs = createFsWithFiles(root, [
      'pkg/.gitignore',
      'pkg/dist/a.js',
      'pkg/sub/dist/b.js',
    ])
    ;(fs.readFile as any).mockImplementation(async (filePath: string) =>
      String(filePath) === path.join(root, 'pkg', '.gitignore')
        ? '/dist\n'
        : '',
    )

    const filePaths = flattenTree(
      await getProjectFileTree({ projectRoot: root, fs }),
    ).map((node) => node.filePath)

    expect(filePaths).not.toContain('pkg/dist/a.js')
    expect(filePaths).toContain('pkg/sub/dist/b.js')
  })

  it('does not let a nested negation re-include a file under a directory excluded by an ancestor', async () => {
    const root = '/repo'
    const fs = createFsWithFiles(root, [
      '.gitignore',
      'pkg/.gitignore',
      'pkg/dist/index.css',
      'pkg/src/a.ts',
    ])
    ;(fs.readFile as any).mockImplementation(async (filePath: string) => {
      const p = String(filePath)
      if (p === path.join(root, '.gitignore')) return 'dist/\n'
      if (p === path.join(root, 'pkg', '.gitignore'))
        return '!dist/index.css\n'
      return ''
    })

    const filePaths = flattenTree(
      await getProjectFileTree({ projectRoot: root, fs }),
    ).map((node) => node.filePath)

    expect(filePaths).toContain('pkg/src/a.ts')
    expect(filePaths).not.toContain('pkg/dist/index.css')
  })

  it('skips ignore rules that cannot be compiled without dropping the rest of the file', async () => {
    const root = '/repo'
    const fs = createFsWithFiles(root, [
      '.gitignore',
      'build/out.js',
      'src/main.ts',
    ])
    ;(fs.readFile as any).mockImplementation(async (filePath: string) =>
      String(filePath).endsWith('.gitignore') ? '[~-a]\nbuild/\n' : '',
    )

    const filePaths = flattenTree(
      await getProjectFileTree({ projectRoot: root, fs }),
    ).map((node) => node.filePath)

    expect(filePaths).toContain('src/main.ts')
    expect(filePaths).not.toContain('build/out.js')
  })
})

describe('isFileIgnored', () => {
  it('can exempt env templates from defaults while preserving project rules', async () => {
    const root = '/repo'
    const withoutProjectRule = createFsWithFiles(root, ['.env.example'])

    expect(
      await isFileIgnored({
        filePath: '.env.example',
        projectRoot: root,
        fs: withoutProjectRule,
      }),
    ).toBe(true)
    expect(
      await isFileIgnored({
        filePath: '.env.example',
        projectRoot: root,
        fs: withoutProjectRule,
        allowEnvTemplate: true,
      }),
    ).toBe(false)
    expect(
      await isFileIgnored({
        filePath: '.env.local',
        projectRoot: root,
        fs: withoutProjectRule,
        allowEnvTemplate: true,
      }),
    ).toBe(true)

    const withProjectRule = createFsWithFiles(root, [
      '.gitignore',
      '.env.example',
    ])
    ;(withProjectRule.readFile as any).mockImplementation(
      async (filePath: string) =>
        String(filePath) === path.join(root, '.gitignore')
          ? '.env.example\n'
          : '',
    )

    expect(
      await isFileIgnored({
        filePath: '.env.example',
        projectRoot: root,
        fs: withProjectRule,
        allowEnvTemplate: true,
      }),
    ).toBe(true)
  })

  it('fails closed when an env template project rule is unreadable', async () => {
    const root = '/repo'
    const fs = createFsWithFiles(root, ['.gitignore', '.env.example'])
    ;(fs.readFile as any).mockImplementation(async (filePath: string) => {
      if (String(filePath) === path.join(root, '.gitignore')) {
        const error = new Error('permission denied') as Error & {
          code: string
        }
        error.code = 'EACCES'
        throw error
      }
      return 'API_KEY=example'
    })

    expect(
      await isFileIgnored({
        filePath: '.env.example',
        projectRoot: root,
        fs,
        allowEnvTemplate: true,
      }),
    ).toBe(true)
  })

  it('reads ignore rules at the filesystem root without looping', async () => {
    const root = path.parse(process.cwd()).root
    const fs = createMockFs({
      files: { [path.join(root, '.gitignore')]: 'readme.txt\n' },
    })

    expect(
      await isFileIgnored({ filePath: 'readme.txt', projectRoot: root, fs }),
    ).toBe(true)
  })

  it('keeps default-ignored directories excluded despite a root negation', async () => {
    const root = '/repo'
    const fs = createFsWithFiles(root, [
      '.gitignore',
      'node_modules/pkg/README.md',
    ])
    ;(fs.readFile as any).mockImplementation(async (filePath: string) =>
      String(filePath) === path.join(root, '.gitignore') ? '!*.md\n' : '',
    )

    expect(
      await isFileIgnored({
        filePath: 'node_modules/pkg/README.md',
        projectRoot: root,
        fs,
      }),
    ).toBe(true)
  })
})
