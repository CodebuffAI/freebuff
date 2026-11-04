import path from 'path'

import { translateGitBashPath } from './windows-bash'

import type { WindowsShellPathDependencies } from './windows-bash'

export type ResolvedProjectPath = {
  fullPath: string
  relativePath: string
}

export type ResolvedFilePath = ResolvedProjectPath & {
  /** Whether the resolved path lives inside `projectRoot`. */
  isWithinProject: boolean
}

function escapesProject(relativePath: string): boolean {
  return (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  )
}

export function resolveFilePathWithinProject(
  projectRoot: string,
  filePath: string,
  dependencies: WindowsShellPathDependencies = {},
): ResolvedProjectPath | null {
  const resolvedRoot = path.resolve(projectRoot)
  const nativeFilePath = translateGitBashPath(filePath, dependencies)
  const fullPath = path.isAbsolute(nativeFilePath)
    ? path.resolve(nativeFilePath)
    : path.resolve(resolvedRoot, nativeFilePath)
  const relativePath = path.relative(resolvedRoot, fullPath)

  if (relativePath === '' || escapesProject(relativePath)) {
    return null
  }

  return { fullPath, relativePath }
}

/**
 * Resolves a file path against the project root without restricting it to the
 * project directory. Absolute paths are honored as-is and relative paths are
 * resolved against the project root, so callers can operate on any file on the
 * system. `relativePath` is a friendly display value: the project-relative path
 * when the target is inside the project, otherwise the absolute path.
 * `isWithinProject` lets callers skip project-scoped logic (e.g. gitignore) for
 * files that live outside the project.
 * On Windows, a single-leading-slash path uses Git Bash semantics because that
 * is the shell exposed to agents; native absolute paths retain their drive or
 * UNC prefix.
 */
export function resolveFilePath(
  projectRoot: string,
  filePath: string,
  dependencies: WindowsShellPathDependencies = {},
): ResolvedFilePath {
  const resolvedRoot = path.resolve(projectRoot)
  const nativeFilePath = translateGitBashPath(filePath, dependencies)
  const fullPath = path.isAbsolute(nativeFilePath)
    ? path.resolve(nativeFilePath)
    : path.resolve(resolvedRoot, nativeFilePath)
  const relativePath = path.relative(resolvedRoot, fullPath)
  const isWithinProject = relativePath !== '' && !escapesProject(relativePath)
  const displayPath = isWithinProject ? relativePath : fullPath

  return { fullPath, relativePath: displayPath, isWithinProject }
}

export function getProjectPathLookupKeys(
  projectRoot: string,
  filePath: string,
  dependencies: WindowsShellPathDependencies = {},
): string[] {
  const resolvedPath = resolveFilePathWithinProject(
    projectRoot,
    filePath,
    dependencies,
  )
  const keys = resolvedPath
    ? [resolvedPath.relativePath, filePath]
    : [
        resolveFilePath(projectRoot, filePath, dependencies).relativePath,
        filePath,
      ]
  const windowsKey = windowsComputerRelativePath(projectRoot, filePath)
  if (windowsKey) keys.unshift(windowsKey)

  return [...new Set(keys)]
}

/**
 * The project-relative key a Windows computer gives an absolute path (`C:\proj\src\a.ts`, or
 * Git Bash's `/c/proj/src/a.ts`) when this SDK runs on POSIX: a Cloud worker whose reads Desktop
 * answers on the user's Windows computer. POSIX `path` cannot relate either to `C:\proj`.
 */
function windowsComputerRelativePath(
  projectRoot: string,
  filePath: string,
): string | undefined {
  if (path.sep !== '/' || !/^[A-Za-z]:[\\/]/.test(projectRoot)) return undefined
  const nativePath = filePath.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:')
  return path.win32.isAbsolute(nativePath)
    ? path.win32.relative(projectRoot, nativePath)
    : undefined
}

/**
 * The key `files` holds a read under: an exact lookup key, else one that differs only in slashes.
 * A read override can answer from another OS: Desktop's computer chats read on the user's Windows
 * computer (`src\a.ts`) while this SDK runs in Cloud (`src/a.ts`).
 */
export function findFileLookupKey(
  files: Readonly<Record<string, unknown>>,
  lookupKeys: readonly string[],
): string | undefined {
  const slashes = (key: string) => key.replaceAll('\\', '/')
  const wanted = lookupKeys.map(slashes)
  return (
    lookupKeys.find((key) => Object.hasOwn(files, key)) ??
    Object.keys(files).find((key) => wanted.includes(slashes(key)))
  )
}
