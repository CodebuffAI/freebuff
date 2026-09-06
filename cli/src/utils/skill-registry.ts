import os from 'os'

import { loadSkills as sdkLoadSkills } from '@codebuff/sdk'

import { getProjectRoot, tryGetProjectRoot } from '../project-files'
import { logger } from './logger'

import type { SkillDefinition, SkillsMap } from '@codebuff/common/types/skill'

// ============================================================================
// Skills cache (loaded via SDK at startup)
// ============================================================================

let skillsCache: SkillsMap = {}

/**
 * Bumped whenever a refresh changes the set of loaded skills. React surfaces
 * (the /skills panel, the slash-command merge) subscribe to this number
 * instead of to the mutable cache itself, which zustand would never see.
 */
let skillsVersion = 0

export function getSkillsVersion(): number {
  return skillsVersion
}

/**
 * Subscribe to registry version changes. Written for React's
 * `useSyncExternalStore`, which needs a stable function that returns an
 * unsubscribe.
 */
export function subscribeToSkillsVersion(onChange: () => void): () => void {
  versionSubscribers.add(onChange)
  return () => {
    versionSubscribers.delete(onChange)
  }
}

const versionSubscribers = new Set<() => void>()

/** The working directory skills should be resolved against. */
function skillsCwd(): string {
  return tryGetProjectRoot() || process.cwd()
}

/**
 * True when the two maps describe the same skill set: same names, same
 * invocability, same content. Metadata-only edits still count as a change so
 * the /skills panel shows fresh descriptions after the user edits SKILL.md.
 */
function skillsEqual(a: SkillsMap, b: SkillsMap): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => {
    const x = a[key]
    const y = b[key]
    if (!y) return false
    return (
      x.content === y.content &&
      x.disableModelInvocation === y.disableModelInvocation &&
      x.userInvocable === y.userInvocable &&
      x.description === y.description
    )
  })
}

/**
 * Re-load skills from disk and swap the cache only when something actually
 * changed. Every caller funnels through this function so there is exactly one
 * notion of "the skills changed" — the version bump — for the UI to key on.
 *
 * Returns true when the skill set changed.
 */
export async function refreshSkillRegistry(): Promise<boolean> {
  const cwd = skillsCwd()
  try {
    const fresh = await sdkLoadSkills({
      cwd,
      verbose: false,
      includeHomeSkills: true,
    })
    if (skillsEqual(fresh, skillsCache)) return false
    skillsCache = fresh
    skillsVersion += 1
    for (const notify of versionSubscribers) notify()
    return true
  } catch (error) {
    logger.warn({ error }, 'Failed to refresh skills')
    return false
  }
}

// ============================================================================
// Live reload
// ============================================================================
// Implemented on feat/skills-reload — deliberately not here. Watching skill
// directories is an independently reviewable feature (recursive watch
// semantics differ per platform) and lives in its own PR.

/**
 * Initialize the skill registry by loading skills via the SDK.
 * This must be called at CLI startup.
 * 
 * Skills are loaded from:
 * - ~/.agents/skills/ (global)
 * - {projectRoot}/.agents/skills/ (project, overrides global)
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
    .map((skill) => `  - ${skill.name}: ${skill.description.slice(0, 60)}${skill.description.length > 60 ? '...' : ''}`)
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
  skillsVersion = 0
}

/**
 * Seed the cache without touching the filesystem. Intended for test scenarios.
 * Bumps the version and notifies subscribers exactly like a real refresh, so
 * React surfaces keyed on the version see the seeded set.
 */
export function __setSkillsForTests(skills: SkillsMap): void {
  skillsCache = skills
  skillsVersion += 1
  for (const notify of versionSubscribers) notify()
}
