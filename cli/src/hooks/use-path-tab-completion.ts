import { existsSync, statSync } from 'fs'
import path from 'path'

import { useCallback } from 'react'

import { getPathCompletion } from '../utils/path-completion'

export interface UsePathTabCompletionOptions {
  /** Current search query */
  searchQuery: string
  /** Set the search query */
  setSearchQuery: (query: string) => void
  /** Current directory path */
  currentPath: string
  /** Set the current directory path */
  setCurrentPath: (path: string) => void
  /** Function to expand ~ to home directory */
  expandPath: (inputPath: string) => string
}

export interface UsePathTabCompletionReturn {
  /** Handle tab completion, returns true to indicate key was handled */
  handleTabCompletion: () => boolean
}

/**
 * Check if a path query represents an absolute path.
 * Supports POSIX paths (/...), tilde paths (~...), and Windows drive/UNC paths.
 */
export function isAbsolutePath(searchQuery: string): boolean {
  return (
    searchQuery.startsWith('/') ||
    searchQuery.startsWith('~') ||
    path.isAbsolute(searchQuery) ||
    path.win32.isAbsolute(searchQuery)
  )
}

/**
 * Check if a completed path represents a full directory.
 * Matches trailing slash (/) or Windows backslash (\).
 */
export function isCompleteDirectory(completed: string): boolean {
  return completed.endsWith('/') || completed.endsWith('\\')
}

/**
 * Convert absolute completion back to relative path for display under current directory.
 */
export function toRelativePath(
  completed: string,
  currentPath: string,
): string | null {
  if (completed.startsWith(currentPath + path.sep)) {
    return completed.slice(currentPath.length + 1)
  }
  return null
}

/**
 * Hook for path tab completion.
 * Handles both absolute (/, ~, drive letters) and relative path completion.
 * Always navigates to completed directories when completion ends with a directory separator.
 */
export function usePathTabCompletion({
  searchQuery,
  setSearchQuery,
  currentPath,
  setCurrentPath,
  expandPath,
}: UsePathTabCompletionOptions): UsePathTabCompletionReturn {
  const handleTabCompletion = useCallback((): boolean => {
    if (isAbsolutePath(searchQuery)) {
      // Absolute path completion
      const completed = getPathCompletion(searchQuery)
      if (completed) {
        // If completion is a full directory (ends with / or \), navigate there and keep the path in input
        if (isCompleteDirectory(completed)) {
          const dirPath = expandPath(completed.slice(0, -1))
          try {
            if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
              setCurrentPath(dirPath)
              setSearchQuery(completed)
              return true
            }
          } catch {
            // Fall through to just set the query
          }
        }
        setSearchQuery(completed)
      }
    } else if (searchQuery.length > 0) {
      // Relative path completion - try from current directory
      const relativePath = path.join(currentPath, searchQuery)
      const completed = getPathCompletion(relativePath)
      if (completed) {
        // If completion is a full directory (ends with / or \), navigate there and keep the path in input
        if (isCompleteDirectory(completed)) {
          try {
            const dirPath = completed.slice(0, -1)
            if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
              setCurrentPath(dirPath)
              setSearchQuery(completed)
              return true
            }
          } catch {
            // Fall through to just set the query
          }
        }
        // Convert back to relative path for display
        const rel = toRelativePath(completed, currentPath)
        if (rel !== null) {
          setSearchQuery(rel)
        } else {
          setSearchQuery(completed)
        }
      }
    }
    return true
  }, [searchQuery, setSearchQuery, currentPath, setCurrentPath, expandPath])

  return { handleTabCompletion }
}
