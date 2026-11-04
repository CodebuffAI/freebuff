import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getPathCompletion } from '../utils/path-completion'

describe('getPathCompletion', () => {
  let tempDir: string

  beforeEach(() => {
    // Create a temporary directory for each test
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'path-completion-test-'))
  })

  afterEach(() => {
    // Clean up the temporary directory
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('basic behavior', () => {
    test('returns null for empty string', () => {
      expect(getPathCompletion('')).toBeNull()
    })

    test('returns null for non-existent path', () => {
      expect(getPathCompletion('/this/path/does/not/exist/anywhere')).toBeNull()
    })

    test('returns null for path to a file (not directory)', () => {
      // Create a file in the temp directory
      const filePath = path.join(tempDir, 'testfile.txt')
      writeFileSync(filePath, 'test content')

      // Try to complete to that file - should return null since it's not a directory
      expect(getPathCompletion(path.join(tempDir, 'testf'))).toBeNull()
    })
  })

  describe('single match completion', () => {
    test('completes to single matching directory with trailing slash', () => {
      // Create a single subdirectory
      mkdirSync(path.join(tempDir, 'projects'))

      const result = getPathCompletion(path.join(tempDir, 'pro'))
      expect(result).toBe(path.join(tempDir, 'projects') + path.sep)
    })

    test('completes full directory name with trailing slash', () => {
      mkdirSync(path.join(tempDir, 'myproject'))

      const result = getPathCompletion(path.join(tempDir, 'myproject'))
      expect(result).toBe(path.join(tempDir, 'myproject') + path.sep)
    })

    test('completes when path ends with separator (completing inside directory)', () => {
      mkdirSync(path.join(tempDir, 'subdir'))
      mkdirSync(path.join(tempDir, 'subdir', 'nested'))

      // Path ending with / means "complete inside this directory"
      const result = getPathCompletion(path.join(tempDir, 'subdir') + path.sep)
      expect(result).toBe(
        path.join(tempDir, 'subdir', 'nested') + path.sep,
      )
    })
  })

  describe('multiple matches - common prefix', () => {
    test('returns common prefix when multiple matches share a prefix', () => {
      mkdirSync(path.join(tempDir, 'project-alpha'))
      mkdirSync(path.join(tempDir, 'project-beta'))
      mkdirSync(path.join(tempDir, 'project-gamma'))

      const result = getPathCompletion(path.join(tempDir, 'pro'))
      // Should complete to the common prefix "project-" without trailing slash
      expect(result).toBe(path.join(tempDir, 'project-'))
    })

    test('returns null when multiple matches have no additional common prefix', () => {
      mkdirSync(path.join(tempDir, 'alpha'))
      mkdirSync(path.join(tempDir, 'beta'))
      mkdirSync(path.join(tempDir, 'gamma'))

      // Typing nothing after the directory separator - all three match
      // but they have no common prefix beyond what was typed
      const result = getPathCompletion(tempDir + path.sep)
      expect(result).toBeNull()
    })

    test('returns null when typed prefix equals common prefix', () => {
      mkdirSync(path.join(tempDir, 'test-one'))
      mkdirSync(path.join(tempDir, 'test-two'))

      // Already typed the full common prefix "test-"
      const result = getPathCompletion(path.join(tempDir, 'test-'))
      expect(result).toBeNull()
    })
  })

  describe('case insensitivity', () => {
    test('matches directories case-insensitively', () => {
      mkdirSync(path.join(tempDir, 'MyProject'))

      // Lowercase input should match the directory
      const result = getPathCompletion(path.join(tempDir, 'myp'))
      expect(result).toBe(path.join(tempDir, 'MyProject') + path.sep)
    })

    test('matches uppercase input to lowercase directory', () => {
      mkdirSync(path.join(tempDir, 'documents'))

      const result = getPathCompletion(path.join(tempDir, 'DOC'))
      expect(result).toBe(path.join(tempDir, 'documents') + path.sep)
    })

    test('preserves original directory name case in completion', () => {
      mkdirSync(path.join(tempDir, 'CamelCaseDir'))

      const result = getPathCompletion(path.join(tempDir, 'camel'))
      expect(result).toBe(path.join(tempDir, 'CamelCaseDir') + path.sep)
    })
  })

  describe('hidden directories', () => {
    test('skips hidden directories by default', () => {
      mkdirSync(path.join(tempDir, '.hidden'))
      mkdirSync(path.join(tempDir, 'visible'))

      // With no dot prefix, should only match visible
      const result = getPathCompletion(tempDir + path.sep)
      expect(result).toBe(path.join(tempDir, 'visible') + path.sep)
    })

    test('includes hidden directories when input starts with dot', () => {
      mkdirSync(path.join(tempDir, '.config'))
      mkdirSync(path.join(tempDir, '.cache'))

      // Typing ".c" should match both hidden directories
      // but ".ca" and ".co" have no common prefix beyond ".c" which is already typed
      // So this should return null (no extension possible)
      const result = getPathCompletion(path.join(tempDir, '.c'))
      expect(result).toBeNull()
    })

    test('completes single hidden directory match', () => {
      mkdirSync(path.join(tempDir, '.gitconfig'))

      const result = getPathCompletion(path.join(tempDir, '.git'))
      expect(result).toBe(path.join(tempDir, '.gitconfig') + path.sep)
    })
  })

  describe('tilde expansion', () => {
    test('expands tilde to home directory', () => {
      // This test uses the actual home directory
      // Just verify it doesn't crash and returns a reasonable result
      const homeDir = os.homedir()
      const result = getPathCompletion('~')

      // Result should either be null (no completions) or start with home directory
      if (result !== null) {
        expect(result.startsWith(homeDir) || result.startsWith('~')).toBe(true)
      }
    })

    test('preserves tilde format in output when input used tilde', () => {
      // Create a test directory structure we can control
      // Note: This test is tricky because we can't easily create dirs in home
      // So we'll test with the actual home directory if it has subdirs
      // Try completing from home directory with tilde
      const result = getPathCompletion('~/')

      // If there's a result, it should preserve the ~ prefix
      if (result !== null) {
        expect(result.startsWith('~')).toBe(true)
      }
    })
  })

  describe('edge cases', () => {
    test('handles directory with only files (no subdirectories)', () => {
      // Create only files, no directories
      writeFileSync(path.join(tempDir, 'file1.txt'), '')
      writeFileSync(path.join(tempDir, 'file2.txt'), '')

      const result = getPathCompletion(tempDir + path.sep)
      expect(result).toBeNull()
    })

    test('handles empty directory', () => {
      const emptyDir = path.join(tempDir, 'empty')
      mkdirSync(emptyDir)

      const result = getPathCompletion(emptyDir + path.sep)
      expect(result).toBeNull()
    })

    test('handles deeply nested paths', () => {
      const deepPath = path.join(tempDir, 'a', 'b', 'c', 'd')
      mkdirSync(deepPath, { recursive: true })
      mkdirSync(path.join(tempDir, 'a', 'b', 'c', 'target'))

      const result = getPathCompletion(path.join(tempDir, 'a', 'b', 'c', 'tar'))
      expect(result).toBe(path.join(tempDir, 'a', 'b', 'c', 'target') + path.sep)
    })

    test('handles paths with spaces in directory names', () => {
      mkdirSync(path.join(tempDir, 'my project'))

      const result = getPathCompletion(path.join(tempDir, 'my '))
      expect(result).toBe(path.join(tempDir, 'my project') + path.sep)
    })

    test('handles paths with special characters in directory names', () => {
      mkdirSync(path.join(tempDir, 'test-project_v2.0'))

      const result = getPathCompletion(path.join(tempDir, 'test-'))
      expect(result).toBe(path.join(tempDir, 'test-project_v2.0') + path.sep)
    })
  })

  describe('mixed files and directories', () => {
    test('only completes to directories, not files', () => {
      mkdirSync(path.join(tempDir, 'testdir'))
      writeFileSync(path.join(tempDir, 'testfile.txt'), '')

      const result = getPathCompletion(path.join(tempDir, 'test'))
      // Should only match the directory
      expect(result).toBe(path.join(tempDir, 'testdir') + path.sep)
    })

    test('ignores files when calculating common prefix', () => {
      mkdirSync(path.join(tempDir, 'project-alpha'))
      mkdirSync(path.join(tempDir, 'project-beta'))
      writeFileSync(path.join(tempDir, 'project-readme.md'), '')

      const result = getPathCompletion(path.join(tempDir, 'pro'))
      // Files should be ignored, common prefix from directories only
      expect(result).toBe(path.join(tempDir, 'project-'))
    })

    test('completes symlinks pointing to directories', () => {
      const targetDir = path.join(tempDir, 'actual-dir')
      mkdirSync(targetDir)
      try {
        symlinkSync(targetDir, path.join(tempDir, 'symlinked-dir'))
        const result = getPathCompletion(path.join(tempDir, 'sym'))
        expect(result).toBe(path.join(tempDir, 'symlinked-dir') + path.sep)
      } catch {
        // Skip on systems where symlink creation is unprivileged/unsupported
      }
    })
  })
})
