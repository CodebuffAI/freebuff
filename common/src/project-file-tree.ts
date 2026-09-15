import path from 'path'

import * as ignore from 'ignore'
import { sortBy } from 'lodash'

import { DEFAULT_IGNORED_PATHS } from './constants/paths'
import { isEnvTemplateFilePath } from './util/env-file-path'
import { fileExists, isValidProjectRoot } from './util/file'
import { isPathInside } from './util/path'
import {
  addIgnoreFileContents,
  isIgnoredByIgnoreChain,
  PROJECT_IGNORE_FILES,
} from './util/project-ignore'

import type { CodebuffFileSystem } from './types/filesystem'
import type { DirectoryNode, FileTreeNode } from './util/file'
import type { DirIgnore } from './util/project-ignore'

/**
 * Logs file tree errors in debug mode only.
 * Errors are logged but not thrown to preserve tree-building behavior.
 *
 * File tree operations commonly encounter expected errors (permissions,
 * deleted files) that are not fatal. We only log in debug mode to avoid
 * noisy output during normal operation.
 */
function logFileTreeError(
  operation: string,
  filePath: string,
  error: unknown,
): void {
  // Only log in debug mode to avoid noisy output
  if (!process.env.DEBUG && !process.env.CODEBUFF_DEBUG) {
    return
  }

  const err = error as { code?: string } | undefined
  const code = err?.code
  const errorMessage = error instanceof Error ? error.message : String(error)

  console.debug(
    `[FileTree] ${operation} failed for "${filePath}"${
      code ? ` (${code})` : ''
    }: ${errorMessage}`,
  )
}

export const DEFAULT_MAX_FILES = 10_000

/**
 * Everything downstream of the file tree is POSIX-only: `ignore` matches
 * nothing but forward slashes, and glob patterns come from the model in that
 * form too. `path.relative` returns backslashes on Windows, and `ignore`
 * answers `false` for them instead of throwing — so nested rules like `build/`
 * or `node_modules` silently stop pruning and the crawl burns its file budget
 * on build output before it ever reaches the source tree.
 */
function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/')
}

function createDefaultIgnore(allowEnvTemplate = false): ignore.Ignore {
  const defaultIgnore = ignore.default()
  for (const pattern of DEFAULT_IGNORED_PATHS) {
    if (allowEnvTemplate && (pattern === '.env' || pattern === '.env.*')) {
      continue
    }
    defaultIgnore.add(pattern)
  }
  return defaultIgnore
}

// When the project root is the home directory (or an ancestor), a full scan
// could crawl the user's entire disk. Instead of disabling the file tree
// entirely, do a shallow capped scan so @ mentions still surface
// `project/docs/file.md`-style paths.
export const SHALLOW_SCAN_MAX_DEPTH = 3
const SHALLOW_SCAN_MAX_FILES = 2_000
const SHALLOW_SCAN_MAX_DIRS = 500

/** Whether `getProjectFileTree` will shallow-scan this root (see above). */
export function isShallowScanRoot(
  projectRoot: string | undefined,
): projectRoot is string {
  return !!projectRoot && !isValidProjectRoot(projectRoot)
}

export async function getProjectFileTree(params: {
  projectRoot: string
  maxFiles?: number
  fs: CodebuffFileSystem
}): Promise<FileTreeNode[]> {
  const withDefaults = { maxFiles: DEFAULT_MAX_FILES, ...params }
  const { projectRoot, fs } = withDefaults
  let { maxFiles } = withDefaults
  let maxDepth = Infinity
  let maxDirs = Infinity

  const _start = Date.now()
  const defaultIgnore = createDefaultIgnore()

  if (isShallowScanRoot(projectRoot)) {
    defaultIgnore.add('.*')
    maxDepth = SHALLOW_SCAN_MAX_DEPTH
    maxFiles = Math.min(maxFiles, SHALLOW_SCAN_MAX_FILES)
    maxDirs = SHALLOW_SCAN_MAX_DIRS
  }

  const root: DirectoryNode = {
    name: path.basename(projectRoot),
    type: 'directory',
    children: [],
    filePath: '',
  }
  const queue: {
    node: DirectoryNode
    fullPath: string
    ignores: DirIgnore[]
    depth: number
  }[] = [
    {
      node: root,
      fullPath: projectRoot,
      ignores: [{ base: '', ig: defaultIgnore }],
      depth: 0,
    },
  ]
  let totalFiles = 0
  let dirsScanned = 0
  let queueIndex = 0

  while (queueIndex < queue.length && totalFiles < maxFiles && dirsScanned < maxDirs) {
    const { node, fullPath, ignores, depth } = queue[queueIndex++]
    dirsScanned++

    try {
      const files = await fs.readdir(fullPath)
      const filesSet = new Set(files)

      let dirIgnores = ignores
      const hasIgnoreFile = PROJECT_IGNORE_FILES.some((fileName) =>
        filesSet.has(fileName),
      )
      if (hasIgnoreFile) {
        dirIgnores = [
          ...ignores,
          {
            base: toPosixPath(path.relative(projectRoot, fullPath)),
            ig: await parseGitignore({
              fullDirPath: fullPath,
              fs,
              directoryEntries: filesSet,
            }),
          },
        ]
      }

      for (const file of files) {
        if (totalFiles >= maxFiles) break

        const filePath = path.join(fullPath, file)
        const relativeFilePath = toPosixPath(path.relative(projectRoot, filePath))

        if (isIgnoredByIgnoreChain(dirIgnores, relativeFilePath)) continue

        try {
          const stats = await fs.stat(filePath)
          if (stats.isDirectory()) {
            const childNode: DirectoryNode = {
              name: file,
              type: 'directory',
              children: [],
              filePath: relativeFilePath,
            }
            node.children.push(childNode)
            // Past maxDepth the directory still shows up as a node above, but
            // its contents are not scanned.
            if (depth + 1 < maxDepth) {
              queue.push({
                node: childNode,
                fullPath: filePath,
                ignores: dirIgnores,
                depth: depth + 1,
              })
            }
          } else {
            const lastReadTime = stats.atimeMs
            node.children.push({
              name: file,
              type: 'file',
              lastReadTime,
              filePath: relativeFilePath,
            })
            totalFiles++
          }
        } catch (error: unknown) {
          // File may be inaccessible due to permissions or may have been deleted.
          // Log with context for debugging, but continue building the tree.
          logFileTreeError('fs.stat', filePath, error)
        }
      }
    } catch (error: unknown) {
      // Directory may be inaccessible due to permissions.
      // Log with context for debugging, but continue building the tree.
      logFileTreeError('fs.readdir', fullPath, error)
    }
  }
  return root.children
}

async function parseGitignoreWithMode(params: {
  fullDirPath: string
  fs: CodebuffFileSystem
  throwOnReadError: boolean
  directoryEntries?: Set<string>
}): Promise<ignore.Ignore> {
  const { fullDirPath, fs, throwOnReadError, directoryEntries: entriesParam } = params

  const ig = ignore.default()
  let directoryEntries = entriesParam
  if (!directoryEntries && throwOnReadError) {
    directoryEntries = new Set(await fs.readdir(fullDirPath))
  }

  for (const fileName of PROJECT_IGNORE_FILES) {
    const ignoreFilePath = path.join(fullDirPath, fileName)
    if (directoryEntries) {
      if (!directoryEntries.has(fileName)) continue
    } else {
      const ignoreFileExists = await fileExists({ filePath: ignoreFilePath, fs })
      if (!ignoreFileExists) continue
    }

    let ignoreContent: string
    try {
      ignoreContent = await fs.readFile(ignoreFilePath, 'utf8')
    } catch (error: unknown) {
      // Resilient file-tree callers continue without unreadable rules. Access
      // checks can opt into throwing so their caller can fail closed.
      logFileTreeError('fs.readFile (ignore file)', ignoreFilePath, error)
      if (throwOnReadError) throw error
      continue
    }
    addIgnoreFileContents(ig, ignoreContent, (pattern, error) =>
      logFileTreeError('ignore.add (pattern)', pattern, error),
    )
  }

  return ig
}

export async function parseGitignore(params: {
  fullDirPath: string
  fs: CodebuffFileSystem
  directoryEntries?: Set<string>
}): Promise<ignore.Ignore> {
  return parseGitignoreWithMode({ ...params, throwOnReadError: false })
}

export function getAllFilePaths(
  nodes: FileTreeNode[],
  basePath: string = '',
): string[] {
  return nodes.flatMap((node) => {
    if (node.type === 'file') {
      return [path.join(basePath, node.name)]
    }
    return getAllFilePaths(node.children || [], path.join(basePath, node.name))
  })
}

export interface PathInfo {
  path: string
  isDirectory: boolean
}

export function getAllPathsWithDirectories(
  nodes: FileTreeNode[],
  basePath: string = '',
): PathInfo[] {
  return nodes.flatMap((node) => {
    const nodePath = basePath ? path.join(basePath, node.name) : node.name
    if (node.type === 'file') {
      return [{ path: nodePath, isDirectory: false }]
    }
    // Include the directory itself, plus recurse into children
    const dirEntry: PathInfo = { path: nodePath, isDirectory: true }
    const children = getAllPathsWithDirectories(node.children || [], nodePath)
    return [dirEntry, ...children]
  })
}

export function flattenTree(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.flatMap((node) => {
    if (node.type === 'file') {
      return [node]
    }
    return flattenTree(node.children ?? [])
  })
}

export function getLastReadFilePaths(
  flattenedNodes: FileTreeNode[],
  count: number,
) {
  return sortBy(
    flattenedNodes.filter((node) => node.lastReadTime),
    'lastReadTime',
  )
    .reverse()
    .slice(0, count)
    .map((node) => node.filePath)
}

export async function isFileIgnored(params: {
  filePath: string
  projectRoot: string
  fs: CodebuffFileSystem
  /** Allow the env template past built-in rules while strictly applying project rules. */
  allowEnvTemplate?: boolean
}): Promise<boolean> {
  const {
    filePath,
    projectRoot,
    fs,
    allowEnvTemplate: allowEnvTemplateRequested = false,
  } = params
  const allowEnvTemplate =
    allowEnvTemplateRequested && isEnvTemplateFilePath(filePath)

  const resolvedProjectRoot = path.resolve(projectRoot)
  const fullFilePath = path.resolve(resolvedProjectRoot, filePath)
  if (!isPathInside(resolvedProjectRoot, fullFilePath)) return false

  const defaultIgnore = createDefaultIgnore(allowEnvTemplate)

  const relativeFilePath = toPosixPath(
    path.relative(resolvedProjectRoot, fullFilePath),
  )

  // Get ignore patterns from the directory containing the file and all parent directories
  const dirIgnores: DirIgnore[] = []
  let currentDir = path.dirname(fullFilePath)
  while (true) {
    let ig: ignore.Ignore
    try {
      ig = await parseGitignoreWithMode({
        fullDirPath: currentDir,
        fs,
        throwOnReadError: allowEnvTemplate,
      })
    } catch (error) {
      if (allowEnvTemplate) return true
      throw error
    }
    dirIgnores.push({
      base: toPosixPath(path.relative(resolvedProjectRoot, currentDir)),
      ig,
    })
    if (path.relative(resolvedProjectRoot, currentDir) === '') break

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) break
    currentDir = parentDir
  }

  return isIgnoredByIgnoreChain(
    [{ base: '', ig: defaultIgnore }, ...dirIgnores.reverse()],
    relativeFilePath,
  )
}
