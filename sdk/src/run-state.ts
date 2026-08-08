import * as os from 'os'
import path from 'path'

import { getSystemInfo } from '@codebuff/common/util/system-info'
import {
  KNOWLEDGE_FILE_NAMES_LOWERCASE,
  isKnowledgeFile,
} from '@codebuff/common/constants/knowledge'
import {
  getProjectFileTree,
  getAllFilePaths,
} from '@codebuff/common/project-file-tree'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getErrorObject } from '@codebuff/common/util/error'
import { cloneDeep } from 'lodash'
import z from 'zod/v4'

import { loadLocalAgents } from './agents/load-agents'
import { loadSkills } from './skills/load-skills'

// Re-export for SDK consumers
export {
  KNOWLEDGE_FILE_NAMES,
  PRIMARY_KNOWLEDGE_FILE_NAME,
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
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type {
  CustomToolDefinitions,
  FileTreeNode,
} from '@codebuff/common/util/file'
import type * as fsType from 'fs'

/**
 * Given a list of candidate file paths, selects the one with highest priority.
 * Priority order: knowledge.md > AGENTS.md > CLAUDE.md (case-insensitive).
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

/** Per-stream cap on collected subprocess output. A working-tree diff can be
 *  multiple GB (huge tracked files), which used to accumulate unbounded until
 *  the string hit the runtime's ~2GB ceiling and threw RangeError: Out of
 *  memory. Downstream prompt building keeps only the first ~30KB, so anything
 *  past this cap is discarded work; the child is killed once it's reached. */
const MAX_SUBPROCESS_OUTPUT_CHARS = 10_000_000
const SUBPROCESS_TRUNCATION_MARKER = '\n[output truncated]'

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
): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let truncated = false

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
        resolve({ stdout, stderr, truncated })
      } else {
        reject(new Error(`Command exited with code ${code}`))
      }
    })

    proc.on('error', reject)
  })
}

/**
 * Retrieves git changes for the project using the provided spawn function.
 * Output is capped per command (see MAX_SUBPROCESS_OUTPUT_CHARS).
 * @internal Exported for testing
 */
export async function getGitChanges(params: {
  cwd: string
  spawn: CodebuffSpawn
  logger: Logger
}): Promise<{
  status: string
  diff: string
  diffCached: string
  lastCommitMessages: string
}> {
  const { cwd, spawn, logger } = params

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

  const status = childProcessToPromise(spawn('git', ['status'], { cwd }))
    .then(stdoutOf('git status'))
    .catch((error) => {
      logger.debug?.({ error }, 'Failed to get git status')
      return ''
    })

  const diff = childProcessToPromise(spawn('git', ['diff'], { cwd }))
    .then(stdoutOf('git diff'))
    .catch((error) => {
      logger.debug?.({ error }, 'Failed to get git diff')
      return ''
    })

  const diffCached = childProcessToPromise(
    spawn('git', ['diff', '--cached'], { cwd }),
  )
    .then(stdoutOf('git diff --cached'))
    .catch((error) => {
      logger.debug?.({ error }, 'Failed to get git diff --cached')
      return ''
    })

  const lastCommitMessages = childProcessToPromise(
    spawn('git', ['shortlog', 'HEAD~10..HEAD'], { cwd }),
  )
    .then(({ stdout }) =>
      stdout
        .trim()
        .split('\n')
        .slice(1)
        .reverse()
        .map((line) => line.trim())
        .join('\n'),
    )
    .catch((error) => {
      logger.debug?.({ error }, 'Failed to get lastCommitMessages')
      return ''
    })

  return {
    status: await status,
    diff: await diff,
    diffCached: await diffCached,
    lastCommitMessages: await lastCommitMessages,
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

  // Select highest priority file (priority: knowledge.md > AGENTS.md > CLAUDE.md)
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
 * Implements fallback priority: knowledge.md > AGENTS.md > CLAUDE.md per directory.
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
  const { cwd, maxAgentSteps, skillsDir } = params
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

  // Gather git changes if cwd is available
  const gitChanges = cwd
    ? await getGitChanges({ cwd, spawn, logger })
    : {
        status: '',
        diff: '',
        diffCached: '',
        lastCommitMessages: '',
      }

  // Load user knowledge files from home directory and merge with any provided ones
  const homeKnowledgeFiles = await loadUserKnowledgeFiles({ fs, logger })
  const userKnowledgeFiles = {
    ...homeKnowledgeFiles,
    ...providedUserKnowledgeFiles,
  }

  // Load skills from project and home directories
  const skills = await loadSkills({
    cwd: cwd ?? process.cwd(),
    skillsPath: skillsDir,
    verbose: false,
  })

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
  // Deep clone to avoid mutating the original session state. A JSON
  // round-trip is the fast path, but run state can carry cyclic values
  // (e.g. recursive zod schemas inside tool blocks) that make
  // JSON.stringify throw ("cannot serialize cyclic structures"); lodash
  // cloneDeep handles cycles, so fall back to it. Mirrors cloneSessionState.
  let sessionState: SessionState
  try {
    sessionState = JSON.parse(
      JSON.stringify(baseSessionState),
    ) as SessionState
  } catch {
    sessionState = cloneDeep(baseSessionState)
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
