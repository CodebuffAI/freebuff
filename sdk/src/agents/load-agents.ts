import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

import { validateAgents } from '../validate-agents'

import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

/**
 * Agent definition with source file path metadata.
 */
export type LoadedAgentDefinition = AgentDefinition & {
  /** The file path this agent was loaded from */
  _sourceFilePath: string
  /** Live copy of handleSteps kept alongside its stringified form (see
   * processedAgentDefinition below). */
  handleStepsFn?: AgentDefinition['handleSteps']
}

/**
 * Loaded agent definitions keyed by agent ID.
 */
export type LoadedAgents = Record<string, LoadedAgentDefinition>

/**
 * Resolves environment variable references in MCP server configs.
 * Values starting with `$` are treated as env var references (e.g., `'$NOTION_TOKEN'`).
 *
 * @param env - The env object from MCP config with possible $VAR_NAME references
 * @param agentId - The agent ID for error messages
 * @param mcpServerName - The MCP server name for error messages
 * @returns Resolved env object with all $VAR_NAME values replaced with actual values
 * @throws Error if a referenced environment variable is missing
 */
export function resolveMcpEnv(
  env: Record<string, string> | undefined,
  agentId: string,
  mcpServerName: string,
): Record<string, string> {
  if (!env) return {}

  const resolved: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (value.startsWith('$')) {
      // $VAR_NAME reference - resolve from process.env
      const envVarName = value.slice(1) // Remove the leading $
      // Allow dynamic process.env access
      const envName = 'env'
      const envValue = process[envName][envVarName]

      if (envValue === undefined) {
        throw new Error(
          `Missing environment variable '${envVarName}' required by agent '${agentId}' in mcpServers.${mcpServerName}.env.${key}`,
        )
      }

      resolved[key] = envValue
    } else {
      // Plain string value - use as-is
      resolved[key] = value
    }
  }

  return resolved
}

/**
 * Resolves all MCP server env references in an agent definition.
 * Mutates the mcpServers object to replace $VAR_NAME references with resolved values.
 *
 * @param agent - The agent definition to process
 * @throws Error if any referenced environment variable is missing
 */
export function resolveAgentMcpEnv(agent: AgentDefinition): void {
  if (!agent.mcpServers) return

  for (const [serverName, config] of Object.entries(agent.mcpServers)) {
    if ('command' in config && config.env) {
      config.env = resolveMcpEnv(config.env, agent.id, serverName)
    }
  }
}

/**
 * Validation error for an agent that failed validation.
 */
export type AgentValidationError = {
  /** The agent's ID */
  agentId: string
  /** The source file path where the agent was loaded from */
  filePath: string
  /** The validation error message */
  message: string
}

/**
 * Result returned by loadLocalAgents when validate: true.
 * Contains both the valid agents and any validation errors.
 */
export type LoadLocalAgentsResult = {
  /** Valid agent definitions that passed validation */
  agents: LoadedAgents
  /** Validation errors for agents that failed validation */
  validationErrors: AgentValidationError[]
}

const agentFileExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])

const shouldSkipAgentDirectory = (name: string): boolean =>
  name.startsWith('.') ||
  name === 'node_modules' ||
  name === 'scripts' ||
  name === 'skills' ||
  name.startsWith('skills-')

const isLoadableAgentFileName = (fileName: string): boolean => {
  const extension = path.extname(fileName).toLowerCase()
  return (
    agentFileExtensions.has(extension) &&
    !fileName.endsWith('.d.ts') &&
    !/[./](test|spec)\.[cm]?[tj]sx?$/.test(fileName)
  )
}

/**
 * List every file under `dir` that `loadLocalAgents` would import: `.ts`,
 * `.tsx`, `.js`, `.mjs` or `.cjs`, minus `.d.ts` and test files, skipping
 * `skills/`, `scripts/`, `node_modules` and dot-directories. Hosts use this to
 * decide whether a repository-scoped `.agents` directory contains anything
 * executable before importing it.
 *
 * @returns Absolute file paths; empty when the directory does not exist.
 */
export const listLocalAgentFiles = (dir: string): string[] => {
  const files: string[] = []
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (shouldSkipAgentDirectory(entry.name)) continue
        files.push(...listLocalAgentFiles(fullPath))
        continue
      }
      const isAgentFile = entry.isFile() && isLoadableAgentFileName(entry.name)
      if (isAgentFile) {
        files.push(fullPath)
      }
    }
  } catch {
    // Expected for user agent directories that may not exist
  }
  return files
}

/**
 * The directories `loadLocalAgents` and `loadMCPConfig` search by default:
 * `{cwd}/.agents`, `{cwd}/../.agents` and `{homedir}/.agents`, in that order
 * (later entries take precedence when ids collide).
 */
export const getDefaultAgentDirs = (): string[] => {
  const cwdAgents = path.join(process.cwd(), '.agents')
  const parentAgents = path.join(process.cwd(), '..', '.agents')
  const homeAgents = path.join(os.homedir(), '.agents')
  return [cwdAgents, parentAgents, homeAgents]
}

/**
 * Load agent definitions from `.agents` directories.
 *
 * By default, searches for agents in:
 * - `{cwd}/.agents`
 * - `{cwd}/../.agents`
 * - `{homedir}/.agents`
 *
 * Agent files can be `.ts`, `.tsx`, `.js`, `.mjs`, or `.cjs`.
 * TypeScript files are loaded natively by Bun's runtime.
 *
 * @param options.agentsPath - Optional path to a specific agents directory
 * @param options.agentDirs - Optional explicit list of directories to scan
 *   instead of the defaults. A host that gates repository-scoped `.agents`
 *   content behind user consent passes only the directories the user trusted;
 *   omitting it keeps the default search. Ignored when `agentsPath` is set.
 * @param options.verbose - Whether to log errors during loading
 * @param options.validate - Whether to validate agents after loading
 * @returns When validate is false/omitted: Record of agent definitions keyed by agent ID.
 *          When validate is true: Object with valid agents and validation errors.
 *
 * @example
 * ```typescript
 * // Load from default locations
 * const agents = await loadLocalAgents({ verbose: true })
 *
 * // Load from a specific directory
 * const agents = await loadLocalAgents({ agentsPath: './my-agents' })
 *
 * // Load and validate agents - returns both valid agents and errors
 * const { agents, validationErrors } = await loadLocalAgents({ validate: true })
 * if (validationErrors.length > 0) {
 *   console.error('Some agents failed validation:', validationErrors)
 * }
 *
 * // Access source file path for debugging
 * for (const agent of Object.values(agents)) {
 *   console.log(`${agent.id} loaded from ${agent._sourceFilePath}`)
 * }
 *
 * // Use with client.run()
 * const result = await client.run({
 *   agent: 'my-agent',
 *   agentDefinitions: Object.values(agents),
 *   prompt: 'Hello',
 * })
 * ```
 */
// Overload: validate: true returns result with agents and errors
export async function loadLocalAgents(options: {
  agentsPath?: string
  agentDirs?: string[]
  verbose?: boolean
  validate: true
}): Promise<LoadLocalAgentsResult>

// Overload: validate: false or omitted returns just agents (backward compatible)
export async function loadLocalAgents(options: {
  agentsPath?: string
  agentDirs?: string[]
  verbose?: boolean
  validate?: false
}): Promise<LoadedAgents>

// Implementation
export async function loadLocalAgents({
  agentsPath,
  agentDirs: explicitAgentDirs,
  verbose = false,
  validate = false,
}: {
  agentsPath?: string
  agentDirs?: string[]
  verbose?: boolean
  validate?: boolean
}): Promise<LoadedAgents | LoadLocalAgentsResult> {
  const agents: LoadedAgents = {}

  const agentDirs = agentsPath
    ? [agentsPath]
    : (explicitAgentDirs ?? getDefaultAgentDirs())
  const allAgentFiles = agentDirs.flatMap((dir) => listLocalAgentFiles(dir))

  if (allAgentFiles.length === 0) {
    return validate ? { agents, validationErrors: [] } : agents
  }

  for (const fullPath of allAgentFiles) {
    try {
      const agentModule = await importAgentModule(fullPath)
      if (!agentModule) {
        continue
      }
      const agentDefinition = agentModule.default ?? agentModule

      if (!agentDefinition?.id || !agentDefinition?.model) {
        if (verbose) {
          console.error(
            `Agent definition missing required attributes (id, model): ${fullPath}`,
          )
        }
        continue
      }

      const processedAgentDefinition: LoadedAgentDefinition = {
        ...agentDefinition,
        _sourceFilePath: fullPath,
      }
      if (agentDefinition.handleSteps) {
        if (typeof agentDefinition.handleSteps === 'function') {
          // Keep the live function: the stringified form of a bundled function
          // can reference out-of-scope bundler helpers and fail eval later.
          processedAgentDefinition.handleStepsFn = agentDefinition.handleSteps
        }
        processedAgentDefinition.handleSteps =
          agentDefinition.handleSteps.toString()
      }

      // Resolve $env references in MCP server configs
      try {
        resolveAgentMcpEnv(processedAgentDefinition)
      } catch (error) {
        if (verbose) {
          console.error(error instanceof Error ? error.message : String(error))
        }
        continue
      }

      agents[processedAgentDefinition.id] = processedAgentDefinition
    } catch (error) {
      if (verbose) {
        console.error(
          `Error loading agent from file ${fullPath}:`,
          error instanceof Error ? error.message : error,
        )
      }
    }
  }

  // Validate agents if requested
  if (validate) {
    const validationErrors: AgentValidationError[] = []

    if (Object.keys(agents).length > 0) {
      const result = await validateAgents(Object.values(agents))

      if (!result.success) {
        // Build a map of agent IDs to their validation errors
        // The validation error id format is "{agentId}_{index}" from validateAgents
        const errorsByAgentId = new Map<string, string>()
        for (const err of result.validationErrors) {
          // Extract agent ID by removing the "_index" suffix added by validateAgents
          const lastUnderscoreIdx = err.id.lastIndexOf('_')
          const agentId =
            lastUnderscoreIdx > 0 ? err.id.slice(0, lastUnderscoreIdx) : err.id
          if (!errorsByAgentId.has(agentId)) {
            errorsByAgentId.set(agentId, err.message)
          }
        }

        // Filter out invalid agents and collect validation errors
        for (const agentId of Object.keys(agents)) {
          const errorMessage = errorsByAgentId.get(agentId)
          if (errorMessage) {
            const agent = agents[agentId]
            validationErrors.push({
              agentId,
              filePath: agent._sourceFilePath,
              message: errorMessage,
            })
            if (verbose) {
              console.error(
                `Validation failed for agent '${agentId}': ${errorMessage}`,
              )
            }
            delete agents[agentId]
          }
        }
      }
    }

    return { agents, validationErrors }
  }

  return agents
}

async function importAgentModule(fullPath: string): Promise<any | null> {
  // Cache-bust to ensure fresh imports when agent files change
  const urlVersion = `?update=${Date.now()}`
  return import(`${pathToFileURL(fullPath).href}${urlVersion}`)
}
