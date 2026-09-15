import fs from 'fs'
import os from 'os'
import path from 'path'

import { pluralize } from '@codebuff/common/util/string'
import {
  loadLocalAgents as sdkLoadLocalAgents,
  loadMCPConfigSync,
} from '@codebuff/sdk'

import type { MCPConfig } from '@codebuff/common/types/mcp'

import { getSelectedFreebuffModel } from '../state/freebuff-model-store'
import { getProjectRoot } from '../project-files'
import { IS_FREEBUFF, type AgentMode } from './constants'
import { getAgentIdForMode } from './freebuff-agent-selection'
import { logger } from './logger'
import * as bundledAgentsModule from '../agents/bundled-agents.generated'

import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

// ============================================================================
// Constants and types
// ============================================================================

const AGENTS_DIR_NAME = '.agents'

export interface LocalAgentInfo {
  id: string
  displayName: string
  filePath: string
  /** True if this is a bundled Codebuff agent (not user-created) */
  isBundled?: boolean
}

// ============================================================================
// User agents cache (loaded via SDK at startup)
// ============================================================================

let userAgentsCache: Record<string, AgentDefinition> = {}
// Map from agent ID to source file path (for UI "Open file" links)
let userAgentFilePaths: Map<string, string> = new Map()
// Cache for MCP servers loaded from mcp.json in .agents directories
let mcpServersCache: Record<string, MCPConfig> = {}

/**
 * Initialize the agent registry by loading user agents via the SDK.
 * This must be called at CLI startup before any sync agent loading functions.
 *
 * Agents are loaded from:
 * - {cwd}/.agents (project)
 * - {cwd}/../.agents (parent, e.g. monorepo root)
 * - ~/.agents (global, user's home directory)
 *
 * Later directories take precedence, so project agents override global ones.
 */
export async function initializeAgentRegistry(): Promise<void> {
  try {
    // Let SDK load from all default directories (cwd, parent, home)
    userAgentsCache = await sdkLoadLocalAgents({ verbose: false })
    // Build ID-to-filepath map by scanning all agent directories
    userAgentFilePaths = buildAgentFilePathMap(getDefaultAgentDirs())
  } catch (error) {
    // Fall back to empty cache if SDK loading fails, but log a warning
    logger.warn(
      { error },
      'Failed to load user agents from .agents directories',
    )
    userAgentsCache = {}
    userAgentFilePaths = new Map()
  }

  // Load MCP config from mcp.json files in .agents directories
  try {
    const mcpConfig = loadMCPConfigSync({ verbose: false })
    mcpServersCache = mcpConfig.mcpServers
    if (Object.keys(mcpServersCache).length > 0) {
      logger.debug(
        {
          mcpServers: Object.keys(mcpServersCache),
          source: mcpConfig._sourceFilePath,
        },
        '[agents] Loaded MCP servers from mcp.json',
      )
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to load MCP config from .agents directories')
    mcpServersCache = {}
  }
}

/**
 * Reload the local agent registry after the active project changes.
 *
 * The derived agent-list and directory caches depend on the current working
 * directory, so they must be cleared before the registry is initialized for
 * the new project.
 */
export async function reloadLocalAgentRegistry(): Promise<void> {
  cachedAgentsByMode.clear()
  cachedAgentsDir = null
  await initializeAgentRegistry()
}

/**
 * Get default agent directories to scan.
 * Matches the SDK's getDefaultAgentDirs() to ensure consistency.
 */
const getDefaultAgentDirs = (): string[] => {
  const cwdAgents = path.join(process.cwd(), AGENTS_DIR_NAME)
  const parentAgents = path.join(process.cwd(), '..', AGENTS_DIR_NAME)
  const homeAgents = path.join(os.homedir(), AGENTS_DIR_NAME)
  return [cwdAgents, parentAgents, homeAgents]
}

/**
 * Scan agent directories and build a map from agent ID to source file path.
 * Uses regex to extract IDs from files without requiring module loading.
 * Later directories in the list take precedence (can override earlier ones).
 */
const buildAgentFilePathMap = (agentsDirs: string[]): Map<string, string> => {
  const idToPath = new Map<string, string>()
  const idRegex = /id\s*:\s*['"`]([^'"`]+)['"`]/i

  const scanDirectory = (dir: string): void => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          scanDirectory(fullPath)
          continue
        }
        if (
          !entry.isFile() ||
          !entry.name.endsWith('.ts') ||
          entry.name.endsWith('.d.ts') ||
          entry.name.endsWith('.test.ts')
        ) {
          continue
        }
        try {
          const content = fs.readFileSync(fullPath, 'utf8')
          const match = content.match(idRegex)
          if (match?.[1]) {
            idToPath.set(match[1], fullPath)
          }
        } catch {
          // Skip files that can't be read
        }
      }
    } catch {
      // Skip directories that can't be read
    }
  }

  // Scan all directories - later directories override earlier ones
  for (const agentsDir of agentsDirs) {
    scanDirectory(agentsDir)
  }
  return idToPath
}

/**
 * Get user agents from the cache as LocalAgentInfo[]
 */
const getUserAgentsAsLocalInfo = (): LocalAgentInfo[] => {
  return Object.values(userAgentsCache).map((def) => ({
    id: def.id,
    displayName: def.displayName || def.id,
    filePath: userAgentFilePaths.get(def.id) || '',
  }))
}

/**
 * Get user agents from the cache as AgentDefinition[]
 */
const getUserAgentDefinitions = (): AgentDefinition[] => {
  return Object.values(userAgentsCache) as AgentDefinition[]
}

// ============================================================================
// Bundled agents loading (generated at build time by prebuild-agents.ts)
// ============================================================================

const getBundledAgents = (): Record<string, AgentDefinition> => {
  return bundledAgentsModule.bundledAgents ?? {}
}

const getBundledAgentsAsLocalInfo = (): LocalAgentInfo[] => {
  return bundledAgentsModule.getBundledAgentsAsLocalInfo?.() ?? []
}

// ============================================================================
// Directory finding
// ============================================================================

let cachedAgentsDir: string | null = null

export const findAgentsDirectory = (): string | null => {
  if (cachedAgentsDir && fs.existsSync(cachedAgentsDir)) {
    return cachedAgentsDir
  }

  const projectRoot = getProjectRoot() || process.cwd()
  if (projectRoot) {
    const rootCandidate = path.join(projectRoot, AGENTS_DIR_NAME)
    if (
      fs.existsSync(rootCandidate) &&
      fs.statSync(rootCandidate).isDirectory()
    ) {
      cachedAgentsDir = rootCandidate
      return cachedAgentsDir
    }
  }

  let currentDir = process.cwd()
  const filesystemRoot = path.parse(currentDir).root

  while (true) {
    const candidate = path.join(currentDir, AGENTS_DIR_NAME)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      cachedAgentsDir = candidate
      return cachedAgentsDir
    }

    if (currentDir === filesystemRoot) {
      break
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      break
    }

    currentDir = parentDir
  }

  cachedAgentsDir = null
  return null
}

// ============================================================================
// Agent loading - LocalAgentInfo (lightweight, for UI/listing)
// ============================================================================

// Cache keyed by agent mode (or 'all' for no filtering)
const cachedAgentsByMode: Map<string, LocalAgentInfo[]> = new Map()

/**
 * Load local agents for display in the '@' menu.
 *
 * @param currentAgentMode - If provided, filters bundled agents to only include
 *   subagents of the current mode's agent (e.g., base2's spawnableAgents for DEFAULT mode).
 *   User's local agents from .agents/ are always included regardless of mode.
 */
export const loadLocalAgents = (
  currentAgentMode?: AgentMode,
): LocalAgentInfo[] => {
  const selectedFreebuffModel = IS_FREEBUFF ? getSelectedFreebuffModel() : null
  const cacheKey = selectedFreebuffModel
    ? `${currentAgentMode ?? 'all'}:${selectedFreebuffModel}`
    : (currentAgentMode ?? 'all')
  const cached = cachedAgentsByMode.get(cacheKey)
  if (cached) {
    return cached
  }

  // Get bundled agents - these are the default Codebuff agents
  // compiled into the CLI binary at build time
  const bundledAgentsInfo = getBundledAgentsAsLocalInfo()
  const bundledAgents = getBundledAgents()

  // Filter bundled agents to only include subagents of the current mode's agent
  let filteredBundledAgents: LocalAgentInfo[]
  if (currentAgentMode) {
    const currentAgentId = getAgentIdForMode(currentAgentMode)
    const currentAgentDef = bundledAgents[currentAgentId]
      ? bundledAgents[currentAgentId]
      : undefined
    const spawnableAgentIds = new Set(currentAgentDef?.spawnableAgents ?? [])

    // Only include bundled agents that are in the spawnableAgents list
    filteredBundledAgents = bundledAgentsInfo.filter((agent) =>
      spawnableAgentIds.has(agent.id),
    )
  } else {
    filteredBundledAgents = bundledAgentsInfo
  }

  const results: LocalAgentInfo[] = [...filteredBundledAgents]
  const includedIds = new Set(filteredBundledAgents.map((a) => a.id))

  // Get user agents from the SDK-loaded cache
  // User agents are always included (not filtered by mode) and can override bundled agents
  const userAgents = getUserAgentsAsLocalInfo()

  // Merge user agents - they override bundled agents with same ID
  // and are always included regardless of mode filtering
  for (const userAgent of userAgents) {
    if (includedIds.has(userAgent.id)) {
      // Replace bundled agent with user's version
      const idx = results.findIndex((a) => a.id === userAgent.id)
      if (idx !== -1) {
        results[idx] = userAgent
      }
    } else {
      results.push(userAgent)
      includedIds.add(userAgent.id)
    }
  }

  const sorted = results.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, 'en'),
  )

  cachedAgentsByMode.set(cacheKey, sorted)
  return sorted
}

// ============================================================================
// Agent loading - AgentDefinition (full definitions for runtime)
// ============================================================================

/**
 * Load agent definitions from bundled agents and user's .agents directory.
 * Bundled agents are compiled into the CLI binary at build time.
 * User agents from .agents/ are loaded via SDK at startup and cached.
 * User agents can override bundled agents with the same ID.
 *
 * Additionally, all user agent IDs are automatically added to the spawnableAgents
 * of any base agent (agents with IDs starting with 'base'), so users can spawn
 * their custom agents without needing to modify the base agent definition.
 */
export const loadAgentDefinitions = (): AgentDefinition[] => {
  // Start with bundled agents - these are the default Codebuff agents
  const bundledAgents = getBundledAgents()
  const definitions: AgentDefinition[] = Object.values(bundledAgents).map(
    (def) => ({ ...def }),
  )
  const bundledIds = new Set(Object.keys(bundledAgents))

  // Get user agents from the SDK-loaded cache
  const userAgentDefs = getUserAgentDefinitions()
  const userAgentIds = userAgentDefs.map((def) => def.id)

  for (const agentDef of userAgentDefs) {
    // User agents override bundled agents with the same ID
    if (bundledIds.has(agentDef.id)) {
      const idx = definitions.findIndex((d) => d.id === agentDef.id)
      if (idx !== -1) {
        definitions[idx] = { ...agentDef }
      }
    } else {
      definitions.push({ ...agentDef })
    }
  }

  // Auto-add user agent IDs to spawnableAgents of base agents
  // This allows users to spawn their custom agents without needing to
  // explicitly add them to the base agent's spawnableAgents list
  if (userAgentIds.length > 0) {
    for (const def of definitions) {
      // Consider any agent with an ID starting with 'base' as a base agent
      if (def.id.startsWith('base') && def.spawnableAgents) {
        const existingSpawnable = new Set(def.spawnableAgents)
        for (const userAgentId of userAgentIds) {
          if (!existingSpawnable.has(userAgentId)) {
            def.spawnableAgents = [...def.spawnableAgents, userAgentId]
          }
        }
      }
    }
  }

  // Merge MCP servers from mcp.json into base agents
  // This allows users to configure MCP tools that are available to the main agent
  if (Object.keys(mcpServersCache).length > 0) {
    for (const def of definitions) {
      // Consider any agent with an ID starting with 'base' as a base agent
      if (def.id.startsWith('base')) {
        // Initialize mcpServers if not present
        if (!def.mcpServers) {
          def.mcpServers = {}
        }
        // Merge MCP servers (user config can override existing servers)
        def.mcpServers = {
          ...def.mcpServers,
          ...mcpServersCache,
        }
      }
    }
  }

  return definitions
}

// ============================================================================
// UI/Display utilities
// ============================================================================

export const announceLoadedAgents = (): void => {
  const agents = loadLocalAgents()
  const agentsDir = findAgentsDirectory()

  if (!agentsDir) {
    logger.debug('[agents] No .agents directory found in this project.')
    return
  }

  if (!agents.length) {
    logger.debug({ agentsDir }, '[agents] No agent files found')
    return
  }

  const agentIdentifiers = agents.map((agent) =>
    agent.displayName && agent.displayName !== agent.id
      ? `${agent.displayName} (${agent.id})`
      : agent.displayName || agent.id,
  )

  logger.debug(
    { agentsDir, agents: agentIdentifiers },
    `[agents] Loaded ${pluralize(agents.length, 'local agent')}`,
  )
}

export const getLoadedAgentsMessage = (): string | null => {
  const agents = loadLocalAgents()
  const agentsDir = findAgentsDirectory()

  if (!agentsDir || !agents.length) {
    return null
  }

  const agentCount = agents.length
  const header = `Loaded ${pluralize(agentCount, 'local agent')} from ${agentsDir}`
  const agentList = agents
    .map((agent) => {
      const identifier =
        agent.displayName && agent.displayName !== agent.id
          ? `${agent.displayName} (${agent.id})`
          : agent.displayName || agent.id
      return `  - ${identifier}`
    })
    .join('\n')

  return `${header}\n${agentList}`
}

export const getLoadedAgentsData = (): {
  agents: LocalAgentInfo[]
  agentsDir: string
} | null => {
  const agents = loadLocalAgents()
  const agentsDir = findAgentsDirectory()

  if (!agentsDir || !agents.length) {
    return null
  }

  return { agents, agentsDir }
}

// ============================================================================
// Testing utilities
// ============================================================================

/**
 * Clear cached agent listings. Intended for test scenarios that need to
 * re-evaluate the filesystem state between cases.
 */
export const __resetLocalAgentRegistryForTests = (): void => {
  cachedAgentsByMode.clear()
  cachedAgentsDir = null
  userAgentsCache = {}
  userAgentFilePaths = new Map()
  mcpServersCache = {}
}

/**
 * Get the currently loaded MCP servers from mcp.json.
 * Useful for debugging and displaying loaded MCP configuration.
 */
export const getLoadedMCPServers = (): Record<string, MCPConfig> => {
  return { ...mcpServersCache }
}
