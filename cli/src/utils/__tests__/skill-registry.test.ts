import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { setProjectRoot } from '../../project-files'
import {
  __resetSkillRegistryForTests,
  getLoadedSkills,
  getSkillsVersion,
  initializeSkillRegistry,
  refreshSkillRegistry,
  startSkillDirWatcher,
  subscribeToSkillsVersion,
} from '../skill-registry'

let tmpRoot: string
let oldHome: string | undefined
let oldUserProfile: string | undefined

const writeSkill = (
  kind: 'project' | 'global',
  dirName: string,
  frontmatter: Record<string, string>,
) => {
  const base =
    kind === 'project' ? path.join(tmpRoot, '.agents', 'skills') : path.join(os.homedir(), '.claude', 'skills')
  const skillDir = path.join(base, dirName)
  fs.mkdirSync(skillDir, { recursive: true })
  const lines = Object.entries(frontmatter).map(
    ([key, value]) => `${key}: ${value}`,
  )
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\n${lines.join('\n')}\n---\nBody of ${dirName}.\n`,
  )
  return skillDir
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-registry-'))
  setProjectRoot(tmpRoot)
  // Hermetic home: includeHomeSkills makes the SDK load real ~/.claude/skills
  // too, so on a machine with skills installed for Claude Code (any
  // maintainer's, in practice) the counts below would include those. Redirect
  // the home directory so tests only see what they write themselves.
  oldHome = process.env.HOME
  oldUserProfile = process.env.USERPROFILE
  process.env.HOME = tmpRoot
  process.env.USERPROFILE = tmpRoot
})

afterEach(() => {
  __resetSkillRegistryForTests()
  if (oldHome !== undefined) process.env.HOME = oldHome
  else delete process.env.HOME
  if (oldUserProfile !== undefined) process.env.USERPROFILE = oldUserProfile
  else delete process.env.USERPROFILE
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('skill-registry refresh', () => {
  test('initializeSkillRegistry loads project skills', async () => {
    writeSkill('project', 'deploy', {
      name: 'deploy',
      description: 'Deploy the app',
    })

    await initializeSkillRegistry()

    expect(getLoadedSkills()['deploy']).toMatchObject({
      name: 'deploy',
      description: 'Deploy the app',
    })
  })

  test('refreshSkillRegistry detects new, edited, and deleted skills', async () => {
    const skillDir = writeSkill('project', 'deploy', {
      name: 'deploy',
      description: 'Deploy the app',
    })
    await initializeSkillRegistry()
    expect(getSkillCountForTest()).toBe(1)

    // New skill appears.
    writeSkill('project', 'review', {
      name: 'review',
      description: 'Review changes',
    })
    await expect(refreshSkillRegistry()).resolves.toBe(true)
    expect(getSkillCountForTest()).toBe(2)

    // Content edit is detected (same name, new description).
    writeSkill('project', 'deploy', {
      name: 'deploy',
      description: 'Deploy the app to production',
    })
    await expect(refreshSkillRegistry()).resolves.toBe(true)
    expect(getLoadedSkills()['deploy'].description).toBe(
      'Deploy the app to production',
    )

    // Deleting the whole directory removes the skill.
    fs.rmSync(skillDir, { recursive: true })
    await expect(refreshSkillRegistry()).resolves.toBe(true)
    expect(getSkillCountForTest()).toBe(1)
    expect(getLoadedSkills()['deploy']).toBeUndefined()

    // Nothing changed: no new version.
    const before = getSkillsVersion()
    await expect(refreshSkillRegistry()).resolves.toBe(false)
    expect(getSkillsVersion()).toBe(before)
  })

  test('version subscribers are notified on change', async () => {
    writeSkill('project', 'deploy', {
      name: 'deploy',
      description: 'Deploy the app',
    })
    await initializeSkillRegistry()

    const onChange = mock(() => {})
    const unsubscribe = subscribeToSkillsVersion(onChange)
    const before = getSkillsVersion()

    writeSkill('project', 'review', {
      name: 'review',
      description: 'Review changes',
    })
    await refreshSkillRegistry()

    expect(getSkillsVersion()).toBe(before + 1)
    expect(onChange).toHaveBeenCalled()

    unsubscribe()
    await refreshSkillRegistry()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  test('watcher picks up an install without restart', async () => {
    // The skills directory must exist BEFORE the watcher arms on it — fs.watch
    // cannot watch a directory that does not exist. (A directory created and
    // populated later is caught by the refresh-on-panel-open instead.)
    fs.mkdirSync(path.join(tmpRoot, '.agents', 'skills'), { recursive: true })
    startSkillDirWatcher()

    await initializeSkillRegistry()
    expect(getSkillCountForTest()).toBe(0)

    writeSkill('project', 'deploy', {
      name: 'deploy',
      description: 'Deploy the app',
    })

    // Watcher debounce is 300ms; give it room on slow CI.
    await wait(900)

    expect(getSkillsVersion()).toBeGreaterThan(0)
    expect(getLoadedSkills()['deploy']).toBeDefined()
  })
})

function getSkillCountForTest(): number {
  return Object.keys(getLoadedSkills()).length
}
