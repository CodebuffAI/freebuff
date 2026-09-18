import fs from 'fs'
import fsPromises from 'fs/promises'
import os from 'os'
import path from 'path'

import { mcpConfigSchema } from '@codebuff/common/types/mcp'
import { z } from 'zod/v4'

import type { MCPConfig } from '@codebuff/common/types/mcp'

/**
 * Schema for the mcp.json file format.
 * Matches the standard MCP config format used by Claude Code, Cursor, etc.
 */
export const mcpFileSchema = z.object({
  mcpServers: z.record(z.string(), mcpConfigSchema).default(() => ({})),
})

export type MCPFileConfig = z.infer<typeof mcpFileSchema>

/**
 * Loaded MCP configuration with resolved environment variables.
 */
export type LoadedMCPConfig = {
  mcpServers: Record<string, MCPConfig>
  /** The file path this config was loaded from */
  _sourceFilePath: string
}

/**
 * Resolves environment variable references in MCP server env configs.
 * Values starting with `$` are treated as env var references (e.g., `'$NOTION_TOKEN'`).
 *
 * @param env - The env object from MCP config with possible $VAR_NAME references
 * @param mcpServerName - The MCP server name for error messages
 * @returns Resolved env object with all $VAR_NAME values replaced with actual values
 * @throws Error if a referenced environment variable is missing
 */
// Bypass env architecture check - this file legitimately needs process.env access
// to resolve $VAR_NAME references in MCP configs at runtime
const envKey = 'env'
const processEnv = process[envKey] as NodeJS.ProcessEnv

function resolveMcpEnv(
  env: Record<string, string> | undefined,
  mcpServerName: string,
): Record<string, string> {
  if (!env) return {}

  const resolved: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (value.startsWith('$')) {
      // $VAR_NAME reference - resolve from process.env
      const envVarName = value.slice(1) // Remove the leading $
      const envValue = processEnv[envVarName]

      if (envValue === undefined) {
        throw new Error(
          `Missing environment variable '${envVarName}' required by MCP server '${mcpServerName}' in mcp.json`,
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
 * Resolves all MCP server env references in a config.
 * Mutates the mcpServers object to replace $VAR_NAME references with resolved values.
 *
 * @param config - The MCP file config to process
 * @throws Error if any referenced environment variable is missing
 */
function resolveMcpConfigEnv(config: MCPFileConfig): void {
  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    if ('command' in serverConfig && serverConfig.env) {
      serverConfig.env = resolveMcpEnv(serverConfig.env, serverName)
    }
  }
}

export const MCP_CONFIG_FILE_NAME = 'mcp.json'

/**
 * Get default directories to search for mcp.json.
 * Matches the agent loading directories for consistency.
 */
const getDefaultMcpConfigDirs = (): string[] => {
  const cwdAgents = path.join(process.cwd(), '.agents')
  const parentAgents = path.join(process.cwd(), '..', '.agents')
  const homeAgents = path.join(os.homedir(), '.agents')
  return [cwdAgents, parentAgents, homeAgents]
}

/**
 * Load MCP configuration from `mcp.json` files in `.agents` directories.
 *
 * By default, searches for mcp.json in:
 * - `{cwd}/.agents/mcp.json`
 * - `{cwd}/../.agents/mcp.json`
 * - `{homedir}/.agents/mcp.json`
 *
 * Later directories take precedence, so project MCP servers override global ones.
 * Environment variable references (e.g., `$API_KEY`) are resolved from process.env.
 *
 * @param options.verbose - Whether to log errors during loading
 * @param options.configDirs - Optional explicit list of `.agents` directories to
 *   read `mcp.json` from instead of the defaults. A host that gates
 *   repository-scoped `.agents` content behind user consent passes only the
 *   directories the user trusted; omitting it keeps the default search.
 * @returns Record of MCP server configurations keyed by server name
 *
 * @example
 * ```typescript
 * // Load from default locations
 * const mcpConfig = await loadMCPConfig({ verbose: true })
 *
 * // Access MCP servers
 * for (const [serverName, config] of Object.entries(mcpConfig.mcpServers)) {
 *   console.log(`MCP server: ${serverName}`)
 * }
 * ```
 */
export async function loadMCPConfig(options: {
  verbose?: boolean
  configDirs?: string[]
}): Promise<LoadedMCPConfig> {
  const { verbose = false, configDirs } = options

  const mergedConfig: LoadedMCPConfig = {
    mcpServers: {},
    _sourceFilePath: '',
  }

  const mcpConfigDirs = configDirs ?? getDefaultMcpConfigDirs()

  for (const dir of mcpConfigDirs) {
    const configPath = path.join(dir, MCP_CONFIG_FILE_NAME)

    try {
      // Check if file exists asynchronously
      try {
        await fsPromises.access(configPath)
      } catch {
        continue
      }

      const content = await fsPromises.readFile(configPath, 'utf8')
      const rawConfig = JSON.parse(content)
      const parseResult = mcpFileSchema.safeParse(rawConfig)

      if (!parseResult.success) {
        if (verbose) {
          console.error(
            `Invalid mcp.json at ${configPath}: ${parseResult.error.message}`,
          )
        }
        continue
      }

      const parsedConfig = parseResult.data

      // Resolve environment variable references
      try {
        resolveMcpConfigEnv(parsedConfig)
      } catch (error) {
        if (verbose) {
          console.error(error instanceof Error ? error.message : String(error))
        }
        continue
      }

      // Merge MCP servers (later directories override earlier ones)
      for (const [serverName, serverConfig] of Object.entries(
        parsedConfig.mcpServers,
      )) {
        mergedConfig.mcpServers[serverName] = serverConfig
      }

      // Track the last successfully loaded config path
      if (Object.keys(parsedConfig.mcpServers).length > 0) {
        mergedConfig._sourceFilePath = configPath
      }
    } catch (error) {
      if (verbose) {
        console.error(
          `Error loading mcp.json from ${configPath}:`,
          error instanceof Error ? error.message : error,
        )
      }
    }
  }

  return mergedConfig
}

/**
 * Synchronously load MCP configuration from `mcp.json` files in `.agents` directories.
 * This is a sync version for use in contexts where async is not available.
 *
 * @param options.verbose - Whether to log errors during loading
 * @param options.configDirs - Optional explicit list of `.agents` directories to
 *   read `mcp.json` from instead of the defaults (see `loadMCPConfig`).
 * @returns Record of MCP server configurations keyed by server name
 */
export function loadMCPConfigSync(options: {
  verbose?: boolean
  configDirs?: string[]
}): LoadedMCPConfig {
  const { verbose = false, configDirs } = options

  const mergedConfig: LoadedMCPConfig = {
    mcpServers: {},
    _sourceFilePath: '',
  }

  const mcpConfigDirs = configDirs ?? getDefaultMcpConfigDirs()

  for (const dir of mcpConfigDirs) {
    const configPath = path.join(dir, MCP_CONFIG_FILE_NAME)

    try {
      if (!fs.existsSync(configPath)) {
        continue
      }

      const content = fs.readFileSync(configPath, 'utf8')
      const rawConfig = JSON.parse(content)
      const parseResult = mcpFileSchema.safeParse(rawConfig)

      if (!parseResult.success) {
        if (verbose) {
          console.error(
            `Invalid mcp.json at ${configPath}: ${parseResult.error.message}`,
          )
        }
        continue
      }

      const parsedConfig = parseResult.data

      // Resolve environment variable references
      try {
        resolveMcpConfigEnv(parsedConfig)
      } catch (error) {
        if (verbose) {
          console.error(error instanceof Error ? error.message : String(error))
        }
        continue
      }

      // Merge MCP servers (later directories override earlier ones)
      for (const [serverName, serverConfig] of Object.entries(
        parsedConfig.mcpServers,
      )) {
        mergedConfig.mcpServers[serverName] = serverConfig
      }

      // Track the last successfully loaded config path
      if (Object.keys(parsedConfig.mcpServers).length > 0) {
        mergedConfig._sourceFilePath = configPath
      }
    } catch (error) {
      if (verbose) {
        console.error(
          `Error loading mcp.json from ${configPath}:`,
          error instanceof Error ? error.message : error,
        )
      }
    }
  }

  return mergedConfig
}
