import { getSystemProcessEnv } from '../env'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import { formatCodeSearchOutput } from '../../../common/src/util/format-code-search'
import { getBundledRgPath } from '../native/ripgrep'

import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  TerminalCommandBroker,
  TerminalCommandProcess,
} from './run-terminal-command'

// Hidden directories to include in code search by default.
// These are searched in addition to '.' to ensure important config/workflow files are discoverable.
// Exported so the sponsored broker can admit exactly these search paths and no others.
export const INCLUDED_HIDDEN_DIRS: readonly string[] = [
  '.agents', // Codebuff agent definitions
  '.claude', // Claude settings
  '.github', // GitHub Actions, workflows, issue templates
  '.gitlab', // GitLab CI configuration
  '.circleci', // CircleCI configuration
  '.husky', // Git hooks
]

/**
 * Parse the user-facing flag string once so validation and process spawning see
 * the same argv. Quotes group whitespace but are not passed to ripgrep because
 * spawn() does not invoke a shell.
 */
export function parseCodeSearchFlags(flags: string | undefined): string[] | null {
  if (!flags?.trim()) return []
  const tokens: string[] = []
  let token = ''
  let quote: "'" | '"' | null = null
  let tokenStarted = false
  for (const character of flags) {
    if (quote) {
      if (character === quote) quote = null
      else token += character
      tokenStarted = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      tokenStarted = true
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token)
        token = ''
        tokenStarted = false
      }
    } else {
      token += character
      tokenStarted = true
    }
  }
  if (quote) return null
  if (tokenStarted) tokens.push(token)
  return tokens
}

export function codeSearch({
  projectPath,
  pattern,
  flags,
  cwd,
  maxResults = 15,
  globalMaxResults = 250,
  maxOutputStringLength = 20_000,
  timeoutSeconds = 10,
  logger,
  signal,
  processBroker,
}: {
  projectPath: string
  pattern: string
  flags?: string
  cwd?: string
  maxResults?: number
  globalMaxResults?: number
  maxOutputStringLength?: number
  timeoutSeconds?: number
  logger?: Logger
  /** External abort (e.g. user interrupt); kills the ripgrep process. */
  signal?: AbortSignal
  /** Routes ripgrep through a host-provided process boundary. */
  processBroker?: TerminalCommandBroker
}): Promise<CodebuffToolOutput<'code_search'>> {
  return new Promise((resolve) => {
    let isResolved = false

    // Resolve the search directory: absolute `cwd` is honored as-is, relative
    // `cwd` is resolved against the project root. Searches may target any
    // directory on the system.
    const projectRoot = path.resolve(projectPath)
    const searchCwd = cwd ? path.resolve(projectRoot, cwd) : projectRoot

    // Do not deduplicate: repeated flag-argument pairs such as `-g *.ts` are
    // meaningful. The shared parser keeps quoted values as one argv entry.
    const flagsArray = parseCodeSearchFlags(flags)
    if (!flagsArray) {
      return resolve([
        {
          type: 'json',
          value: { errorMessage: 'Code search flags contain an unterminated quote.' },
        },
      ])
    }

    // Use JSON output for robust parsing and early stopping
    // --no-config prevents user/system .ripgreprc from interfering
    // -n shows line numbers
    // --json outputs in JSON format, which streams in and allows us to cut off the output if it grows too long
    // "--"" prevents pattern from being misparsed as a flag (e.g., pattern starting with '-')
    // Search paths: '.' plus blessed hidden directories that actually exist
    // Filter out non-existent directories to avoid ripgrep stderr errors
    const existingHiddenDirs = INCLUDED_HIDDEN_DIRS.filter((dir) => {
      try {
        return fs.statSync(path.join(searchCwd, dir)).isDirectory()
      } catch {
        return false
      }
    })
    const searchPaths = ['.', ...existingHiddenDirs]
    const args = [
      '--no-config',
      '-n',
      '--json',
      ...flagsArray,
      '--',
      pattern,
      ...searchPaths,
    ]

    if (signal?.aborted) {
      return resolve([
        {
          type: 'json',
          value: {
            stdout: '',
            message: 'Code search cancelled: the run was aborted by the user.',
          },
        },
      ])
    }

    const rgPath = getBundledRgPath(import.meta.url)
    if (logger) {
      logger.info(
        { rgPath, args, searchCwd },
        'code-search: Spawning ripgrep process',
      )
    }
    let childProcess: TerminalCommandProcess
    try {
      if (processBroker) {
        childProcess = processBroker.start({
          executable: rgPath,
          args,
          cwd: searchCwd,
          env: getSystemProcessEnv(),
        })
      } else {
        const child = spawn(rgPath, args, {
          cwd: searchCwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        childProcess = {
          pid: child.pid,
          stdout: child.stdout,
          stderr: child.stderr,
          completion: new Promise<number | null>(
            (resolveCompletion, reject) => {
              child.once('error', reject)
              child.once('close', resolveCompletion)
            },
          ),
          kill: (signal) => child.kill(signal),
          isAlive: () => child.exitCode === null && child.signalCode === null,
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return resolve([
        {
          type: 'json',
          value: { errorMessage: `Failed to execute ripgrep: ${message}` },
        },
      ])
    }

    let jsonRemainder = ''
    let stderrBuf = ''
    // Track matches by file for grouping and limiting
    const fileGroups = new Map<string, string[]>()
    // Track match count per file separately from total lines
    const fileMatchCounts = new Map<string, number>()
    const filesLimitedByMaxResults = new Set<string>()
    let matchesGlobal = 0
    let estimatedOutputLen = 0
    let killedForLimit = false

    // Guard to prevent double-settlement from concurrent timeout and process close events
    let killTimeoutId: ReturnType<typeof setTimeout> | null = null

    const settle = (payload: any) => {
      if (isResolved) return
      isResolved = true

      // Clean up listeners immediately to prevent further events
      childProcess.stdout.removeAllListeners()
      childProcess.stderr.removeAllListeners()
      signal?.removeEventListener('abort', onAbort)

      // Clear both the main timeout and the kill timeout to prevent late callbacks
      clearTimeout(timeoutId)
      if (killTimeoutId) {
        clearTimeout(killTimeoutId)
        killTimeoutId = null
      }

      resolve([{ type: 'json', value: payload }])
    }

    const hardKill = () => {
      try {
        childProcess.kill('SIGTERM')
      } catch {}
      // Store timeout reference so it can be cleared if process closes normally
      killTimeoutId = setTimeout(() => {
        try {
          childProcess.kill('SIGKILL')
        } catch {}
        killTimeoutId = null
      }, 1000)
    }

    const formatCollectedOutput = (rawOutput: string) =>
      formatCodeSearchOutput(rawOutput, {
        matchCount: matchesGlobal,
      })

    const truncateOutput = (output: string, maxLength: number) =>
      output.length > maxLength
        ? output.substring(0, maxLength) + '\n\n[Output truncated]'
        : output

    const onAbort = () => {
      if (isResolved) return
      hardKill()

      const collectedLines: string[] = []
      for (const fileLines of fileGroups.values()) {
        collectedLines.push(...fileLines)
      }
      const partialOutput = collectedLines.join('\n')

      settle({
        stdout: truncateOutput(formatCollectedOutput(partialOutput), 1000),
        message: 'Code search cancelled: the run was aborted by the user.',
      })
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const timeoutId = setTimeout(() => {
      if (isResolved) return
      hardKill()

      // Build output from collected matches
      const collectedLines: string[] = []
      for (const fileLines of fileGroups.values()) {
        collectedLines.push(...fileLines)
      }
      const partialOutput = collectedLines.join('\n')

      const truncatedStdout = truncateOutput(
        formatCollectedOutput(partialOutput),
        1000,
      )
      const truncatedStderr =
        stderrBuf.length > 1000
          ? stderrBuf.substring(0, 1000) + '\n\n[Error output truncated]'
          : stderrBuf

      settle({
        errorMessage: `Code search timed out after ${timeoutSeconds} seconds. The search may be too broad or the pattern too complex. Try narrowing your search with more specific flags or a more specific pattern.`,
        stdout: truncatedStdout,
        stderr: truncatedStderr,
      })
    }, timeoutSeconds * 1000)

    // Parse ripgrep JSON for early stopping
    childProcess.stdout.on('data', (chunk: Buffer | string) => {
      if (isResolved) return
      const chunkStr =
        typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      jsonRemainder += chunkStr

      // Split by lines; last line might be partial
      const lines = jsonRemainder.split('\n')
      jsonRemainder = lines.pop() || ''

      for (const line of lines) {
        if (!line) continue
        let evt: any
        try {
          evt = JSON.parse(line)
        } catch {
          continue
        }

        // Process both match and context events
        if (evt.type === 'match' || evt.type === 'context') {
          // Handle both text and bytes for non-UTF8 paths
          const filePath = evt.data.path?.text ?? evt.data.path?.bytes ?? ''
          const lineNumber = evt.data.line_number ?? 0
          // Strip trailing newlines to prevent blank lines in output
          const rawText = evt.data.lines?.text ?? ''
          const lineText = rawText.replace(/\r?\n$/, '')

          // Format as ripgrep output: filename:line_number:content
          const formattedLine = `${filePath}:${lineNumber}:${lineText}`

          // Group by file
          if (!fileGroups.has(filePath)) {
            fileGroups.set(filePath, [])
            fileMatchCounts.set(filePath, 0)
          }
          const fileLines = fileGroups.get(filePath)!
          const fileMatchCount = fileMatchCounts.get(filePath)!

          // Only count matches toward limits, not context lines
          const isMatch = evt.type === 'match'

          // Check if we should include this line
          // For matches: only if we haven't hit the per-file limit
          // For context: always include (they don't count toward limit)
          const shouldInclude = !isMatch || fileMatchCount < maxResults
          if (isMatch && !shouldInclude) {
            filesLimitedByMaxResults.add(filePath)
          }

          if (shouldInclude) {
            // Add the line to output
            fileLines.push(formattedLine)
            estimatedOutputLen += formattedLine.length + 1

            // Only increment match counters for actual matches
            if (isMatch) {
              fileMatchCounts.set(filePath, fileMatchCount + 1)
              matchesGlobal++

              // Check global limit or output size limit
              if (
                matchesGlobal >= globalMaxResults ||
                estimatedOutputLen >= maxOutputStringLength
              ) {
                killedForLimit = true
                hardKill()

                // Build final output from collected matches
                const limitedLines: string[] = []
                for (const lines of fileGroups.values()) {
                  limitedLines.push(...lines)
                }
                const rawOutput = limitedLines.join('\n')
                const finalOutput = truncateOutput(
                  formatCollectedOutput(rawOutput),
                  maxOutputStringLength,
                )

                const limitReason =
                  matchesGlobal >= globalMaxResults
                    ? `[Global limit of ${globalMaxResults} results reached.]`
                    : '[Output size limit reached.]'

                return settle({
                  stdout: finalOutput + '\n\n' + limitReason,
                  message: `Stopped early after ${matchesGlobal} match(es).`,
                })
              }
            }
          }
        }
      }
    })

    childProcess.stderr.on('data', (chunk: Buffer | string) => {
      if (isResolved) return
      const chunkStr =
        typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      // Keep stderr bounded during streaming
      const limit = Math.floor(maxOutputStringLength / 5)
      if (stderrBuf.length < limit) {
        const space = limit - stderrBuf.length
        stderrBuf += chunkStr.slice(0, space)
      }
    })

    childProcess.completion
      .then((code) => {
        if (isResolved) return

        // Flush any remaining JSON - handle multiple complete lines
        try {
          if (jsonRemainder) {
            // Ensure we have a trailing newline for split to work correctly
            const maybeMany = jsonRemainder.endsWith('\n')
              ? jsonRemainder
              : jsonRemainder + '\n'
            for (const ln of maybeMany.split('\n')) {
              if (!ln) continue
              try {
                const evt = JSON.parse(ln)
                if (evt?.type === 'match' || evt?.type === 'context') {
                  const filePath =
                    evt.data.path?.text ?? evt.data.path?.bytes ?? ''
                  const lineNumber = evt.data.line_number ?? 0
                  const rawText = evt.data.lines?.text ?? ''
                  const lineText = rawText.replace(/\r?\n$/, '')
                  const formattedLine = `${filePath}:${lineNumber}:${lineText}`

                  if (!fileGroups.has(filePath)) {
                    fileGroups.set(filePath, [])
                    fileMatchCounts.set(filePath, 0)
                  }
                  const fileLines = fileGroups.get(filePath)!
                  const fileMatchCount = fileMatchCounts.get(filePath)!
                  const isMatch = evt.type === 'match'

                  // Check if we should include this line
                  const shouldInclude =
                    !isMatch ||
                    (fileMatchCount < maxResults &&
                      matchesGlobal < globalMaxResults)
                  if (
                    isMatch &&
                    fileMatchCount >= maxResults &&
                    matchesGlobal < globalMaxResults
                  ) {
                    filesLimitedByMaxResults.add(filePath)
                  }

                  if (shouldInclude) {
                    fileLines.push(formattedLine)

                    // Only increment match counter for actual matches
                    if (isMatch) {
                      fileMatchCounts.set(filePath, fileMatchCount + 1)
                      matchesGlobal++
                    }
                  }
                }
              } catch {}
            }
          }
        } catch {}

        // Build final output from collected matches
        const limitedLines: string[] = []
        const truncatedFiles: string[] = []

        for (const [filename, fileLines] of fileGroups) {
          limitedLines.push(...fileLines)
          if (filesLimitedByMaxResults.has(filename)) {
            truncatedFiles.push(
              `${filename}: limited to ${maxResults} results per file`,
            )
          }
        }

        let rawOutput = limitedLines.join('\n')

        // Add truncation messages
        const truncationMessages: string[] = []
        if (truncatedFiles.length > 0) {
          truncationMessages.push(
            `Results limited to ${maxResults} per file. Truncated files:\n${truncatedFiles.join('\n')}`,
          )
        }
        if (killedForLimit) {
          truncationMessages.push(
            `Global limit of ${globalMaxResults} results reached.`,
          )
        }

        if (truncationMessages.length > 0) {
          rawOutput += `\n\n[${truncationMessages.join('\n\n')}]`
        }

        // Truncate output to prevent memory issues
        const truncatedStdout = truncateOutput(
          formatCollectedOutput(rawOutput),
          maxOutputStringLength,
        )

        const truncatedStderr = stderrBuf
          ? stderrBuf +
            (stderrBuf.length >= Math.floor(maxOutputStringLength / 5)
              ? '\n\n[Error output truncated]'
              : '')
          : ''

        settle({
          stdout: truncatedStdout,
          ...(truncatedStderr && { stderr: truncatedStderr }),
          message:
            code !== null
              ? `Exit code: ${code}${killedForLimit ? ' (early stop)' : ''}`
              : '',
        })
      })
      .catch((error: unknown) => {
        if (isResolved) return
        const message = error instanceof Error ? error.message : String(error)
        settle({
          errorMessage: `Failed to execute ripgrep: ${message}. Vendored ripgrep not found; ensure @codebuff/sdk is up-to-date or set CODEBUFF_RG_PATH.`,
        })
      })
  })
}
