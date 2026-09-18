import fs from 'fs'
import path from 'path'
import readline from 'readline'

import {
  MCP_CONFIG_FILE_NAME,
  listLocalAgentFiles,
  mcpFileSchema,
} from '@codebuff/sdk'
import { bold, cyan, yellow } from 'picocolors'

import { getConfigDir } from './config-dir'
import { IS_FREEBUFF } from './constants'

/**
 * Trust gate for repository-scoped `.agents` directories.
 *
 * `loadLocalAgents` dynamically imports every `.ts`/`.js` file under
 * `{cwd}/.agents` and `{cwd}/../.agents`, and `loadMCPConfigSync` reads an
 * `mcp.json` there whose stdio servers are spawned on the first prompt with
 * `$VAR` env references filled from THIS process's environment. Both run
 * attacker-authored code the moment the CLI starts inside a cloned repository,
 * so a directory that contains anything executable has to be trusted by the
 * user once before it is loaded. `~/.agents` is the user's own and never
 * needs trust; directories holding only `skills/` markdown do not either.
 *
 * Trust is recorded per absolute directory path in
 * `<configDir>/trusted-agent-dirs.json` (mode 0600). Non-interactive runs
 * never prompt: they skip the directory and say so, unless the operator
 * opted in with `CODEBUFF_TRUST_AGENT_DIRS=1` or `--trust-agents`.
 */

export const TRUST_STORE_FILE_NAME = 'trusted-agent-dirs.json'
export const TRUST_AGENT_DIRS_ENV_VAR = 'CODEBUFF_TRUST_AGENT_DIRS'
export const TRUST_AGENTS_FLAG = '--trust-agents'

const MAX_LISTED_AGENT_FILES = 10

export type TrustStore = Record<string, { trustedAt: string }>

export type McpServerSummary = {
  name: string
  /** What loading this server would do: the command line, or the URL. */
  launch: string
}

export type AgentDirInventory = {
  /** The `.agents` directory, as given (not normalized). */
  dir: string
  /** Executable agent files the loader would import, relative to `dir`. */
  agentFiles: string[]
  /** `mcp.json` summary, or null when the directory has none. */
  mcpJson: { servers: McpServerSummary[]; parseError?: string } | null
  /** True when loading this directory would execute repository-supplied code. */
  needsTrust: boolean
}

export type AgentDirTrustResult = {
  /** Directories the loaders may read, in the caller's original order. */
  agentDirs: string[]
  /** Repository-scoped directories withheld from this run. */
  skippedDirs: string[]
}

export const isTruthyOptIn = (value: string | undefined): boolean =>
  value !== undefined && /^(1|true|yes)$/i.test(value.trim())

/**
 * Canonical form used for trust-store keys and home-dir comparison. Resolves
 * symlinks when the directory exists so a trusted path cannot be re-pointed
 * at a different one; falls back to an absolute path otherwise.
 */
export const normalizeAgentDir = (dir: string): string => {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

// ============================================================================
// Trust store
// ============================================================================

export const getTrustStorePath = (configDir: string = getConfigDir()): string =>
  path.join(configDir, TRUST_STORE_FILE_NAME)

/** Read the store; a missing or malformed file reads as "nothing trusted". */
export const readTrustStore = (storePath: string): TrustStore => {
  let raw: string
  try {
    raw = fs.readFileSync(storePath, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const store: TrustStore = {}
    for (const [dir, entry] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { trustedAt?: unknown }).trustedAt === 'string'
      ) {
        store[dir] = { trustedAt: (entry as { trustedAt: string }).trustedAt }
      }
    }
    return store
  } catch {
    return {}
  }
}

export const isAgentDirTrusted = (dir: string, store: TrustStore): boolean =>
  Object.prototype.hasOwnProperty.call(store, normalizeAgentDir(dir))

/** Record `dir` as trusted. Read-modify-write; the file is created 0600. */
export const trustAgentDir = ({
  dir,
  storePath,
  now = () => new Date(),
}: {
  dir: string
  storePath: string
  now?: () => Date
}): TrustStore => {
  const store = readTrustStore(storePath)
  store[normalizeAgentDir(dir)] = { trustedAt: now().toISOString() }
  fs.mkdirSync(path.dirname(storePath), { recursive: true })
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', {
    mode: 0o600,
  })
  return store
}

// ============================================================================
// Inventory: what would run if this directory were loaded
// ============================================================================

const summarizeMcpJson = (dir: string): AgentDirInventory['mcpJson'] => {
  const configPath = path.join(dir, MCP_CONFIG_FILE_NAME)
  let raw: string
  try {
    if (!fs.statSync(configPath).isFile()) return null
    raw = fs.readFileSync(configPath, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = mcpFileSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      return { servers: [], parseError: 'invalid mcp.json' }
    }
    const servers: McpServerSummary[] = Object.entries(
      parsed.data.mcpServers,
    ).map(([name, config]) => {
      if ('command' in config) {
        return {
          name,
          launch: [config.command, ...(config.args ?? [])].join(' '),
        }
      }
      return { name, launch: config.url }
    })
    return { servers }
  } catch {
    return { servers: [], parseError: 'unreadable mcp.json' }
  }
}

export const inspectAgentDir = (dir: string): AgentDirInventory => {
  const agentFiles = listLocalAgentFiles(dir)
    .map((file) => path.relative(dir, file))
    .sort()
  const mcpJson = summarizeMcpJson(dir)
  return {
    dir,
    agentFiles,
    mcpJson,
    needsTrust: agentFiles.length > 0 || mcpJson !== null,
  }
}

// ============================================================================
// Prompt text
// ============================================================================

const cliName = (): string => (IS_FREEBUFF ? 'freebuff' : 'codebuff')

export const formatTrustPrompt = (inventory: AgentDirInventory): string => {
  const lines: string[] = []
  lines.push('')
  lines.push(
    bold(
      `${cliName()} found agent files in this repository it has not run before:`,
    ),
  )
  lines.push('')
  lines.push(`  ${cyan(inventory.dir)}`)

  if (inventory.agentFiles.length > 0) {
    const shown = inventory.agentFiles.slice(0, MAX_LISTED_AGENT_FILES)
    const more = inventory.agentFiles.length - shown.length
    lines.push(
      `    agents: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`,
    )
  }

  if (inventory.mcpJson) {
    if (inventory.mcpJson.parseError) {
      lines.push(`    ${MCP_CONFIG_FILE_NAME}: ${inventory.mcpJson.parseError}`)
    } else if (inventory.mcpJson.servers.length === 0) {
      lines.push(`    ${MCP_CONFIG_FILE_NAME}: no servers`)
    } else {
      lines.push(`    ${MCP_CONFIG_FILE_NAME}: would start`)
      for (const server of inventory.mcpJson.servers) {
        lines.push(`      ${server.name}: ${server.launch}`)
      }
    }
  }

  lines.push('')
  lines.push(
    yellow(
      'These run with your permissions and can read your environment. Only load them if you trust this repository.',
    ),
  )
  lines.push('')
  return lines.join('\n')
}

export const formatSkippedNote = (dir: string): string =>
  `Skipped agents and mcp.json in ${dir} for this run. Re-run and answer y to trust it, or set ${TRUST_AGENT_DIRS_ENV_VAR}=1 (or pass ${TRUST_AGENTS_FLAG}).`

export const formatNonInteractiveNote = (dir: string): string =>
  `Not loading agents or mcp.json from ${dir}: it has not been trusted and this is not an interactive terminal. Run ${cliName()} interactively once to trust it, or set ${TRUST_AGENT_DIRS_ENV_VAR}=1 (or pass ${TRUST_AGENTS_FLAG}).`

/**
 * Plain-terminal yes/no prompt, run before the OpenTUI app mounts (the same
 * precedent as `runPlainLogin`). `terminal: false` keeps stdin in cooked
 * mode so nothing has to be restored before the TUI takes stdin over.
 */
export const promptForAgentDirTrust = async (
  inventory: AgentDirInventory,
): Promise<boolean> => {
  process.stdout.write(formatTrustPrompt(inventory) + '\n')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.once('close', () => resolve(''))
      rl.question('Load and run these? [y/N] ', resolve)
    })
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

// ============================================================================
// Decision
// ============================================================================

/**
 * Decide which of the default agent directories this run may load.
 *
 * `homeAgentsDir` is always kept. Every other candidate is kept when it needs
 * no trust (missing, empty, or skills-only), is already in the store, or
 * `trustAll` is set (an explicit opt-in that is NOT persisted). Otherwise an
 * interactive run asks once and persists a `y`; a non-interactive run skips
 * the directory and reports it through `notify`.
 */
export async function resolveTrustedAgentDirs({
  candidateDirs,
  homeAgentsDir,
  interactive,
  trustAll,
  storePath,
  prompt,
  notify,
  now = () => new Date(),
}: {
  candidateDirs: string[]
  homeAgentsDir: string
  interactive: boolean
  trustAll: boolean
  storePath: string
  prompt: (inventory: AgentDirInventory) => Promise<boolean>
  notify: (message: string) => void
  now?: () => Date
}): Promise<AgentDirTrustResult> {
  const agentDirs: string[] = []
  const skippedDirs: string[] = []
  const normalizedHome = normalizeAgentDir(homeAgentsDir)
  let store: TrustStore | null = null

  for (const dir of candidateDirs) {
    if (normalizeAgentDir(dir) === normalizedHome) {
      agentDirs.push(dir)
      continue
    }

    const inventory = inspectAgentDir(dir)
    if (!inventory.needsTrust) {
      agentDirs.push(dir)
      continue
    }

    store ??= readTrustStore(storePath)
    if (isAgentDirTrusted(dir, store) || trustAll) {
      agentDirs.push(dir)
      continue
    }

    if (!interactive) {
      skippedDirs.push(dir)
      notify(formatNonInteractiveNote(dir))
      continue
    }

    if (await prompt(inventory)) {
      store = trustAgentDir({ dir, storePath, now })
      agentDirs.push(dir)
    } else {
      skippedDirs.push(dir)
      notify(formatSkippedNote(dir))
    }
  }

  return { agentDirs, skippedDirs }
}
