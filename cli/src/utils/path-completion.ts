import { existsSync, readdirSync, statSync } from 'fs'
import os from 'os'
import path from 'path'

/**
 * Get path completions for tab completion.
 * Returns the completed path or null if no completion available.
 *
 * Behavior:
 * - Empty input returns null
 * - Expands ~ to home directory
 * - Single match: returns completed path with trailing slash
 * - Multiple matches: returns common prefix (no trailing slash)
 * - No matches: returns null
 * - Hidden directories are skipped unless user typed a dot
 */
export function getPathCompletion(inputPath: string): string | null {
  if (!inputPath) return null

  // Expand ~ to home directory
  let expandedPath = inputPath
  const homeDir = os.homedir()
  if (expandedPath.startsWith('~')) {
    expandedPath = path.join(homeDir, expandedPath.slice(1))
  }

  // If the path ends with /, we're completing inside that directory
  // Otherwise, we're completing the last component
  let parentDir: string
  let partial: string

  if (expandedPath.endsWith(path.sep)) {
    parentDir = expandedPath
    partial = ''
  } else {
    parentDir = path.dirname(expandedPath)
    partial = path.basename(expandedPath).toLowerCase()
  }

  // Check if parent directory exists
  try {
    if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) {
      return null
    }
  } catch {
    return null
  }

  // List directories in parent that match the partial
  try {
    const items = readdirSync(parentDir)
    const matches: string[] = []

    for (const item of items) {
      // Skip hidden files unless user typed a dot
      if (item.startsWith('.') && !partial.startsWith('.')) continue

      const fullPath = path.join(parentDir, item)
      try {
        if (!statSync(fullPath).isDirectory()) continue
      } catch {
        continue
      }

      if (item.toLowerCase().startsWith(partial)) {
        matches.push(item)
      }
    }

    if (matches.length === 0) return null

    // If exactly one match, complete to it with trailing slash
    if (matches.length === 1) {
      let completed = path.join(parentDir, matches[0]) + path.sep
      // Convert back to ~ format if it was originally using ~
      if (inputPath.startsWith('~') && completed.startsWith(homeDir)) {
        completed = '~' + completed.slice(homeDir.length)
      }
      return completed
    }

    // Multiple matches - find common prefix
    const sortedMatches = matches.sort((a, b) => {
      const lowerA = a.toLowerCase()
      const lowerB = b.toLowerCase()
      return lowerA < lowerB ? -1 : lowerA > lowerB ? 1 : 0
    })
    const first = sortedMatches[0].toLowerCase()
    const last = sortedMatches[sortedMatches.length - 1].toLowerCase()
    let commonLength = partial.length

    while (
      commonLength < first.length &&
      first[commonLength] === last[commonLength]
    ) {
      commonLength++
    }

    // If we can extend beyond what's already typed
    if (commonLength > partial.length) {
      // Use the case from the first match
      const commonPrefix = sortedMatches[0].slice(0, commonLength)
      let completed = path.join(parentDir, commonPrefix)
      // Convert back to ~ format if it was originally using ~
      if (inputPath.startsWith('~') && completed.startsWith(homeDir)) {
        completed = '~' + completed.slice(homeDir.length)
      }
      return completed
    }

    return null
  } catch {
    return null
  }
}
