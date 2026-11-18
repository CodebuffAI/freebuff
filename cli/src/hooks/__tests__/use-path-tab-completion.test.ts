import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

/**
 * Tests for usePathTabCompletion hook logic.
 *
 * These tests focus on the pure logic aspects of the hook:
 * - Path type detection (absolute vs relative)
 * - Completion behavior with navigation enabled/disabled
 * - Path transformation for display
 */

import {
  isAbsolutePath,
  isCompleteDirectory,
  toRelativePath,
} from '../use-path-tab-completion'

// Helper to expand ~ to home directory (same as in the hook)
const expandPath = (inputPath: string): string => {
  if (inputPath.startsWith('~')) {
    return path.join(os.homedir(), inputPath.slice(1))
  }
  return inputPath
}

describe('usePathTabCompletion - path type detection', () => {
  describe('isAbsolutePath', () => {
    test('returns true for paths starting with /', () => {
      expect(isAbsolutePath('/usr/local')).toBe(true)
      expect(isAbsolutePath('/home')).toBe(true)
      expect(isAbsolutePath('/')).toBe(true)
    })

    test('returns true for paths starting with ~', () => {
      expect(isAbsolutePath('~')).toBe(true)
      expect(isAbsolutePath('~/Documents')).toBe(true)
      expect(isAbsolutePath('~/')).toBe(true)
    })

    test('returns true for Windows drive paths', () => {
      expect(isAbsolutePath('C:\\Users')).toBe(true)
      expect(isAbsolutePath('D:\\projects')).toBe(true)
      expect(isAbsolutePath('C:/Users/Documents')).toBe(true)
      expect(isAbsolutePath('C:\\')).toBe(true)
    })

    test('returns false for relative paths', () => {
      expect(isAbsolutePath('Documents')).toBe(false)
      expect(isAbsolutePath('src/components')).toBe(false)
      expect(isAbsolutePath('./relative')).toBe(false)
      expect(isAbsolutePath('../parent')).toBe(false)
    })

    test('returns false for empty string', () => {
      expect(isAbsolutePath('')).toBe(false)
    })

    test('returns false for paths with ~ in middle', () => {
      expect(isAbsolutePath('some/~/path')).toBe(false)
      expect(isAbsolutePath('path~')).toBe(false)
    })
  })
})

describe('usePathTabCompletion - completion result detection', () => {
  describe('isCompleteDirectory', () => {
    test('returns true for paths ending with /', () => {
      expect(isCompleteDirectory('/usr/local/')).toBe(true)
      expect(isCompleteDirectory('~/Documents/')).toBe(true)
      expect(isCompleteDirectory('relative/path/')).toBe(true)
    })

    test('returns true for Windows paths ending with backslash', () => {
      expect(isCompleteDirectory('C:\\Users\\')).toBe(true)
      expect(isCompleteDirectory('relative\\path\\')).toBe(true)
      expect(isCompleteDirectory('\\')).toBe(true)
    })

    test('returns false for paths not ending with / or \\', () => {
      expect(isCompleteDirectory('/usr/local')).toBe(false)
      expect(isCompleteDirectory('~/Documents')).toBe(false)
      expect(isCompleteDirectory('C:\\Users')).toBe(false)
      expect(isCompleteDirectory('partial')).toBe(false)
    })

    test('returns false for empty string', () => {
      expect(isCompleteDirectory('')).toBe(false)
    })

    test('handles path with only /', () => {
      expect(isCompleteDirectory('/')).toBe(true)
    })
  })
})

describe('usePathTabCompletion - relative path conversion', () => {
  describe('toRelativePath', () => {
    test('converts absolute completion to relative when within currentPath', () => {
      const currentPath = '/home/user/projects'
      const completed = '/home/user/projects/myproject'
      
      const result = toRelativePath(completed, currentPath)
      expect(result).toBe('myproject')
    })

    test('converts nested path correctly', () => {
      const currentPath = '/home/user'
      const completed = '/home/user/Documents/work'
      
      const result = toRelativePath(completed, currentPath)
      expect(result).toBe('Documents/work')
    })

    test('returns null when completion is not under currentPath', () => {
      const currentPath = '/home/user/projects'
      const completed = '/usr/local/bin'
      
      const result = toRelativePath(completed, currentPath)
      expect(result).toBeNull()
    })

    test('returns null when completion exactly equals currentPath', () => {
      const currentPath = '/home/user/projects'
      const completed = '/home/user/projects'
      
      // Note: This would need to be `/home/user/projects/` + something to match
      const result = toRelativePath(completed, currentPath)
      expect(result).toBeNull()
    })

    test('handles paths with trailing separators correctly', () => {
      const currentPath = '/home/user'
      const completed = '/home/user/test'
      
      const result = toRelativePath(completed, currentPath)
      expect(result).toBe('test')
    })
  })
})

describe('usePathTabCompletion - expandPath behavior', () => {
  const homeDir = os.homedir()

  test('expands tilde in completion paths', () => {
    const result = expandPath('~/Documents')
    expect(result).toBe(path.join(homeDir, 'Documents'))
  })

  test('leaves absolute paths unchanged', () => {
    const result = expandPath('/usr/local/bin')
    expect(result).toBe('/usr/local/bin')
  })

  test('leaves relative paths unchanged', () => {
    const result = expandPath('relative/path')
    expect(result).toBe('relative/path')
  })
})

describe('usePathTabCompletion - completion decision logic', () => {
  /**
   * Test the decision logic that determines:
   * 1. Whether to complete at all
   * 2. Whether to navigate (change currentPath) or just update searchQuery
   */

  describe('when query is empty', () => {
    test('should not attempt completion for empty query', () => {
      const searchQuery = ''
      const shouldComplete = searchQuery.length > 0 || isAbsolutePath(searchQuery)
      expect(shouldComplete).toBe(false)
    })
  })

  describe('when query is absolute path', () => {
    test('should attempt completion for / prefix', () => {
      const searchQuery = '/usr'
      expect(isAbsolutePath(searchQuery)).toBe(true)
    })

    test('should attempt completion for ~ prefix', () => {
      const searchQuery = '~/Doc'
      expect(isAbsolutePath(searchQuery)).toBe(true)
    })
  })

  describe('when query is relative path', () => {
    test('should attempt completion when query has content', () => {
      const searchQuery = 'src'
      const shouldComplete = searchQuery.length > 0
      expect(shouldComplete).toBe(true)
    })

    test('should not attempt completion for whitespace-only query', () => {
      const searchQuery = '   '
      const shouldComplete = searchQuery.trim().length > 0
      expect(shouldComplete).toBe(false)
    })
  })

  describe('navigation decision', () => {
    test('should navigate when canNavigate is true and completion is full directory', () => {
      const canNavigate = true
      const completed = '/home/user/Documents/'
      
      const shouldNavigate = canNavigate && isCompleteDirectory(completed)
      expect(shouldNavigate).toBe(true)
    })

    test('should not navigate when canNavigate is false', () => {
      const canNavigate = false
      const completed = '/home/user/Documents/'
      
      const shouldNavigate = canNavigate && isCompleteDirectory(completed)
      expect(shouldNavigate).toBe(false)
    })

    test('should not navigate when completion is partial (no trailing /)', () => {
      const canNavigate = true
      const completed = '/home/user/Doc'
      
      const shouldNavigate = canNavigate && isCompleteDirectory(completed)
      expect(shouldNavigate).toBe(false)
    })
  })
})

describe('usePathTabCompletion - integration with filesystem', () => {
  let tempDir: string
  let nestedDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'tab-completion-test-'))
    nestedDir = path.join(tempDir, 'nested')
    mkdirSync(nestedDir)
    mkdirSync(path.join(nestedDir, 'subdir'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('builds relative path correctly for completion', () => {
    const currentPath = tempDir
    const searchQuery = 'nest'
    
    // This simulates what the hook does: join currentPath with searchQuery
    const relativePath = path.join(currentPath, searchQuery)
    expect(relativePath).toBe(path.join(tempDir, 'nest'))
  })

  test('extracts directory path from completion result', () => {
    const completed = '/some/path/to/directory/'
    
    // Remove trailing / to get directory path for navigation
    const dirPath = completed.slice(0, -1)
    expect(dirPath).toBe('/some/path/to/directory')
  })

  test('converts completion result back to relative display', () => {
    const currentPath = tempDir
    const completed = path.join(tempDir, 'nested') + path.sep
    
    // Simulate the conversion logic
    let displayPath: string
    if (completed.startsWith(currentPath + path.sep)) {
      displayPath = completed.slice(currentPath.length + 1)
    } else {
      displayPath = completed
    }
    
    // Should show 'nested/' as the relative path
    expect(displayPath).toBe('nested' + path.sep)
  })
})

describe('usePathTabCompletion - edge cases', () => {
  test('handles path with spaces', () => {
    const searchQuery = '~/My Documents'
    expect(isAbsolutePath(searchQuery)).toBe(true)
    
    const expanded = expandPath(searchQuery)
    expect(expanded).toBe(path.join(os.homedir(), 'My Documents'))
  })

  test('handles path with special characters', () => {
    const searchQuery = '~/project-v2.0'
    const expanded = expandPath(searchQuery)
    expect(expanded).toBe(path.join(os.homedir(), 'project-v2.0'))
  })

  test('handles double slashes in path', () => {
    const searchQuery = '/usr//local'
    expect(isAbsolutePath(searchQuery)).toBe(true)
    // Note: path.join would normalize this, but the raw check doesn't
  })

  test('handles very long paths', () => {
    const longPath = '/' + 'a'.repeat(100) + '/' + 'b'.repeat(100)
    expect(isAbsolutePath(longPath)).toBe(true)
  })

  test('handles unicode characters in path', () => {
    const searchQuery = '~/文档'
    expect(isAbsolutePath(searchQuery)).toBe(true)
    
    const expanded = expandPath(searchQuery)
    expect(expanded).toBe(path.join(os.homedir(), '文档'))
  })
})
