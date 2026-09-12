import * as os from 'os'
import path from 'path'

import { getSystemInfo } from '@codebuff/common/util/system-info'
import {
  KNOWLEDGE_FILE_NAMES_LOWERCASE,
  isKnowledgeFile,
} from '@codebuff/common/constants/knowledge'
import {
  DEFAULT_MAX_FILES,
  getProjectFileTree,
  getAllFilePaths,
} from '@codebuff/common/project-file-tree'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getErrorObject } from '@codebuff/common/util/error'
import { cloneDeep, cloneDeepWith } from 'lodash'
import z from 'zod/v4'

import { loadLocalAgents } from './agents/load-agents'
import { loadSkills } from './skills/load-skills'

// Re-export for SDK consumers
export {
  KNOWLEDGE_FILE_NAMES,
  isKnowledgeFile,
} from '@codebuff/common/constants/knowledge'

import type { CustomToolDefinition } from './custom-tool'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type {
  AgentOutput,
  SessionState,
} from '@codebuff/common/types/session-state'
import type { SkillsMap } from '@codebuff/common/types/skill'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type {
  CustomToolDefinitions,
  FileTreeNode,
} from '@codebuff/common/util/file'
import type * as fsType from 'fs'

/**
 * Given a list of candidate file paths, selects the one with highest priority.
 * Priority order: AGENTS.md > CLAUDE.md (case-insensitive).
 * Returns undefined if no knowledge files are found.
 * @internal Exported for testing
 */
export function selectHighestPriorityKnowledgeFile(
  candidates: string[],
): string | undefined {
  // Loop through priorities and find the first match directly
  for (const priorityName of KNOWLEDGE_FILE_NAMES_LOWERCASE) {
    const match = candidates.find((f) => f.toLowerCase().endsWith(priorityName))
    if (match) return match
  }
  return undefined
}

export type RunState = {
  sessionState?: SessionState
  output: AgentOutput
  traceSessionId: string
  /** Non-secret inference identity pinned for resumed conversations. */
  inference?:
    | { source: 'codebuff' }
    | { source: 'byok'; connectionId: string; revision: number; model: string }
}

/** Result of indexing `projectFiles`: the file tree plus tree-sitter token
 *  scores. Deterministic for a given file set, so hosts that run many
 *  sessions over the same files (e.g. the Freebuff web runner, one process
 *  serving consecutive turns of a thread) can compute it once with
 *  `computeProjectIndexFromFiles` and pass it back via the `projectIndex`
 *  option instead of paying the tree-sitter parse (CPU + wasm memory) on
 *  every run. */
export type ComputedProjectIndex = {
  fileTree: FileTreeNode[]
  fileTokenScores: Record<string, any>
  tokenCallers: Record<string, any>
}

export type InitialSessionStateOptions = {
  cwd?: string
  /** Optional directory path to load skills from. When provided, skills are loaded from this directory instead of the default locations. */
  skillsDir?: string
  /**
   * Supplies the run's skills instead of the default local-filesystem walk.
   *
   * Required by any host that embeds this runner in a DIFFERENT process from
   * the repo it is acting on, because the default loader is `fs`-based and
   * would read THIS machine's disk. Freebuff Cloud is exactly that shape: the
   * runner lives in the freebuff/web server process while the repo lives in a
   * Daytona sandbox (freebuff/web/src/server/agent-runner/runTurn.ts:1346
   * passes a sandbox `cwd` that does not exist on the web server), so it
   * injects a loader that reads the sandbox. CLI and Desktop run alongside
   * their repo and correctly leave this unset.
   *
   * This is the per-run escape hatch; `includeHomeSkills` below is the blunt
   * structural guard that keeps the home directory out of the default path
   * even when a host forgets to set this.
   *
   * Called at most once, and only when a fresh session state is built. A
   * rejection is contained: it yields no skills rather than failing the run.
   */
  skillsLoader?: () => Promise<SkillsMap>
  /**
   * Also load the user's `~/.claude/skills` and `~/.agents/skills`. Defaults to
   * false, so an embedder gets project-only skills unless it states that this
   * process belongs to that user. See `LoadSkillsOptions.includeHomeSkills`.
   */
  includeHomeSkills?: boolean
  projectFiles?: Record<string, string>
  /** Precomputed index for exactly these `projectFiles` (see
   *  ComputedProjectIndex). Ignored when `projectFiles` is absent. */
  projectIndex?: ComputedProjectIndex
  knowledgeFiles?: Record<string, string>
  /** User-provided knowledge files that will be merged with home directory files */
  userKnowledgeFiles?: Record<string, string>
  agentDefinitions?: AgentDefinition[]
  customToolDefinitions?: CustomToolDefinition[]
  maxAgentSteps?: number
  fs?: CodebuffFileSystem
  spawn?: CodebuffSpawn
  logger?: Logger
}

/**
 * Processes agent definitions array and converts handleSteps functions to strings
 */
function processAgentDefinitions(
  agentDefinitions: AgentDefinition[],
): Record<string, any> {
  const processedAgentTemplates: Record<string, any> = {}
  agentDefinitions.forEach((definition) => {
    const processedConfig = { ...definition } as Record<string, any>
    if (
      processedConfig.handleSteps &&
      typeof processedConfig.handleSteps === 'function'
    ) {
      // Keep the live function for in-process execution: the stringified form
      // of a bundled function can reference out-of-scope bundler helpers
      // (e.g. esbuild keepNames' `__name`) and fail the runtime's eval.
      // JSON serialization of the session state drops it harmlessly.
      processedConfig.handleStepsFn = processedConfig.handleSteps
      processedConfig.handleSteps = processedConfig.handleSteps.toString()
    }
    if (processedConfig.id) {
      processedAgentTemplates[processedConfig.id] = processedConfig
    }
  })
  return processedAgentTemplates
}

/**
 * Processes custom tool definitions into the format expected by SessionState.
 * Converts Zod schemas to JSON Schema format so they can survive JSON serialization.
 */
function processCustomToolDefinitions(
  customToolDefinitions: CustomToolDefinition[],
): CustomToolDefinitions {
  return Object.fromEntries(
    customToolDefinitions.map((toolDefinition) => {
      // Convert Zod schema to JSON Schema format so it survives JSON serialization
      // The agent-runtime will wrap this with AI SDK's jsonSchema() helper
      const jsonSchema = z.toJSONSchema(toolDefinition.inputSchema, {
        io: 'input',
      }) as Record<string, unknown>
      delete jsonSchema['$schema']

      return [
        toolDefinition.toolName,
        {
          inputSchema: jsonSchema,
          description: toolDefinition.description,
          endsAgentStep: toolDefinition.endsAgentStep,
          exampleInputs: toolDefinition.exampleInputs,
        },
      ]
    }),
  )
}

/**
 * Computes project file indexes (file tree and token scores)
 */
type ProjectIndexInput = {
  cwd: string
  fileTree: FileTreeNode[]
  filePaths: string[]
  readFile?: (filePath: string) => string | null | Promise<string | null>
}

const MAX_DISCOVERED_PROJECT_READ_BYTES = 1_000_000

/** Per-stream cap on collected subprocess output. */
const MAX_SUBPROCESS_OUTPUT_CHARS = 10_000_000
/** A repository summary renders at most 25 changed paths. Stop pathological
 *  path listings early instead of buffering a huge working tree at startup. */
const MAX_GIT_PATH_OUTPUT_CHARS = 500_000
const MAX_CHANGED_FILES = 25
const REPOSITORY_VISIBILITY_TIMEOUT_MS = 1_000
const SUBPROCESS_TRUNCATION_MARKER = '\n[output truncated]'

const KNOWN_BOT_PATTERN =
  /(?:\[bot\]|(?:^|[\s._+/@-])(?:bot|dependabot|renovate|github-actions|codecov|coveralls|greenkeeper|mergify|semantic-release|release-please)(?:$|[\s._+/@-]))/i
const MERGED_PULL_REQUEST_PATTERNS = [
  /^Merge pull request #(\d+)\b/i,
  /\(#(\d+)\)\s*$/,
  /\(pull request #(\d+)\)\s*$/i,
]
const TEST_DIRECTORY_NAMES = new Set([
  '__tests__',
  '__specs__',
  'test',
  'tests',
  'spec',
  'specs',
])

/** Detects common test-file naming conventions without assuming a language. */
export function isTestFilePath(filePath: string): boolean {
  const segments = filePath.replaceAll('\\', '/').split('/')
  const fileName = segments.pop() ?? ''
  if (
    segments.some((segment) => TEST_DIRECTORY_NAMES.has(segment.toLowerCase()))
  ) {
    return true
  }

  const lowerFileName = fileName.toLowerCase()
  return (
    /\.(?:test|tests|spec|specs|cy)\./.test(lowerFileName) ||
    /^(?:test|spec)_.+\.[^.]+$/.test(lowerFileName) ||
    /_(?:test|tests|spec|specs)\.[^.]+$/.test(lowerFileName) ||
    /^(?:test|tests|spec|specs)\.[^.]+$/.test(lowerFileName) ||
    /(?:Test|Tests|TestCase|Spec)\.[^.]+$/.test(fileName)
  )
}

function getCompleteOutput(result: {
  stdout: string
  truncated: boolean
}): string {
  if (!result.truncated) return result.stdout
  const prefix = result.stdout.slice(0, -SUBPROCESS_TRUNCATION_MARKER.length)
  const lastNewline = prefix.lastIndexOf('\n')
  return lastNewline === -1 ? '' : prefix.slice(0, lastNewline)
}

function getHistoryStats(output: string): {
  humanContributorCount: number
  botContributorCount: number
  mergedPullRequestCount: number
  commitDatePercentiles?: {
    p0: string
    p25: string
    p50: string
    p75: string
    p100: string
  }
} {
  const contributors = new Map<string, boolean>()
  const mergedPullRequests = new Set<string>()
  const commitDates: string[] = []

  for (const line of output.split('\n')) {
    const [rawName = '', rawEmail = '', rawDate = '', ...subjectParts] =
      line.split('\t')
    const name = rawName.trim()
    const email = rawEmail.trim().toLowerCase()
    const date = rawDate.trim()
    const subject = subjectParts.join('\t').trim()
    if (!name && !email) continue

    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      commitDates.push(date)
    }

    // `--use-mailmap` canonicalizes known aliases. Email is the safest
    // remaining dedupe key; name is only a fallback for email-less commits.
    const githubEmail = email.replace(
      /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/,
      '$1@users.noreply.github.com',
    )
    const key = githubEmail || name.toLowerCase()
    const isBot = KNOWN_BOT_PATTERN.test(`${name} ${email}`)
    contributors.set(key, (contributors.get(key) ?? false) || isBot)

    for (const pattern of MERGED_PULL_REQUEST_PATTERNS) {
      const match = subject.match(pattern)
      if (match?.[1]) {
        mergedPullRequests.add(match[1])
        break
      }
    }
  }

  let botContributorCount = 0
  for (const isBot of contributors.values()) {
    if (isBot) botContributorCount++
  }
  commitDates.sort()
  const percentileDate = (percentile: number): string | undefined => {
    if (commitDates.length === 0) return undefined
    const index =
      percentile === 0 ? 0 : Math.ceil(percentile * commitDates.length) - 1
    return commitDates[Math.min(index, commitDates.length - 1)]
  }
  const p0 = percentileDate(0)
  const p25 = percentileDate(0.25)
  const p50 = percentileDate(0.5)
  const p75 = percentileDate(0.75)
  const p100 = percentileDate(1)

  return {
    humanContributorCount: contributors.size - botContributorCount,
    botContributorCount,
    mergedPullRequestCount: mergedPullRequests.size,
    commitDatePercentiles:
      p0 && p25 && p50 && p75 && p100 ? { p0, p25, p50, p75, p100 } : undefined,
  }
}

async function computeProjectIndex(params: ProjectIndexInput): Promise<{
  fileTree: FileTreeNode[]
  fileTokenScores: Record<string, any>
  tokenCallers: Record<string, any>
}> {
  const { cwd, fileTree, filePaths, readFile } = params
  let fileTokenScores = {}
  let tokenCallers = {}

  if (filePaths.length > 0) {
    try {
      const { getFileTokenScores } = await import('@codebuff/code-map/parse')
      const tokenData = await getFileTokenScores(cwd, filePaths, readFile)
      fileTokenScores = tokenData.tokenScores
      tokenCallers = tokenData.tokenCallers
    } catch (error) {
      // If token scoring fails, continue with empty scores
      console.warn('Failed to generate parsed symbol scores:', error)
    }
  }

  return { fileTree, fileTokenScores, tokenCallers }
}

/**
 * Standalone version of the index build `run()` performs internally when
 * given `projectFiles`. Hosts can call this once per distinct file set and
 * feed the result to subsequent runs via the `projectIndex` option.
 */
export async function computeProjectIndexFromFiles(params: {
  cwd: string
  projectFiles: Record<string, string>
}): Promise<ComputedProjectIndex> {
  const input = getProjectIndexInput({
    cwd: params.cwd,
    projectFiles: params.projectFiles,
  })
  if (!input) {
    return { fileTree: [], fileTokenScores: {}, tokenCallers: {} }
  }
  return computeProjectIndex(input)
}

function getProjectIndexInput(params: {
  cwd: string
  fs?: CodebuffFileSystem
  logger?: Logger
  projectFiles?: Record<string, string>
  discoveredProject?: { fileTree: FileTreeNode[]; filePaths: string[] }
}): ProjectIndexInput | undefined {
  const { cwd, fs, logger, projectFiles, discoveredProject } = params

  if (projectFiles) {
    const filePaths = Object.keys(projectFiles).sort()
    return {
      cwd,
      fileTree: buildFileTree(filePaths),
      filePaths,
      readFile: (filePath: string) => projectFiles[filePath] || null,
    }
  }

  if (discoveredProject) {
    if (!fs || !logger) return undefined

    return {
      cwd,
      fileTree: discoveredProject.fileTree,
      filePaths: discoveredProject.filePaths.sort(),
      readFile: createDiscoveredProjectReader({ cwd, fs, logger }),
    }
  }

  return undefined
}

function createDiscoveredProjectReader(params: {
  cwd: string
  fs: CodebuffFileSystem
  logger: Logger
}): (filePath: string) => Promise<string | null> {
  const { cwd, fs, logger } = params

  return async (filePath: string) => {
    const fullPath = path.join(cwd, filePath)
    try {
      const stats = await fs.stat(fullPath)
      if (getFileSize(stats) > MAX_DISCOVERED_PROJECT_READ_BYTES) {
        return null
      }
      return await fs.readFile(fullPath, 'utf8')
    } catch (error) {
      logger.debug?.(
        { filePath, error: getErrorObject(error) },
        'Failed to read discovered project file for symbol scoring',
      )
      return null
    }
  }
}

function getFileSize(stats: Awaited<ReturnType<CodebuffFileSystem['stat']>>) {
  return typeof stats.size === 'number' ? stats.size : 0
}

/**
 * Helper to convert ChildProcess to Promise with stdout/stderr
 */
function childProcessToPromise(
  proc: ReturnType<CodebuffSpawn>,
  maxOutputChars: number = MAX_SUBPROCESS_OUTPUT_CHARS,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let truncated = false
    let settled = false
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) return
            settled = true
            proc.kill()
            reject(new Error(`Command timed out after ${timeoutMs}ms`))
          }, timeoutMs)

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      callback()
    }

    const collect = (existing: string, data: Buffer): string => {
      if (truncated) return existing
      const next = existing + data.toString()
      if (next.length <= maxOutputChars) return next
      truncated = true
      proc.kill()
      return next.slice(0, maxOutputChars) + SUBPROCESS_TRUNCATION_MARKER
    }

    proc.stdout?.on('data', (data: Buffer) => {
      stdout = collect(stdout, data)
    })

    proc.stderr?.on('data', (data: Buffer) => {
      stderr = collect(stderr, data)
    })

    proc.on('close', (code: number | null) => {
      // A kill we issued at the cap exits nonzero; that must not reject, or
      // the callers' catch-to-empty would discard the collected prefix.
      if (code === 0 || truncated) {
        finish(() => resolve({ stdout, stderr, truncated }))
      } else {
        finish(() => reject(new Error(`Command exited with code ${code}`)))
      }
    })

    proc.on('error', (error) => finish(() => reject(error)))
  })
}

/**
 * Retrieves a compact repository summary using the provided spawn function.
 * Changed paths include staged, unstaged, and untracked files, and the prompt
 * receives at most MAX_CHANGED_FILES of them.
 * @internal Exported for testing
 */
export async function getGitChanges(params: {
  cwd: string
  spawn: CodebuffSpawn
  logger: Logger
  fileCount?: number
  fileCountIsLowerBound?: boolean
  testFileCount?: number
}): Promise<{
  gitAvailable: boolean
  branch?: string
  changedFiles: string[]
  changedFileCount: number
  changedFileScanTruncated: boolean
  repositoryVisibility: 'public' | 'private' | 'internal' | 'unknown'
  commitCount?: number
  historyIsShallow?: boolean
  commitDatePercentiles?: {
    p0: string
    p25: string
    p50: string
    p75: string
    p100: string
  }
  mergedPullRequestCount?: number
  humanContributorCount?: number
  botContributorCount?: number
  historyScanTruncated?: boolean
  fileCount?: number
  fileCountIsLowerBound?: boolean
  testFileCount?: number
}> {
  const {
    cwd,
    spawn,
    logger,
    fileCount,
    fileCountIsLowerBound,
    testFileCount,
  } = params

  const stdoutOf =
    (command: string) =>
    ({ stdout, truncated }: { stdout: string; truncated: boolean }) => {
      if (truncated) {
        logger.info?.(
          { command, chars: stdout.length },
          'Git command output truncated at cap',
        )
      }
      return stdout
    }

  const gitOutput = (
    args: string[],
    label: string,
    maxOutputChars = MAX_SUBPROCESS_OUTPUT_CHARS,
  ) =>
    childProcessToPromise(spawn('git', args, { cwd }), maxOutputChars)
      .then((result) => ({
        stdout: stdoutOf(label)(result),
        truncated: result.truncated,
      }))
      .catch((error) => {
        logger.debug?.({ error }, `Failed to get ${label}`)
        return undefined
      })

  const branch = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], 'git branch')
  const unstagedFiles = gitOutput(
    ['diff', '--name-only', '--'],
    'git unstaged file names',
    MAX_GIT_PATH_OUTPUT_CHARS,
  )
  const stagedFiles = gitOutput(
    ['diff', '--cached', '--name-only', '--'],
    'git staged file names',
    MAX_GIT_PATH_OUTPUT_CHARS,
  )
  const untrackedFiles = gitOutput(
    ['ls-files', '--others', '--exclude-standard'],
    'git untracked file names',
    MAX_GIT_PATH_OUTPUT_CHARS,
  )
  const commitCount = gitOutput(
    ['rev-list', '--count', 'HEAD'],
    'git commit count',
  )
  const history = gitOutput(
    ['log', '--use-mailmap', '--format=%aN%x09%aE%x09%cs%x09%s', 'HEAD'],
    'git history summary',
  )
  const historyIsShallow = gitOutput(
    ['rev-parse', '--is-shallow-repository'],
    'git shallow status',
  )
  const visibility = childProcessToPromise(
    spawn(
      'gh',
      ['repo', 'view', '--json', 'visibility', '--jq', '.visibility'],
      { cwd },
    ),
    1_000,
    REPOSITORY_VISIBILITY_TIMEOUT_MS,
  ).catch((error) => {
    logger.debug?.({ error }, 'Failed to get repository visibility')
    return undefined
  })

  const pathResults = await Promise.all([
    unstagedFiles,
    stagedFiles,
    untrackedFiles,
  ])
  const changedPaths = Array.from(
    new Set(
      pathResults.flatMap((result) => {
        if (!result) return []
        return getCompleteOutput(result)
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      }),
    ),
  ).sort()
  const gitAvailable = pathResults.some((result) => result !== undefined)
  const pathOutputTruncated = pathResults.some((result) => result?.truncated)

  const parseCount = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined
    const parsed = Number.parseInt(value.trim(), 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const historyResult = await history
  const parsedHistoryStats = historyResult
    ? getHistoryStats(getCompleteOutput(historyResult))
    : undefined
  const shallowResult = await historyIsShallow
  const shallow = shallowResult
    ? shallowResult.stdout.trim() === 'true'
    : undefined
  const historyStats = parsedHistoryStats
    ? {
        ...parsedHistoryStats,
        commitDatePercentiles: historyResult?.truncated
          ? undefined
          : parsedHistoryStats.commitDatePercentiles,
      }
    : undefined
  const visibilityValue = (await visibility)?.stdout.trim().toLowerCase()
  const repositoryVisibility =
    visibilityValue === 'public' ||
    visibilityValue === 'private' ||
    visibilityValue === 'internal'
      ? visibilityValue
      : 'unknown'

  return {
    gitAvailable,
    branch: (await branch)?.stdout.trim() || undefined,
    changedFiles: changedPaths.slice(0, MAX_CHANGED_FILES),
    changedFileCount: changedPaths.length,
    changedFileScanTruncated: pathOutputTruncated,
    repositoryVisibility,
    commitCount: parseCount((await commitCount)?.stdout),
    historyIsShallow: shallow,
    ...historyStats,
    historyScanTruncated: historyResult?.truncated,
    fileCount,
    fileCountIsLowerBound,
    testFileCount,
  }
}

/**
 * Discovers project paths using .gitignore patterns when projectFiles is undefined.
 * This intentionally does not read every file into memory; large repositories can
 * contain generated or binary files that are expensive to retain before parsing.
 */
async function discoverProjectPaths(params: {
  cwd: string
  fs: CodebuffFileSystem
}): Promise<{ fileTree: FileTreeNode[]; filePaths: string[] }> {
  const { cwd, fs } = params

  const fileTree = await getProjectFileTree({ projectRoot: cwd, fs })
  const filePaths = getAllFilePaths(fileTree)

  return { fileTree, filePaths }
}

/**
 * Loads user knowledge files from the home directory.
 * Checks for ~/.knowledge.md, ~/.AGENTS.md, and ~/.CLAUDE.md with priority fallback.
 * Matching is case-insensitive (e.g., ~/.KNOWLEDGE.md will match).
 * Returns a record with the tilde-prefixed path as key (e.g., "~/.knowledge.md").
 * @internal Exported for testing
 */
export async function loadUserKnowledgeFiles(params: {
  fs: CodebuffFileSystem
  logger: Logger
  /** Optional home directory override for testing */
  homeDir?: string
}): Promise<Record<string, string>> {
  const { fs, logger } = params
  const homeDir = params.homeDir ?? os.homedir()
  const userKnowledgeFiles: Record<string, string> = {}

  // List home directory to find knowledge files case-insensitively
  let entries: string[]
  try {
    entries = await fs.readdir(homeDir)
  } catch (error) {
    logger.debug?.(
      { homeDir, error: getErrorObject(error) },
      'Failed to read home directory',
    )
    return userKnowledgeFiles
  }

  // Find hidden files that match our knowledge file patterns (case-insensitive)
  // Build a map of lowercase name -> actual filename for priority selection
  const candidates = new Map<string, string>()
  for (const entry of entries) {
    if (!entry.startsWith('.')) continue
    const nameWithoutDot = entry.slice(1) // Remove leading dot
    const lowerName = nameWithoutDot.toLowerCase()
    if (KNOWLEDGE_FILE_NAMES_LOWERCASE.includes(lowerName)) {
      candidates.set(lowerName, entry)
    }
  }

  // Select highest priority file (priority: AGENTS.md > CLAUDE.md)
  for (const priorityName of KNOWLEDGE_FILE_NAMES_LOWERCASE) {
    const actualFileName = candidates.get(priorityName)
    if (actualFileName) {
      const filePath = path.join(homeDir, actualFileName)
      try {
        const content = await fs.readFile(filePath, 'utf8')
        // Use tilde notation with the actual filename (preserving case)
        const tildeKey = `~/${actualFileName}`
        userKnowledgeFiles[tildeKey] = content
        // Only use the first file found (highest priority)
        break
      } catch (error) {
        logger.debug?.(
          { filePath, error: getErrorObject(error) },
          'Failed to read user knowledge file',
        )
      }
    }
  }

  return userKnowledgeFiles
}

/**
 * Selects knowledge files from a list of file paths with fallback logic.
 * For each directory, checks for knowledge.md first, then AGENTS.md, then CLAUDE.md.
 * @internal Exported for testing
 */
export function selectKnowledgeFilePaths(allFilePaths: string[]): string[] {
  const knowledgeCandidates = allFilePaths.filter(isKnowledgeFile)

  // Group candidates by directory
  const byDirectory = new Map<string, string[]>()
  for (const filePath of knowledgeCandidates) {
    const dir = path.dirname(filePath)
    if (!byDirectory.has(dir)) {
      byDirectory.set(dir, [])
    }
    byDirectory.get(dir)!.push(filePath)
  }

  const selectedFiles: string[] = []

  // For each directory, select one knowledge file using priority fallback
  for (const files of byDirectory.values()) {
    const selected = selectHighestPriorityKnowledgeFile(files)
    if (selected) {
      selectedFiles.push(selected)
    }
  }

  return selectedFiles
}

/**
 * Auto-derives knowledge files from project files if knowledgeFiles is undefined.
 * Implements fallback priority: AGENTS.md > CLAUDE.md per directory.
 */
function deriveKnowledgeFiles(
  projectFiles: Record<string, string>,
): Record<string, string> {
  const allFilePaths = Object.keys(projectFiles)
  const selectedFilePaths = selectKnowledgeFilePaths(allFilePaths)

  const knowledgeFiles: Record<string, string> = {}
  for (const filePath of selectedFilePaths) {
    knowledgeFiles[filePath] = projectFiles[filePath]
  }
  return knowledgeFiles
}

async function loadKnowledgeFilesFromPaths(params: {
  cwd: string
  filePaths: string[]
  fs: CodebuffFileSystem
  logger: Logger
}): Promise<Record<string, string>> {
  const { cwd, filePaths, fs, logger } = params
  const selectedFilePaths = selectKnowledgeFilePaths(filePaths)

  const knowledgeFiles: Record<string, string> = {}
  for (const filePath of selectedFilePaths) {
    try {
      knowledgeFiles[filePath] = await fs.readFile(
        path.join(cwd, filePath),
        'utf8',
      )
    } catch (error) {
      logger.debug?.(
        { filePath, error: getErrorObject(error) },
        'Failed to read project knowledge file',
      )
    }
  }
  return knowledgeFiles
}

export async function initialSessionState(
  params: InitialSessionStateOptions,
): Promise<SessionState> {
  const {
    cwd,
    maxAgentSteps,
    skillsDir,
    skillsLoader,
    includeHomeSkills = false,
  } = params
  let {
    agentDefinitions,
    customToolDefinitions,
    projectFiles,
    knowledgeFiles,
    userKnowledgeFiles: providedUserKnowledgeFiles,
    fs,
    spawn,
    logger,
  } = params
  if (!agentDefinitions) {
    agentDefinitions = []
  }
  if (!customToolDefinitions) {
    customToolDefinitions = []
  }
  if (!fs) {
    fs = (require('fs') as typeof fsType).promises
  }
  if (!spawn) {
    const { spawn: nodeSpawn } = require('child_process')
    spawn = nodeSpawn as CodebuffSpawn
  }
  if (!logger) {
    logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
  }

  // Start repository collection before project indexing so an authenticated,
  // bounded visibility lookup is normally hidden behind work we already do.
  const gitChangesPromise = cwd
    ? getGitChanges({ cwd, spawn, logger })
    : undefined

  let discoveredProject:
    | { fileTree: FileTreeNode[]; filePaths: string[] }
    | undefined

  // Auto-discover project files if not provided and cwd is available
  if (projectFiles === undefined && cwd) {
    discoveredProject = await discoverProjectPaths({ cwd, fs })
  }
  if (knowledgeFiles === undefined) {
    if (projectFiles) {
      knowledgeFiles = deriveKnowledgeFiles(projectFiles)
    } else if (cwd && discoveredProject) {
      knowledgeFiles = await loadKnowledgeFilesFromPaths({
        cwd,
        filePaths: discoveredProject.filePaths,
        fs,
        logger,
      })
    } else {
      knowledgeFiles = {}
    }
  }

  let processedAgentTemplates: Record<string, any> = {}
  if (agentDefinitions && agentDefinitions.length > 0) {
    processedAgentTemplates = processAgentDefinitions(agentDefinitions)
  } else {
    processedAgentTemplates = await loadLocalAgents({ verbose: false })
  }
  const processedCustomToolDefinitions = processCustomToolDefinitions(
    customToolDefinitions,
  )

  let fileTree: FileTreeNode[] = []
  let fileTokenScores: Record<string, any> = {}
  let tokenCallers: Record<string, any> = {}

  if (params.projectIndex && projectFiles !== undefined) {
    // Host supplied the index for these exact projectFiles — skip the
    // tree-sitter parse entirely.
    fileTree = params.projectIndex.fileTree
    fileTokenScores = params.projectIndex.fileTokenScores
    tokenCallers = params.projectIndex.tokenCallers
  } else {
    const projectIndex = cwd
      ? getProjectIndexInput({
          cwd,
          fs,
          logger,
          projectFiles,
          discoveredProject,
        })
      : undefined
    if (projectIndex) {
      const result = await computeProjectIndex(projectIndex)
      fileTree = result.fileTree
      fileTokenScores = result.fileTokenScores
      tokenCallers = result.tokenCallers
    }
  }

  const projectFilePaths = getAllFilePaths(fileTree)
  const fileCount = projectFilePaths.length
  const testFileCount = projectFilePaths.filter(isTestFilePath).length
  const fileCountIsLowerBound =
    projectFiles === undefined &&
    discoveredProject !== undefined &&
    discoveredProject.filePaths.length >= DEFAULT_MAX_FILES

  // Gather git changes if cwd is available
  const gitChanges = cwd
    ? {
        ...(await gitChangesPromise!),
        // The project tree has already been built for agent context and
        // respects ignore rules, so counting it adds no filesystem traversal.
        fileCount,
        fileCountIsLowerBound,
        testFileCount,
      }
    : {
        gitAvailable: false,
        changedFiles: [],
        changedFileCount: 0,
        changedFileScanTruncated: false,
        repositoryVisibility: 'unknown' as const,
        fileCount,
        fileCountIsLowerBound,
        testFileCount,
      }

  // Load user knowledge files from home directory and merge with any provided ones
  const homeKnowledgeFiles = await loadUserKnowledgeFiles({ fs, logger })
  const userKnowledgeFiles = {
    ...homeKnowledgeFiles,
    ...providedUserKnowledgeFiles,
  }

  // Load skills. An injected loader wins outright: it is the only correct
  // source for a host whose repo is not on this machine (see `skillsLoader`).
  // Skills are prompt content, never control flow, so a loader that throws
  // must degrade to "no skills" rather than take the whole turn down with it.
  let skills: SkillsMap
  if (skillsLoader) {
    try {
      skills = await skillsLoader()
    } catch (error) {
      logger.error(
        { error: getErrorObject(error) },
        'Injected skills loader failed; continuing with no skills',
      )
      skills = {}
    }
  } else {
    skills = await loadSkills({
      cwd: cwd ?? process.cwd(),
      skillsPath: skillsDir,
      verbose: false,
      includeHomeSkills,
    })
  }

  const initialState = getInitialSessionState({
    projectRoot: cwd ?? process.cwd(),
    cwd: cwd ?? process.cwd(),
    fileTree,
    fileTokenScores,
    tokenCallers,
    knowledgeFiles,
    userKnowledgeFiles,
    agentTemplates: processedAgentTemplates,
    customToolDefinitions: processedCustomToolDefinitions,
    skills,
    // Carried into the context so the `skill` TOOL's own disk lookup obeys the
    // same decision as the loader above. They are two independent lookups and
    // the tool's result wins, so one flag has to govern both or the opt-in is
    // only half real.
    includeHomeSkills,
    gitChanges,
    changesSinceLastChat: {},
    shellConfigFiles: {},
    systemInfo: getSystemInfo(),
  })

  if (maxAgentSteps) {
    initialState.mainAgentState.stepsRemaining = maxAgentSteps
  }

  return initialState
}

export async function generateInitialRunState({
  cwd,
  skillsDir,
  projectFiles,
  knowledgeFiles,
  userKnowledgeFiles,
  agentDefinitions,
  customToolDefinitions,
  maxAgentSteps,
  fs,
}: {
  cwd: string
  skillsDir?: string
  projectFiles?: Record<string, string>
  knowledgeFiles?: Record<string, string>
  userKnowledgeFiles?: Record<string, string>
  agentDefinitions?: AgentDefinition[]
  customToolDefinitions?: CustomToolDefinition[]
  maxAgentSteps?: number
  fs: CodebuffFileSystem
}): Promise<RunState> {
  return {
    traceSessionId: crypto.randomUUID(),
    sessionState: await initialSessionState({
      cwd,
      skillsDir,
      projectFiles,
      knowledgeFiles,
      userKnowledgeFiles,
      agentDefinitions,
      customToolDefinitions,
      maxAgentSteps,
      fs,
    }),
    output: {
      type: 'error',
      message: 'No output yet',
    },
  }
}

export function withAdditionalMessage({
  runState,
  message,
}: {
  runState: RunState
  message: Message
}): RunState {
  const newRunState = cloneDeep(runState)

  if (newRunState.sessionState) {
    newRunState.sessionState.mainAgentState.messageHistory.push(message)
  }

  return newRunState
}

export function withMessageHistory({
  runState,
  messages,
}: {
  runState: RunState
  messages: Message[]
}): RunState {
  // Deep copy
  const newRunState = JSON.parse(JSON.stringify(runState)) as typeof runState

  if (newRunState.sessionState) {
    newRunState.sessionState.mainAgentState.messageHistory = messages
  }

  return newRunState
}

/**
 * True for a zod schema, which is the only kind of value a clone has to be
 * careful with here.
 */
const isZodSchema = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { safeParse?: unknown; _zod?: unknown }
  return (
    typeof candidate.safeParse === 'function' && candidate._zod !== undefined
  )
}

/**
 * Deep-clones a value without destroying the zod schemas inside it.
 *
 * zod installs its internals on a non-enumerable `_zod` property, and lodash
 * copies own *enumerable* properties only. A plain `cloneDeep` therefore
 * returns something that still looks like a schema -- `safeParse` lives on the
 * prototype, so it survives -- but has lost `_zod`, and the next zod call on it
 * throws "undefined is not an object (evaluating 'schema._zod.parent')".
 * Schemas are immutable, so the clone keeps them as they are.
 */
export const cloneDeepPreservingZodSchemas = <T>(value: T): T =>
  cloneDeepWith(value, (candidate) =>
    isZodSchema(candidate) ? candidate : undefined,
  )

/**
 * Applies overrides to an existing session state, allowing specific fields to be updated
 * even when continuing from a previous run.
 */
export async function applyOverridesToSessionState(
  cwd: string | undefined,
  baseSessionState: SessionState,
  overrides: {
    projectFiles?: Record<string, string>
    /** Precomputed index for exactly these `projectFiles` (see
     *  ComputedProjectIndex). Ignored when `projectFiles` is absent. */
    projectIndex?: ComputedProjectIndex
    knowledgeFiles?: Record<string, string>
    agentDefinitions?: AgentDefinition[]
    customToolDefinitions?: CustomToolDefinition[]
    maxAgentSteps?: number
  },
): Promise<SessionState> {
  // Deep clone to avoid mutating the original session state. The JSON
  // round-trip is the fast path - it matches what a persisted snapshot looks
  // like - but this state can hold values JSON.stringify rejects. A resumed
  // session carries the tool blocks of the turn before it, and a recursive zod
  // `lazy` schema is cyclic: stringifying it throws "cannot serialize cyclic
  // structures" and the resume dies. lodash cloneDeep handles cycles, so fall
  // back to it and keep the clone working instead of losing the session.
  //
  // The catch is deliberately not narrowed, but it is narrower than "any JSON
  // failure": in practice the throw comes from a cycle or a BigInt. Values JSON
  // merely drops or coerces - `undefined`, functions, symbols, Date, URL - do
  // not throw, so they keep taking the JSON path exactly as they did before and
  // never reach cloneDeep. The fallback therefore only runs where this function
  // used to throw: it repairs the resume that used to fail rather than changing
  // one that used to work. On that path cloneDeep keeps the whole graph, which
  // is the safe side to err on, since the clone is this turn's working copy.
  // It goes through cloneDeepPreservingZodSchemas rather than plain cloneDeep:
  // the values that make this state cyclic are the live zod schemas of the
  // previous turn's MCP tools, and lodash drops a schema's non-enumerable
  // internals, leaving a schema-shaped object that throws on first use.
  // Mirrors cloneSessionState, which falls back the same way in run.ts.
  let sessionState: SessionState
  try {
    sessionState = JSON.parse(JSON.stringify(baseSessionState)) as SessionState
  } catch {
    sessionState = cloneDeepPreservingZodSchemas(baseSessionState)
  }

  // Apply maxAgentSteps override
  if (overrides.maxAgentSteps !== undefined) {
    sessionState.mainAgentState.stepsRemaining = overrides.maxAgentSteps
  }

  // Apply projectFiles override (recomputes file tree and token scores)
  if (overrides.projectFiles !== undefined) {
    if (overrides.projectIndex) {
      // Host supplied the index for these exact projectFiles — skip the
      // tree-sitter parse entirely.
      sessionState.fileContext.fileTree = overrides.projectIndex.fileTree
      sessionState.fileContext.fileTokenScores =
        overrides.projectIndex.fileTokenScores
      sessionState.fileContext.tokenCallers =
        overrides.projectIndex.tokenCallers
    } else if (cwd) {
      const projectIndex = getProjectIndexInput({
        cwd,
        projectFiles: overrides.projectFiles,
      })
      if (projectIndex) {
        const { fileTree, fileTokenScores, tokenCallers } =
          await computeProjectIndex(projectIndex)
        sessionState.fileContext.fileTree = fileTree
        sessionState.fileContext.fileTokenScores = fileTokenScores
        sessionState.fileContext.tokenCallers = tokenCallers
      }
    } else {
      // If projectFiles are provided but no cwd, reset file context fields
      sessionState.fileContext.fileTree = []
      sessionState.fileContext.fileTokenScores = {}
      sessionState.fileContext.tokenCallers = {}
    }

    // Auto-derive knowledgeFiles if not explicitly provided
    if (overrides.knowledgeFiles === undefined) {
      sessionState.fileContext.knowledgeFiles = deriveKnowledgeFiles(
        overrides.projectFiles,
      )
    }
  }

  // Apply knowledgeFiles override
  if (overrides.knowledgeFiles !== undefined) {
    sessionState.fileContext.knowledgeFiles = overrides.knowledgeFiles
  }

  // Apply agentDefinitions override (merge by id, last-in wins)
  if (overrides.agentDefinitions !== undefined) {
    const processedAgentTemplates = processAgentDefinitions(
      overrides.agentDefinitions,
    )
    sessionState.fileContext.agentTemplates = {
      ...sessionState.fileContext.agentTemplates,
      ...processedAgentTemplates,
    }
  }

  // Apply customToolDefinitions override (replace by toolName)
  if (overrides.customToolDefinitions !== undefined) {
    const processedCustomToolDefinitions = processCustomToolDefinitions(
      overrides.customToolDefinitions,
    )
    sessionState.fileContext.customToolDefinitions = {
      ...sessionState.fileContext.customToolDefinitions,
      ...processedCustomToolDefinitions,
    }
  }

  return sessionState
}

/**
 * Builds a hierarchical file tree from a flat list of file paths
 */
function buildFileTree(filePaths: string[]): FileTreeNode[] {
  const tree: Record<string, FileTreeNode> = {}

  // Build the tree structure
  for (const filePath of filePaths) {
    const parts = filePath.split('/')

    for (let i = 0; i < parts.length; i++) {
      const currentPath = parts.slice(0, i + 1).join('/')
      const isFile = i === parts.length - 1

      if (!tree[currentPath]) {
        tree[currentPath] = {
          name: parts[i],
          type: isFile ? 'file' : 'directory',
          filePath: currentPath,
          children: isFile ? undefined : [],
        }
      }
    }
  }

  // Organize into hierarchical structure
  const rootNodes: FileTreeNode[] = []
  const processed = new Set<string>()

  for (const [path, node] of Object.entries(tree)) {
    if (processed.has(path)) continue

    const parentPath = path.substring(0, path.lastIndexOf('/'))
    if (parentPath && tree[parentPath]) {
      // This node has a parent, add it to parent's children
      const parent = tree[parentPath]
      if (
        parent.children &&
        !parent.children.some((child) => child.filePath === path)
      ) {
        parent.children.push(node)
      }
    } else {
      // This is a root node
      rootNodes.push(node)
    }
    processed.add(path)
  }

  // Sort function for nodes
  function sortNodes(nodes: FileTreeNode[]): void {
    nodes.sort((a, b) => {
      // Directories first, then files
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    // Recursively sort children
    for (const node of nodes) {
      if (node.children) {
        sortNodes(node.children)
      }
    }
  }

  sortNodes(rootNodes)
  return rootNodes
}
