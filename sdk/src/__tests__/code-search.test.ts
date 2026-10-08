import {
  clearMockedModules,
  mockModule,
} from '@codebuff/common/testing/mock-modules'
import {
  createMockChildProcess,
  asCodeSearchResult,
  createRgJsonMatch,
  createRgJsonContext,
} from '@codebuff/common/testing/mocks'
import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test'
import { PassThrough } from 'node:stream'

import { codeSearch } from '../tools/code-search'

import type { MockChildProcess } from '@codebuff/common/testing/mocks'
import type { TerminalCommandBroker } from '../tools/run-terminal-command'

describe('codeSearch', () => {
  let mockSpawn: ReturnType<typeof mock>
  let mockProcess: MockChildProcess

  beforeEach(async () => {
    mockProcess = createMockChildProcess()
    mockSpawn = mock(() => mockProcess)
    await mockModule('child_process', () => ({
      spawn: mockSpawn,
    }))
  })

  afterEach(() => {
    mock.restore()
    clearMockedModules()
  })

  describe('basic search', () => {
    it('uses the supplied process broker instead of ambient spawn', async () => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let finish!: (code: number | null) => void
      const requests: Parameters<TerminalCommandBroker['start']>[0][] = []
      const broker: TerminalCommandBroker = {
        start: (request) => {
          requests.push(request)
          return {
            stdout,
            stderr,
            completion: new Promise((resolve) => {
              finish = resolve
            }),
            kill: () => {},
            isAlive: () => true,
          }
        },
      }
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'brokered',
        processBroker: broker,
      })
      stdout.write(createRgJsonMatch('file.ts', 1, 'brokered') + '\n')
      finish(0)

      const result = await searchPromise
      expect(mockSpawn).not.toHaveBeenCalled()
      expect(requests).toHaveLength(1)
      expect(requests[0]!.cwd).toBe('/test/project')
      expect(requests[0]!.args).toContain('--no-config')
      expect(asCodeSearchResult(result[0]).stdout).toContain('brokered')
    })

    it('should parse standard ripgrep output without context flags', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'import',
      })

      // Simulate ripgrep JSON output
      const output = [
        createRgJsonMatch('file1.ts', 1, 'import foo from "bar"'),
        createRgJsonMatch('file1.ts', 5, 'import { baz } from "qux"'),
        createRgJsonMatch('file2.ts', 10, 'import React from "react"'),
      ].join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      expect(result[0].type).toBe('json')
      const value = asCodeSearchResult(result[0])
      expect(value.stdout).toContain('Found 3 matches')
      expect(value.stdout).toContain('file1.ts:')
      expect(value.stdout).toContain('  Line 1: import foo from "bar"')
      expect(value.stdout).toContain('file2.ts:')
    })
  })

  describe('context flags handling', () => {
    it('should correctly parse output with -A flag (after context)', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'import.*env',
        flags: '-A 2',
      })

      // Ripgrep JSON output with -A 2 includes match + 2 context lines after
      const output = [
        createRgJsonMatch('test.ts', 1, 'import { env } from "./config"'),
        createRgJsonContext('test.ts', 2, 'const apiUrl = env.API_URL'),
        createRgJsonContext('test.ts', 3, 'const apiKey = env.API_KEY'),
        createRgJsonMatch('other.ts', 5, 'import env from "process"'),
        createRgJsonContext('other.ts', 6, 'const nodeEnv = env.NODE_ENV'),
        createRgJsonContext('other.ts', 7, 'const port = env.PORT'),
      ].join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      expect(result[0].type).toBe('json')
      const value = asCodeSearchResult(result[0])

      expect(value.stdout).toContain('Found 2 matches')

      // Should contain match lines
      expect(value.stdout).toContain('import { env } from "./config"')
      expect(value.stdout).toContain('import env from "process"')

      // Should contain context lines (this is the bug - they're currently missing)
      expect(value.stdout).toContain('const apiUrl = env.API_URL')
      expect(value.stdout).toContain('const apiKey = env.API_KEY')
      expect(value.stdout).toContain('const nodeEnv = env.NODE_ENV')
      expect(value.stdout).toContain('const port = env.PORT')
    })

    it('should correctly parse output with -B flag (before context)', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'export',
        flags: '-B 2',
      })

      // Ripgrep JSON output with -B 2 includes 2 context lines before + match
      const output = [
        createRgJsonContext('app.ts', 1, 'import React from "react"'),
        createRgJsonContext('app.ts', 2, ''),
        createRgJsonMatch('app.ts', 3, 'export const main = () => {}'),
        createRgJsonContext(
          'utils.ts',
          8,
          'function validateInput(x: string) {',
        ),
        createRgJsonContext('utils.ts', 9, '  return x.length > 0'),
        createRgJsonMatch('utils.ts', 10, 'export function helper() {}'),
      ].join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Should contain match lines
      expect(value.stdout).toContain('export const main = () => {}')
      expect(value.stdout).toContain('export function helper() {}')

      // Should contain before context lines
      expect(value.stdout).toContain('import React from "react"')
      expect(value.stdout).toContain('function validateInput(x: string) {')
      expect(value.stdout).toContain('return x.length > 0')
    })

    it('should correctly parse output with -C flag (context before and after)', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'TODO',
        flags: '-C 1',
      })

      // Ripgrep JSON output with -C 1 includes 1 line before + match + 1 line after
      const output = [
        createRgJsonContext('code.ts', 5, 'function processData() {'),
        createRgJsonMatch('code.ts', 6, '  // TODO: implement this'),
        createRgJsonContext('code.ts', 7, '  return null'),
      ].join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Should contain match line
      expect(value.stdout).toContain('TODO: implement this')

      // Should contain context lines before and after
      expect(value.stdout).toContain('function processData() {')
      expect(value.stdout).toContain('return null')
    })

    it('should handle -A flag with multiple matches in same file', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'import',
        flags: '-A 1',
      })

      const output = [
        createRgJsonMatch('file.ts', 1, 'import foo from "foo"'),
        createRgJsonContext('file.ts', 2, 'import bar from "bar"'),
        createRgJsonMatch('file.ts', 3, 'import baz from "baz"'),
        createRgJsonContext('file.ts', 4, ''),
      ].join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Should contain all matches
      expect(value.stdout).toContain('import foo from "foo"')
      expect(value.stdout).toContain('import baz from "baz"')

      // Context line appears as both context and match
      expect(value.stdout).toContain('import bar from "bar"')
    })

    it('should handle -B flag at start of file', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'import',
        flags: '-B 2',
      })

      // First line match has no before context
      const output = createRgJsonMatch('file.ts', 1, 'import foo from "foo"')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Should still work with match at file start
      expect(value.stdout).toContain('import foo from "foo"')
    })

    it('should skip separator lines between result groups', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'test',
        flags: '-A 1',
      })

      const output = [
        createRgJsonMatch('file1.ts', 1, 'test line'),
        createRgJsonMatch('file2.ts', 5, 'another test'),
      ].join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Should not contain '--' separator
      expect(value.stdout).not.toContain('--')
    })
  })

  describe('edge cases with context lines', () => {
    it('should handle filenames with hyphens correctly', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'import',
        flags: '-A 1',
      })

      const output = [
        createRgJsonMatch('my-file.ts', 1, 'import foo'),
        createRgJsonMatch('other-file.ts', 5, 'import bar'),
      ].join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Files are formatted with filename on its own line followed by content
      expect(value.stdout).toContain('my-file.ts:')
      expect(value.stdout).toContain('import foo')
      expect(value.stdout).toContain('other-file.ts:')
      expect(value.stdout).toContain('import bar')
    })

    it('should handle filenames with multiple hyphens and underscores', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'test',
        flags: '-A 1',
      })

      const output = createRgJsonMatch(
        'my-complex_file-name.ts',
        10,
        'test content',
      )

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Should parse correctly despite multiple hyphens in filename
      expect(value.stdout).toContain('my-complex_file-name.ts:')
      expect(value.stdout).toContain('test content')
    })

    it('should not accumulate entire file content (regression test)', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'import.*env',
        flags: '-A 2',
        maxOutputStringLength: 20000,
      })

      const output = [
        createRgJsonMatch('large-file.ts', 5, 'import { env } from "config"'),
        createRgJsonMatch('other.ts', 1, 'import env'),
      ].join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Output should be reasonably sized, not including entire file
      expect(value.stdout!.length).toBeLessThan(2000)

      // Should still contain the matches
      expect(value.stdout).toContain('large-file.ts:')
      expect(value.stdout).toContain('other.ts:')
    })
  })

  describe('result limiting with context lines', () => {
    it('should respect maxResults per file with context lines', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'test',
        flags: '-A 1',
        maxResults: 2,
      })

      const output = [
        createRgJsonMatch('file.ts', 1, 'test 1'),
        createRgJsonContext('file.ts', 2, 'context 1'),
        createRgJsonMatch('file.ts', 5, 'test 2'),
        createRgJsonContext('file.ts', 6, 'context 2'),
        createRgJsonMatch('file.ts', 10, 'test 3'),
        createRgJsonContext('file.ts', 11, 'context 3'),
        createRgJsonMatch('file.ts', 15, 'test 4'),
        createRgJsonContext('file.ts', 16, 'context 4'),
      ].join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Should be limited to 2 match results per file (context lines don't count toward limit)
      // Count how many 'test' matches are in the output
      const testMatches = (value.stdout!.match(/test \d/g) || []).length
      expect(testMatches).toBeLessThanOrEqual(2)
      expect(value.stdout).toContain('Results limited')

      // Should still include context lines for the matches that are shown
      if (value.stdout!.includes('test 1')) {
        expect(value.stdout).toContain('context 1')
      }
      if (value.stdout!.includes('test 2')) {
        expect(value.stdout).toContain('context 2')
      }
    })

    it('should not report truncation when matches exactly equal maxResults', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'test',
        maxResults: 2,
      })

      const output = [
        createRgJsonMatch('file.ts', 1, 'test 1'),
        createRgJsonMatch('file.ts', 2, 'test 2'),
      ].join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      expect(value.stdout).toContain('Found 2 matches')
      expect(value.stdout).not.toContain('Results limited')
    })

    it('should respect globalMaxResults with context lines', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'test',
        flags: '-A 1',
        globalMaxResults: 3,
      })

      const output = [
        createRgJsonMatch('file1.ts', 1, 'test 1'),
        createRgJsonContext('file1.ts', 2, 'context 1'),
        createRgJsonMatch('file1.ts', 5, 'test 2'),
        createRgJsonContext('file1.ts', 6, 'context 2'),
        createRgJsonMatch('file2.ts', 1, 'test 3'),
        createRgJsonContext('file2.ts', 2, 'context 3'),
        createRgJsonMatch('file2.ts', 5, 'test 4'),
        createRgJsonContext('file2.ts', 6, 'context 4'),
      ].join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Should be limited globally to 3 match results (context lines don't count)
      const matches = (value.stdout!.match(/test \d/g) || []).length
      expect(matches).toBeLessThanOrEqual(3)
      // Check for either 'Global limit' message or truncation indicator
      const hasLimitMessage =
        value.stdout!.includes('Global limit') ||
        value.stdout!.includes('Results limited')
      expect(hasLimitMessage).toBe(true)
    })

    it('should not count context lines toward maxResults limit', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'match',
        flags: '-A 2 -B 2',
        maxResults: 1,
      })

      const output = [
        createRgJsonContext('file.ts', 1, 'context before 1'),
        createRgJsonContext('file.ts', 2, 'context before 2'),
        createRgJsonMatch('file.ts', 3, 'match line'),
        createRgJsonContext('file.ts', 4, 'context after 1'),
        createRgJsonContext('file.ts', 5, 'context after 2'),
      ].join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Should include the match
      expect(value.stdout).toContain('match line')

      // Should include all context lines even though maxResults is 1
      expect(value.stdout).toContain('context before 1')
      expect(value.stdout).toContain('context before 2')
      expect(value.stdout).toContain('context after 1')
      expect(value.stdout).toContain('context after 2')
    })
  })

  describe('malformed output handling', () => {
    it('should skip lines without separator', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'test',
      })

      const output = [
        createRgJsonMatch('file.ts', 1, 'valid line'),
        'malformed line without proper JSON',
        createRgJsonMatch('file.ts', 2, 'another valid line'),
      ].join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Should still process valid lines
      expect(value.stdout).toContain('valid line')
      expect(value.stdout).toContain('another valid line')
    })

    it('should handle empty output', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'nonexistent',
      })

      mockProcess.stdout.emit('data', Buffer.from(''))
      mockProcess.emit('close', 1)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      expect(value.stdout).toBe('Found 0 matches')
    })
  })

  describe('bug fixes validation', () => {
    it('should handle patterns starting with hyphen (regression test)', async () => {
      // Bug: Patterns starting with '-' were misparsed as flags
      // Fix: Added '--' separator before pattern in args
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: '-foo',
      })

      const output = createRgJsonMatch('file.ts', 1, 'const x = -foo')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      expect(value.stdout).toContain('file.ts:')
      expect(value.stdout).toContain('-foo')
    })

    it('should strip trailing newlines from line text (regression test)', async () => {
      // Bug: JSON lineText includes trailing \n, causing blank lines
      // Fix: Strip \r?\n from lineText
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'import',
      })

      // Simulate ripgrep JSON with trailing newlines in lineText
      const output = JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'file.ts' },
          lines: { text: 'import foo from "bar"\n' }, // trailing newline
          line_number: 1,
        },
      })

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Should not have double newlines or blank lines
      expect(value.stdout).not.toContain('\n\n\n')
      expect(value.stdout).toContain('import foo')
    })

    it('should process multiple JSON objects in remainder at close (regression test)', async () => {
      // Bug: Only processed one JSON object in remainder
      // Fix: Loop through all complete lines in remainder
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'test',
      })

      // Send partial JSON chunks that will be completed in remainder
      const match1 = createRgJsonMatch('file1.ts', 1, 'test 1')
      const match2 = createRgJsonMatch('file2.ts', 2, 'test 2')
      const match3 = createRgJsonMatch('file3.ts', 3, 'test 3')

      // Send as one chunk without trailing newline to simulate remainder scenario
      const output = `${match1}\n${match2}\n${match3}`

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // All three matches should be processed
      expect(value.stdout).toContain('file1.ts:')
      expect(value.stdout).toContain('file2.ts:')
      expect(value.stdout).toContain('file3.ts:')
    })

    it('should enforce output size limit during streaming (regression test)', async () => {
      // Bug: Output size only checked at end, could exceed limit
      // Fix: Check estimatedOutputLen during streaming and stop early
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'test',
        maxOutputStringLength: 200, // Very small limit
        globalMaxResults: 1000, // Set high so output size limit is hit first
        maxResults: 1000, // Set high so per-file limit doesn't interfere
      })

      // Generate matches with long content to quickly exceed output size
      const matches: string[] = []
      for (let i = 0; i < 20; i++) {
        matches.push(
          createRgJsonMatch(
            'file.ts',
            i,
            `test line ${i} with some content that is quite long to fill up the buffer quickly`,
          ),
        )
      }
      const output = matches.join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Should have limited output - either by early stop or final truncation
      // The output should be truncated and not contain all 20 matches
      const matchCount = (value.stdout!.match(/test line \d+/g) || []).length
      expect(matchCount).toBeLessThan(20)
      // Should indicate truncation happened
      const hasTruncationMessage =
        value.stdout!.includes('truncated') ||
        value.stdout!.includes('limit reached') ||
        value.stdout!.includes('Output size limit')
      expect(hasTruncationMessage).toBe(true)
    })

    it('should handle non-UTF8 paths using path.bytes (regression test)', async () => {
      // Bug: Only handled path.text, not path.bytes for non-UTF8 paths
      // Fix: Check both path.text and path.bytes
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'test',
      })

      // Simulate ripgrep JSON with path.bytes instead of path.text
      const output = JSON.stringify({
        type: 'match',
        data: {
          path: { bytes: 'file-with-bytes.ts' }, // Using bytes field
          lines: { text: 'test content' },
          line_number: 1,
        },
      })

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Should handle path.bytes
      expect(value.stdout).toContain('file-with-bytes.ts:')
      expect(value.stdout).toContain('test content')
    })
  })

  describe('glob pattern handling', () => {
    it('should handle -g flag with glob patterns like *.ts', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'import',
        flags: '-g *.ts',
      })

      const output = [
        createRgJsonMatch('file.ts', 1, 'import foo from "bar"'),
        createRgJsonMatch('file.ts', 5, 'import { baz } from "qux"'),
      ].join('\n')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      expect(result[0].type).toBe('json')
      const value = asCodeSearchResult(result[0])
      expect(value.stdout).toContain('file.ts:')

      // Verify the args passed to spawn include the glob flag correctly
      expect(mockSpawn).toHaveBeenCalled()
      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[]
      expect(spawnArgs).toContain('-g')
      expect(spawnArgs).toContain('*.ts')
    })

    it('should handle -g flag with multiple glob patterns', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'import',
        flags: '-g *.ts -g *.tsx',
      })

      const output = createRgJsonMatch(
        'file.tsx',
        1,
        'import React from "react"',
      )

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      expect(result[0].type).toBe('json')
      const value = asCodeSearchResult(result[0])
      expect(value.stdout).toContain('file.tsx:')

      // Verify both glob patterns are passed correctly
      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[]
      // Should have two -g flags, each followed by its pattern
      const gFlagIndices = spawnArgs
        .map((arg, i) => (arg === '-g' ? i : -1))
        .filter((i) => i !== -1)
      expect(gFlagIndices.length).toBe(2)
      expect(spawnArgs[gFlagIndices[0]! + 1]).toBe('*.ts')
      expect(spawnArgs[gFlagIndices[1]! + 1]).toBe('*.tsx')
    })

    it('should strip single quotes from glob pattern arguments (regression: spawn has no shell)', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'auth',
        flags: "-g 'authentication.knowledge.md'",
      })

      const output = createRgJsonMatch(
        'authentication.knowledge.md',
        5,
        'auth content',
      )

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])
      expect(value.stdout).toContain('authentication.knowledge.md:')

      // Verify the quotes were stripped before passing to spawn
      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[]
      expect(spawnArgs).toContain('authentication.knowledge.md')
      expect(spawnArgs).not.toContain("'authentication.knowledge.md'")
    })

    it('should strip double quotes from glob pattern arguments', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'import',
        flags: '-g "*.ts"',
      })

      const output = createRgJsonMatch('file.ts', 1, 'import foo')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])
      expect(value.stdout).toContain('file.ts:')

      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[]
      expect(spawnArgs).toContain('*.ts')
      expect(spawnArgs).not.toContain('"*.ts"')
    })

    it('keeps a quoted glob containing spaces in one argv entry', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'import',
        flags: "-g 'folder with spaces/*.ts'",
      })

      mockProcess.stdout.emit(
        'data',
        Buffer.from(createRgJsonMatch('folder with spaces/file.ts', 1, 'import foo')),
      )
      mockProcess.emit('close', 0)

      await searchPromise

      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[]
      const globIndex = spawnArgs.indexOf('-g')
      expect(spawnArgs[globIndex + 1]).toBe('folder with spaces/*.ts')
      expect(spawnArgs).not.toContain('folder')
      expect(spawnArgs).not.toContain('with')
      expect(spawnArgs).not.toContain('spaces/*.ts')
    })

    it('should strip quotes from multiple glob patterns', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'import',
        flags: "-g '*.ts' -g '*.tsx'",
      })

      const output = createRgJsonMatch('file.tsx', 1, 'import React')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      await searchPromise

      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[]
      expect(spawnArgs).toContain('*.ts')
      expect(spawnArgs).toContain('*.tsx')
      expect(spawnArgs).not.toContain("'*.ts'")
      expect(spawnArgs).not.toContain("'*.tsx'")
    })

    it('should not deduplicate flag-argument pairs', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'import',
        flags: '-g *.ts -i -g *.tsx',
      })

      const output = createRgJsonMatch(
        'file.tsx',
        1,
        'import React from "react"',
      )

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise

      // Verify flags are preserved in order without deduplication
      const spawnArgs = mockSpawn.mock.calls[0]![1] as string[]
      const flagsSection = spawnArgs.slice(0, spawnArgs.indexOf('--'))
      expect(flagsSection).toContain('-g')
      expect(flagsSection).toContain('*.ts')
      expect(flagsSection).toContain('-i')
      expect(flagsSection).toContain('*.tsx')

      // Count -g flags - should be 2, not deduplicated to 1
      const gCount = flagsSection.filter((arg) => arg === '-g').length
      expect(gCount).toBe(2)
    })
  })

  describe('timeout handling', () => {
    it('should timeout after specified seconds', async () => {
      // Create a mock process that doesn't auto-emit close when killed
      // to properly test the timeout path
      const slowMockProcess = createMockChildProcess()
      // Override kill to not emit close (simulating a hung process)
      slowMockProcess.kill = mock(() => {
        slowMockProcess.killed = true
        return true
      })

      const slowMockSpawn = mock(() => slowMockProcess)
      await mockModule('child_process', () => ({
        spawn: slowMockSpawn,
      }))

      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'test',
        timeoutSeconds: 1,
      })

      // Don't emit any data - just wait for the timeout to trigger
      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      // Should have timed out with an error message
      expect(value.errorMessage).toBeDefined()
      expect(value.errorMessage).toContain('timed out')
    })
  })

  describe('cwd parameter handling', () => {
    it('should handle cwd: "." correctly', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'test',
        cwd: '.',
      })

      const output = createRgJsonMatch('file.ts', 1, 'test content')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const _result = await searchPromise
      const value = asCodeSearchResult(_result[0])

      // Should work correctly and not have an error
      expect(value.errorMessage).toBeUndefined()
      expect(value.stdout).toContain('file.ts:')
      expect(value.stdout).toContain('test content')

      // Verify spawn was called with correct cwd
      expect(mockSpawn).toHaveBeenCalled()
      const spawnOptions = mockSpawn.mock.calls[0]![2] as { cwd: string }
      // When cwd is '.', it should resolve to the project root
      expect(spawnOptions.cwd).toBe('/test/project')
    })

    it('should handle cwd: "subdir" correctly', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'test',
        cwd: 'subdir',
      })

      const output = createRgJsonMatch('file.ts', 1, 'test content')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      expect(value.errorMessage).toBeUndefined()
      expect(value.stdout).toContain('file.ts:')

      // Verify spawn was called with correct cwd
      expect(mockSpawn).toHaveBeenCalled()
      const spawnOptions = mockSpawn.mock.calls[0]![2] as { cwd: string }
      expect(spawnOptions.cwd).toBe('/test/project/subdir')
    })

    it('should search cwd outside the project directory', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'test',
        cwd: '../outside',
      })

      const output = createRgJsonMatch('file.ts', 1, 'test content')

      mockProcess.stdout.emit('data', Buffer.from(output))
      mockProcess.emit('close', 0)

      const result = await searchPromise
      const value = asCodeSearchResult(result[0])

      expect(value.errorMessage).toBeUndefined()
      expect(value.stdout).toContain('file.ts:')

      // Verify spawn was called with the resolved outside cwd
      expect(mockSpawn).toHaveBeenCalled()
      const spawnOptions = mockSpawn.mock.calls[0]![2] as { cwd: string }
      expect(spawnOptions.cwd).toBe('/test/outside')
    })
  })

  describe('exec-capable flags', () => {
    it.each([
      '--pre sh',
      '--pre=/bin/sh',
      '"--pre" sh',
      '--pre-glob *.ts --pre sh',
      '--hostname-bin=/tmp/x',
      '-z',
      '--search-zip',
      '-i -uz',
    ])('refuses %j before starting ripgrep', async (flags) => {
      const requests: unknown[] = []
      const broker: TerminalCommandBroker = {
        start: (request) => {
          requests.push(request)
          throw new Error('ripgrep must not start')
        },
      }

      const result = await codeSearch({
        projectPath: '/test/project',
        pattern: 'x',
        flags,
        processBroker: broker,
      })

      expect(requests).toHaveLength(0)
      expect(mockSpawn).not.toHaveBeenCalled()
      const value = result[0].value as { errorMessage?: string }
      expect(value.errorMessage).toContain('makes ripgrep run another program')
    })

    it('still passes ordinary flags through to ripgrep', async () => {
      const searchPromise = codeSearch({
        projectPath: '/test/project',
        pattern: 'x',
        flags: '-i -g *.zip -C 2',
      })
      mockProcess.emit('close', 1)
      await searchPromise

      expect(mockSpawn).toHaveBeenCalledTimes(1)
      const args = mockSpawn.mock.calls[0]![1] as string[]
      expect(args).toEqual(
        expect.arrayContaining(['-i', '-g', '*.zip', '-C', '2']),
      )
    })
  })
})
