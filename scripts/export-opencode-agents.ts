#!/usr/bin/env bun
/**
 * Export Freebuff's agent definitions to opencode's agent format.
 *
 * Freebuff agents are TypeScript objects (`agents/**\/*.ts`, default export)
 * with `id`, `model`, `displayName`, `spawnerPrompt`, `instructionsPrompt`,
 * `systemPrompt`, `toolNames` and `spawnableAgents`. opencode reads Markdown
 * agents from `.opencode/agents/<name>.md` (or `~/.config/opencode/agents/`)
 * with a YAML frontmatter `description`, `mode`, `model` and `permissions`,
 * and the document body as the agent's system prompt.
 *
 * Usage:
 *   bun scripts/export-opencode-agents.ts [--out <dir>] [--dry-run]
 *
 * Default output is `.opencode/agents` in the repository root, which opencode
 * discovers when it is started from this repository.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(import.meta.dir, '..')
const AGENTS_DIR = join(REPO_ROOT, 'agents')

const SKIPPED_DIRS = new Set([
  'types',
  'e2e',
  '__tests__',
  'node_modules',
])

type FreebuffAgent = {
  id: string
  model?: string
  displayName?: string
  spawnerPrompt?: string
  instructionsPrompt?: string
  systemPrompt?: string
  toolNames?: string[]
  spawnableAgents?: string[]
  outputMode?: string
  hidden?: boolean
}

const EDIT_TOOLS = new Set([
  'write_file',
  'str_replace',
  'edit_file',
  'create_plan',
  'add_subgoal',
  'update_subgoal',
])
const SHELL_TOOLS = new Set([
  'run_terminal_command',
  'bash',
  'tmux-cli',
  'tmux_cli',
])
const SUBAGENT_TOOLS = new Set(['spawn_agents', 'spawn_agent_inline'])
const WEB_TOOLS = new Set(['web_search', 'read_url', 'browser_use', 'browser_logs'])

/** opencode providers are keyed by models.dev ids; a few Freebuff ids use
 *  a different vendor slug for the same provider. */
const PROVIDER_ALIASES: Record<string, string> = {
  'z-ai': 'zai',
  'zhipu': 'zai',
  'moonshot-ai': 'moonshotai',
  'minimax-ai': 'minimax',
  'upstage-ai': 'upstage',
}

/** Freebuff fills these placeholders at runtime; opencode has no equivalent,
 *  so name what the agent would have received instead of leaving raw tags. */
const PLACEHOLDER_TEXT: Record<string, string> = {
  USER_INPUT_PROMPT: "the user's message for this turn (see the conversation)",
  AGENTS_PROMPT: 'the list of agents you can spawn',
  TOOLS_PROMPT: 'the list of tools available to you',
  FILE_TREE_PROMPT: 'the project file tree',
  FILE_TREE_PROMPT_SMALL: 'the project file tree',
  FILE_TREE_PROMPT_LARGE: 'the project file tree',
  GIT_CHANGES_PROMPT: 'the current git changes',
  INITIAL_AGENT_PROMPT: 'the initial agent prompt',
  KNOWLEDGE_FILES_CONTENTS: 'the contents of the project knowledge files',
  PROJECT_ROOT: 'the project root',
  USER_CWD: 'the current working directory',
  REMAINING_STEPS: 'the number of steps remaining',
  SYSTEM_INFO_PROMPT: 'system information',
  CURRENT_DATE: 'the current date',
  AGENT_NAME: 'the agent name',
}

function parseArgs(argv: string[]): { out: string; dryRun: boolean } {
  let out = join(REPO_ROOT, '.opencode', 'agents')
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') {
      const value = argv[++i]
      if (!value) throw new Error('--out needs a directory')
      out = resolve(REPO_ROOT, value)
    } else if (arg === '--dry-run') {
      dryRun = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return { out, dryRun }
}

async function listAgentFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      files.push(...(await listAgentFiles(fullPath)))
      continue
    }
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.d.ts')) continue
    if (/\.(test|e2e\.test|integration\.test)\.ts$/.test(entry.name)) continue
    // Runner scripts (`run-librarian.ts`, `run-browser-use.ts`) are not
    // agent definitions and execute work when imported.
    if (entry.name.startsWith('run-')) continue
    files.push(fullPath)
  }
  return files.sort()
}

/** `publisher/agent@1.0.0` -> `agent` */
function simpleId(id: string): string {
  const withoutVersion = id.split('@')[0] ?? id
  const parts = withoutVersion.split('/')
  return parts[parts.length - 1] ?? withoutVersion
}

function toOpencodeModel(model: string | undefined): string | undefined {
  if (!model) return undefined
  const [provider, ...rest] = model.split('/')
  if (!provider || rest.length === 0) return undefined
  return [PROVIDER_ALIASES[provider] ?? provider, ...rest].join('/')
}

function fillPlaceholders(text: string): string {
  return text.replace(/\{CODEBUFF_([A-Z_]+)\}/g, (_match, name: string) => {
    const mapped = PLACEHOLDER_TEXT[name]
    return mapped ? `<${mapped}>` : `[${name.toLowerCase().replaceAll('_', ' ')}]`
  })
}

function agentBody(agent: FreebuffAgent): string {
  const parts: string[] = []
  const name = agent.displayName ?? agent.id
  parts.push(`# ${name} (${agent.id})`)

  const prompt = [agent.systemPrompt, agent.instructionsPrompt]
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .join('\n\n')

  if (prompt.trim().length > 0) {
    parts.push(fillPlaceholders(prompt))
  } else if (agent.spawnerPrompt) {
    parts.push(agent.spawnerPrompt)
  }

  const spawnable = (agent.spawnableAgents ?? []).map(simpleId).filter(Boolean)
  if (spawnable.length > 0) {
    parts.push(
      [
        '## Subagents',
        '',
        'You can launch these opencode subagents:',
        '',
        ...spawnable.map((id) => `- \`${id}\``),
      ].join('\n'),
    )
  }

  return `${parts.join('\n\n')}\n`
}

function escapeYamlString(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  const clipped = oneLine.length > 400 ? `${oneLine.slice(0, 397)}...` : oneLine
  return JSON.stringify(clipped)
}

type Permission = { action: string; resource: string; effect: 'allow' | 'deny' }

function permissionsFor(
  agent: FreebuffAgent,
  allowsSubagents: boolean,
): Permission[] {
  const tools = new Set(agent.toolNames ?? [])
  const has = (set: Set<string>) => [...set].some((tool) => tools.has(tool))
  const canEdit = has(EDIT_TOOLS) || tools.size === 0
  const canShell = has(SHELL_TOOLS)
  const canWeb = has(WEB_TOOLS)
  const canSpawn = allowsSubagents && (has(SUBAGENT_TOOLS) || tools.size === 0)

  return [
    { action: 'edit', resource: '*', effect: canEdit ? 'allow' : 'deny' },
    { action: 'shell', resource: '*', effect: canShell ? 'allow' : 'deny' },
    // Read/discovery tools stay available; an agent that cannot read cannot
    // do its job, and every Freebuff subagent is given the project context.
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'glob', resource: '*', effect: 'allow' },
    { action: 'grep', resource: '*', effect: 'allow' },
    { action: 'webfetch', resource: '*', effect: canWeb ? 'allow' : 'deny' },
    { action: 'websearch', resource: '*', effect: canWeb ? 'allow' : 'deny' },
    { action: 'subagent', resource: '*', effect: canSpawn ? 'allow' : 'deny' },
  ]
}

function toMarkdown(
  agent: FreebuffAgent,
  options: { mode: 'primary' | 'subagent' | 'all'; allowsSubagents: boolean },
): string {
  const description =
    agent.spawnerPrompt?.trim() ||
    `${agent.displayName ?? agent.id}: a Freebuff agent exported for opencode.`

  const frontmatter: string[] = ['---']
  frontmatter.push(`description: ${escapeYamlString(description)}`)
  frontmatter.push(`mode: ${options.mode}`)

  const model = toOpencodeModel(agent.model)
  if (model) frontmatter.push(`model: ${model}`)

  frontmatter.push('permissions:')
  for (const rule of permissionsFor(agent, options.allowsSubagents)) {
    frontmatter.push(`  - action: ${rule.action}`)
    frontmatter.push(`    resource: ${JSON.stringify(rule.resource)}`)
    frontmatter.push(`    effect: ${rule.effect}`)
  }
  frontmatter.push('---')

  return `${frontmatter.join('\n')}\n\n${agentBody(agent)}`
}

function sanitizeName(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function loadAgents(files: string[]): Promise<{
  agents: FreebuffAgent[]
  skipped: Array<{ file: string; reason: string }>
}> {
  const agents: FreebuffAgent[] = []
  const skipped: Array<{ file: string; reason: string }> = []
  const seen = new Set<string>()

  for (const file of files) {
    const displayPath = relative(REPO_ROOT, file)
    let mod: unknown
    try {
      mod = await import(pathToFileURL(file).href)
    } catch (error) {
      skipped.push({
        file: displayPath,
        reason: `import failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }

    const candidate = (mod as { default?: unknown }).default
    if (!candidate || typeof candidate !== 'object') {
      skipped.push({ file: displayPath, reason: 'no default export' })
      continue
    }

    const agent = candidate as FreebuffAgent
    if (typeof agent.id !== 'string' || agent.id.length === 0) {
      skipped.push({ file: displayPath, reason: 'default export has no id' })
      continue
    }
    if (seen.has(agent.id)) {
      skipped.push({ file: displayPath, reason: `duplicate id "${agent.id}"` })
      continue
    }

    seen.add(agent.id)
    agents.push(agent)
  }

  return { agents, skipped }
}

async function main() {
  const { out, dryRun } = parseArgs(process.argv.slice(2))

  const files = await listAgentFiles(AGENTS_DIR)
  const { agents, skipped } = await loadAgents(files)

  // An agent referenced in another agent's `spawnableAgents` is a subagent;
  // everything else is a primary agent. Agents used both ways get `all`.
  const spawnedIds = new Set<string>()
  for (const agent of agents) {
    for (const id of agent.spawnableAgents ?? []) {
      spawnedIds.add(simpleId(id))
    }
  }
  const ids = new Set(agents.map((agent) => agent.id))
  const isSpawned = (agent: FreebuffAgent) => spawnedIds.has(simpleId(agent.id))

  const usedNames = new Set<string>()
  let written = 0
  const modes: Record<string, number> = { primary: 0, subagent: 0, all: 0 }
  const names: string[] = []

  for (const agent of agents) {
    let name = sanitizeName(simpleId(agent.id)) || 'agent'
    if (usedNames.has(name)) {
      let suffix = 2
      while (usedNames.has(`${name}-${suffix}`)) suffix++
      name = `${name}-${suffix}`
    }
    usedNames.add(name)
    names.push(agent.id)

    const spawned = isSpawned(agent)
    const spawnsOthers = (agent.spawnableAgents ?? []).length > 0
    const mode: 'primary' | 'subagent' | 'all' =
      spawned && spawnsOthers ? 'all' : spawned ? 'subagent' : 'primary'
    modes[mode]++

    const markdown = toMarkdown(agent, {
      mode,
      allowsSubagents: spawnsOthers,
    })

    if (!dryRun) {
      mkdirSync(out, { recursive: true })
      writeFileSync(join(out, `${name}.md`), markdown, 'utf8')
    }
    written++
  }

  const defaultAgent =
    ids.has('base2') ? 'base2' : (agents.find((agent) => !isSpawned(agent))?.id ?? null)

  if (!dryRun && defaultAgent) {
    const configPath = join(REPO_ROOT, '.opencode', 'opencode.jsonc')
    if (!existsSync(configPath)) {
      mkdirSync(join(REPO_ROOT, '.opencode'), { recursive: true })
      writeFileSync(
        configPath,
        `${[
          '{',
          '  "$schema": "https://opencode.ai/config.json",',
          `  "default_agent": ${JSON.stringify(sanitizeName(simpleId(defaultAgent)))}`,
          '}',
          '',
        ].join('\n')}`,
        'utf8',
      )
    }
  }

  console.log(
    `${dryRun ? 'Would write' : 'Wrote'} ${written} opencode agents to ${relative(REPO_ROOT, out) || out}`,
  )
  console.log(
    `Modes: ${modes.primary} primary, ${modes.subagent} subagent, ${modes.all} all`,
  )
  if (defaultAgent) console.log(`Default agent: ${defaultAgent}`)
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} file(s):`)
    for (const entry of skipped) {
      console.log(`  - ${entry.file}: ${entry.reason}`)
    }
  }
  if (names.length !== new Set(names).size) {
    console.warn('Warning: duplicate agent ids were exported')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
