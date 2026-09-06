/**
 * Real-world compatibility check: the ponytail skills
 * (github.com/DietrichGebert/ponytail) are built for Claude Code / Codex /
 * Copilot and installed by the `skills` CLI into ~/.claude/skills. This test
 * runs them through Freebuff's actual SDK loader, which is the contract that
 * matters: a skill built for Claude Code must load in Freebuff without
 * modification.
 *
 * Skips locally when the skills are not installed, so CI stays green.
 */
import { describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { loadSkillsSync, resolveSkillsDirs } from '@codebuff/sdk'

const home = os.homedir()
const ponytailDir = path.join(home, '.claude', 'skills')
const installed = fs.existsSync(path.join(ponytailDir, 'ponytail', 'SKILL.md'))

describe.skipIf(!installed)('ponytail skills load through the real loader', () => {
  const PONYTAIL_SKILLS = [
    'ponytail',
    'ponytail-audit',
    'ponytail-debt',
    'ponytail-gain',
    'ponytail-help',
    'ponytail-review',
  ]

  const dirs = resolveSkillsDirs({ cwd: process.cwd(), homeDir: home })
  const skills = loadSkillsSync({ cwd: process.cwd(), includeHomeSkills: true })

  test('all six ponytail skills load with no skill rejected', () => {
    const loaded = PONYTAIL_SKILLS.filter((name) => skills[name])
    expect(loaded.length).toBe(PONYTAIL_SKILLS.length)
  })

  for (const name of PONYTAIL_SKILLS) {
    test(`ponytail skill '${name}' has name/description/content`, () => {
      const skill = skills[name]
      expect(skill).toBeDefined()
      expect(skill!.name).toBe(name)
      expect(skill!.description.length).toBeGreaterThan(0)
      expect(skill!.content.length).toBeGreaterThan(0)
      expect(skill!.filePath.startsWith(home)).toBe(true)
      expect(skill!.filePath.includes('.claude')).toBe(true)
    })
  }

  test('frontmatter carried the fields Claude Code writes', () => {
    const raw = fs.readFileSync(
      path.join(ponytailDir, 'ponytail', 'SKILL.md'),
      'utf8',
    )
    // The main ponytail skill targets the model with trigger phrases, which
    // in Claude Code land in `description` (and/or `when_to_use`); make sure
    // whatever is in the file survives parsing.
    const skillsMap = loadSkillsSync({
      cwd: process.cwd(),
      skillsPath: ponytailDir,
    })
    expect(skillsMap['ponytail'].description).toBeTruthy()
    expect(raw).toContain('name:')
    expect(raw).toContain('description:')
  })

  test('resolveSkillsDirs covers the claude global location', () => {
    expect(dirs).toContain(path.join(home, '.claude', 'skills'))
  })
})
