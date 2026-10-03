import path from 'node:path'

import { mkdirSync, writeFileSync } from 'node:fs'

import { expect } from 'bun:test'

import { SKILL_FILE_NAME, SKILLS_DIR_NAME } from '../../../constants/skills'

import { makeManifestRoot } from './manifest'
import { linkJunction, makeOutsideDir } from './temp-roots'

import type { LoadSkillsResult } from '../../skills'
import type { PluginReport } from '../../report'

/**
 * The skills-component fixtures: skill-directory builders and the
 * §4.1.1 escape arrangements specific to the skills walk. The shared
 * machinery lives in `temp-roots.ts`, the manifest fixtures in
 * `manifest.ts`, and the layering follows the production graph
 * (core ← manifest ← skills).
 */

/** A skill directory name the reader accepts. */
export const SKILL_NAME = 'gcloud'

/** A second skill directory name, so sibling rows can be asserted. */
export const OTHER_SKILL_NAME = 'finding-google-skills'

/**
 * A plugin root with a valid manifest and no `skills/` directory — the
 * absence §6.2 forbids treating as an error (a plugin may ship no skills).
 */
export function makeRootWithoutSkills(): string {
  return makeManifestRoot()
}

/**
 * A plugin root whose `skills/` holds one valid skill — a directory
 * named for the skill, containing a SKILL.md whose frontmatter name matches
 * the directory.
 */
export function makeRootWithSkill(skillName = SKILL_NAME): string {
  const root = makeManifestRoot()
  writeSkillDir(root, skillName)
  return root
}

/**
 * A plugin root whose `skills/` itself is a reparse point resolving to a
 * skills directory outside the plugin root — §4.1.1's second boundary, where
 * the fixed component location escapes.
 */
export function makeEscapingSkillsRoot(): string {
  const root = makeManifestRoot()
  const outside = makeOutsideDir(root)
  writeSkillDir(outside, SKILL_NAME)
  linkJunction(
    path.join(root, SKILLS_DIR_NAME),
    path.join(outside, SKILLS_DIR_NAME),
  )
  return root
}

/**
 * A plugin root where one skill resolves outside the plugin root — §4.1.1's
 * third boundary. Windows junctions cannot point at a file (probed: the
 * junction is created but every stat/read on it then throws ENOENT), so the
 * skill *directory* is the reparse point and the SKILL.md inside its target
 * is a real file — which is what makes the escape dangerous: the reader
 * would load that skill from outside the root without this walk. A sibling
 * valid skill is present, so a test can show the escape costs one skill,
 * not the component.
 */
export function makeEscapingSkillRoot(): string {
  const root = makeManifestRoot()
  writeSkillDir(root, SKILL_NAME)
  const outside = makeOutsideDir(root)
  writeSkillDir(outside, OTHER_SKILL_NAME)
  linkJunction(
    path.join(root, SKILLS_DIR_NAME, OTHER_SKILL_NAME),
    path.join(outside, SKILLS_DIR_NAME, OTHER_SKILL_NAME),
  )
  return root
}

/** The SKILL.md text for a skill named `skillName` that the reader accepts. */
function skillFileContent(skillName: string): string {
  return [
    '---',
    `name: ${skillName}`,
    'description: A skill fixture for the plugin loader tests.',
    '---',
    '',
    'Body of the fixture skill.',
  ].join('\n')
}

/**
 * Writes one skill directory under `<root>/skills` — the directory named for
 * the skill, holding a SKILL.md whose frontmatter name matches it.
 */
function writeSkillDir(root: string, skillName: string): void {
  const skillDir = path.join(root, SKILLS_DIR_NAME, skillName)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    path.join(skillDir, SKILL_FILE_NAME),
    skillFileContent(skillName),
    'utf8',
  )
}

/**
 * Asserts the skills load succeeded and returns the skill map, so tests
 * assert on skill values, never on the result's shape.
 */
export function expectSkillsOk(result: LoadSkillsResult) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
  return result.skills
}

/**
 * Asserts the skills component type was invalidated and returns the reports,
 * so a row that also asserts on them does not need its own narrowing branch.
 * `blame` must name the § the invalidation cites, so an invalidation for the
 * wrong cause still fails the test.
 */
export function expectSkillsComponentInvalid(
  result: LoadSkillsResult,
  blame: string,
): PluginReport[] {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error(`expected component invalid, got ok`)
  expect(result.reason).toContain(blame)
  return result.reports
}
