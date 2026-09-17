import { loadSkills as sdkLoadSkills } from '@codebuff/sdk'

import { getProjectRoot } from '../project-files'
import { pluginSkills } from './plugin-discovery'
import { logger } from './logger'

import type { SkillDefinition, SkillsMap } from '@codebuff/common/types/skill'

// ============================================================================
// Skills cache (loaded via SDK at startup)
// ============================================================================

let skillsCache: SkillsMap = {}

/**
 * Initialize the skill registry by loading skills via the SDK.
 * This must be called at CLI startup.
 *
 * Skills are loaded from:
 * - ~/.agents/skills/ (global)
 * - {projectRoot}/.agents/skills/ (project, overrides global)
 * - {pluginsRoot}/<plugin>/skills/ for every installed plugin (see
 *   ./plugin-discovery, which owns the plugin half of this merge)
 */
export async function initializeSkillRegistry(): Promise<void> {
  const cwd = getProjectRoot() || process.cwd()

  try {
    // Load skills from both global (~/.agents/skills) and project directories
    // The SDK handles merging, with project skills overriding global ones.
    //
    // includeHomeSkills is opt-in and defaults to false, because a server
    // embedding the SDK must never read a home directory (it would be the
    // SERVER's). The CLI is the case the flag exists for: it runs on the
    // user's own machine, so those really are their skills.
    skillsCache = await sdkLoadSkills({
      cwd,
      verbose: false,
      includeHomeSkills: true,
    })
  } catch (error) {
    logger.warn({ error }, 'Failed to load skills')
    skillsCache = {}
  }
  Object.assign(skillsCache, pluginSkills())
}

// ============================================================================
// Skills access
// ============================================================================

/**
 * Get all loaded skills.
 */
export function getLoadedSkills(): SkillsMap {
  return skillsCache
}

/**
 * Get a skill by name.
 */
export function getSkillByName(name: string): SkillDefinition | undefined {
  return skillsCache[name]
}

/**
 * Get the number of loaded skills.
 */
export function getSkillCount(): number {
  return Object.keys(skillsCache).length
}

// ============================================================================
// UI/Display utilities
// ============================================================================

/**
 * Get a message describing loaded skills for display.
 */
export function getLoadedSkillsMessage(): string | null {
  const skills = Object.values(skillsCache)

  if (skills.length === 0) {
    return null
  }

  const header = `Loaded ${skills.length} skill${skills.length === 1 ? '' : 's'}`
  const skillList = skills
    .map(
      (skill) =>
        `  - ${skill.name}: ${skill.description.slice(0, 60)}${skill.description.length > 60 ? '...' : ''}`,
    )
    .join('\n')

  return `${header}\n${skillList}`
}

// ============================================================================
// Testing utilities
// ============================================================================

/**
 * Clear cached skills. Intended for test scenarios.
 */
export function __resetSkillRegistryForTests(): void {
  skillsCache = {}
}

/**
 * Seed the cache without touching the filesystem. Intended for test scenarios.
 */
export function __setSkillsForTests(skills: SkillsMap): void {
  skillsCache = skills
}
