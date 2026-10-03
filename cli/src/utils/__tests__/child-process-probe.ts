import { setProjectRoot } from '../../project-files'
import { initializeSkillRegistry } from '../skill-registry'
import { initializeAgentRegistry } from '../local-agent-registry'

/**
 * The child-process probe for the discovery tests: the test harness
 * spawns this file as its own bun process, so the CLI's real startup
 * sequence — the same `initializeSkillRegistry()` /
 * `initializeAgentRegistry()` calls `index.tsx` makes before rendering —
 * runs with the registries' module-level caches empty in that process.
 * Prints one JSON line: the skill names and MCP servers those caches
 * hold there.
 */

const projectDir = process.argv[2]
if (!projectDir) {
  console.error('usage: bun child-process-probe.ts <projectDir>')
  process.exit(1)
}
setProjectRoot(projectDir)

await initializeSkillRegistry()
await initializeAgentRegistry()

const { getLoadedSkills } = await import('../skill-registry')
const { getLoadedMCPServers } = await import('../local-agent-registry')

const report = {
  skills: Object.keys(getLoadedSkills()).sort(),
  servers: Object.fromEntries(
    Object.entries(getLoadedMCPServers()).map(([name, config]) => [
      name,
      'url' in config
        ? `${config.type} ${config.url}`
        : `${config.type} ${config.command}`,
    ]),
  ),
}

console.log(JSON.stringify(report))
