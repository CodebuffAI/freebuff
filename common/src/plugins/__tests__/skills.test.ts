import { afterEach, describe, expect, test } from 'bun:test'

// The real reader, imported by file so the barrel (and its tree-sitter wasm)
// stays out — the same care `parse-skill.ts` documents. Test-only: the
// production graph gains no common → sdk edge, because the walk takes the
// reader as a parameter; the session wiring passes the SDK's.
import { loadSkillsSync } from '../../../../sdk/src/skills/load-skills'

import { loadPluginSkills } from '../skills'

import {
  SKILL_NAME,
  OTHER_SKILL_NAME,
  expectSkillsComponentInvalid,
  expectSkillsOk,
  makeEscapingSkillRoot,
  makeEscapingSkillsRoot,
  makeRootWithoutSkills,
  makeRootWithSkill,
} from './fixtures/skills'

import { cleanUpPluginFixtures } from './fixtures/temp-roots'

/** The reader production will pass: exactly one skills directory, no roots. */
const readSkillsDir = (skillsDir: string) =>
  loadSkillsSync({ skillsPath: skillsDir })

afterEach(cleanUpPluginFixtures)

describe('skills component (spec §6.2, §7.1)', () => {
  /**
   * Given a plugin root with no `skills/` directory, when loaded, the skills
   * component contributes zero skills and no error — §6.2 forbids treating a
   * fixed location's absence as an error, and the containment predicate this
   * walk runs on the directory throws on a missing path, so the load must
   * survive it.
   */
  test('missing skills/ is not an error', () => {
    const root = makeRootWithoutSkills()

    const result = loadPluginSkills(root, readSkillsDir)

    const skills = expectSkillsOk(result)
    expect(skills).toEqual({})
  })

  /**
   * Given a plugin root whose `skills/` itself resolves outside the plugin
   * root, when loaded, the component type is invalid and other components
   * are unaffected — §4.1.1 boundary 2 via §6.2, and §4.1.1 compares
   * filesystem-resolved paths, not their spelling.
   */
  test('a skills/ resolving outside the root invalidates the component', () => {
    const root = makeEscapingSkillsRoot()

    const result = loadPluginSkills(root, readSkillsDir)

    const reports = expectSkillsComponentInvalid(result, '§4.1.1')
    expect(reports).toHaveLength(1)
    expect(reports[0]?.severity).toBe('error')
  })

  /**
   * Given a plugin root where one discovered `SKILL.md` resolves outside the
   * plugin root, when loaded, that skill is skipped and nothing else is —
   * §4.1.1 boundary 3 via §7.1, so the escape costs one skill, not the
   * component.
   */
  test('a SKILL.md resolving outside the root skips that skill only', () => {
    const root = makeEscapingSkillRoot()

    const result = loadPluginSkills(root, readSkillsDir)

    const skills = expectSkillsOk(result)
    expect(Object.keys(skills)).toEqual([SKILL_NAME])
    expect(skills[SKILL_NAME]?.name).toBe(SKILL_NAME)
    expect(result.reports).toHaveLength(1)
    expect(result.reports[0]?.section).toBe('§4.1.1')
  })

  /**
   * Given a plugin root whose `skills/` holds one valid skill, when loaded,
   * the reader's answer is carried and nothing is reported — the happy path
   * the component walk must not distort.
   */
  test('a valid skill loads through the reader', () => {
    const root = makeRootWithSkill(OTHER_SKILL_NAME)

    const result = loadPluginSkills(root, readSkillsDir)

    const skills = expectSkillsOk(result)
    expect(Object.keys(skills)).toEqual([OTHER_SKILL_NAME])
    expect(result.reports).toEqual([])
  })
})
