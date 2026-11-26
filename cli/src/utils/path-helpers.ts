import os from 'os'
import path from 'path'

import { getCliEnv } from './env'
import { tryGetProjectRoot } from '../project-files'

import type { CliEnv } from '../types/env'

/**
 * Format a path for display, replacing home directory with ~
 * @param cwd - The path to format
 * @param env - Optional environment object (defaults to CLI env)
 */
export function formatCwd(cwd: string | undefined, env?: CliEnv): string {
  if (!cwd) return ''
  const resolvedEnv = env ?? getCliEnv()
  const homeDir = resolvedEnv.HOME || resolvedEnv.USERPROFILE || os.homedir()
  if (homeDir && cwd.startsWith(homeDir)) {
    return '~' + cwd.slice(homeDir.length)
  }
  return cwd
}

/**
 * Get relative path from the project root
 * e.g., "/Users/foo/project/src/utils/helper.ts" -> "src/utils/helper.ts"
 * If already relative or project root unavailable, returns the path as-is
 */
export function getRelativePath(filePath: string): string {
  // If it's already a relative path, return as-is
  // `path.isAbsolute` rather than a leading '/': a Windows path such as
  // `C:\\Users\\foo\\project\\src\\helper.ts` is absolute too, and testing for
  // '/' left it unshortened on every Windows machine.
  if (!path.isAbsolute(filePath)) return filePath

  // Use the non-throwing accessor: the project root may legitimately be
  // unset (e.g. during early startup or in tests), and the fallback below
  // must actually be reachable rather than an uncaught throw.
  const projectRoot = tryGetProjectRoot()
  if (!projectRoot) return filePath

  // Use Node's path.relative for proper relative path calculation
  return path.relative(projectRoot, filePath)
}
