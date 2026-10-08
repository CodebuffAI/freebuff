import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_FILE_NAME,
  SKILL_NAME_MAX_LENGTH,
} from '@codebuff/common/constants/skills'

import {
  loadSkills,
  parseSkillFileContent,
  resolveSkillsDirs,
} from '../skills/load-skills'

const writeSkill = ({
  skillsRoot,
  skillDirName,
  frontmatterName = skillDirName,
  description = `Description for ${skillDirName}`,
  body = `# ${skillDirName}\n`,
}: {
  skillsRoot: string
  skillDirName: string
  frontmatterName?: string
  description?: string
  body?: string
}): string => {
  const skillDir = path.join(skillsRoot, skillDirName)
  const skillFile = path.join(skillDir, SKILL_FILE_NAME)

  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    skillFile,
    [
      '---',
      `name: ${frontmatterName}`,
      `description: ${description}`,
      '---',
      '',
      body,
    ].join('\n'),
    'utf8',
  )

  return skillFile
}

describe('loadSkills', () => {
  let tempRoot: string
  let homeDir: string
  let projectDir: string

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'codebuff-sdk-load-skills-'))
    homeDir = path.join(tempRoot, 'home')
    projectDir = path.join(tempRoot, 'project')

    mkdirSync(homeDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })

    spyOn(os, 'homedir').mockReturnValue(homeDir)
  })

  afterEach(() => {
    mock.restore()
    rmSync(tempRoot, { recursive: true, force: true })
  })

  /** Writes one skill into each of the four possible roots. */
  const writeSkillInEveryRoot = () => {
    writeSkill({
      skillsRoot: path.join(homeDir, '.claude', 'skills'),
      skillDirName: 'global-claude-skill',
    })
    writeSkill({
      skillsRoot: path.join(homeDir, '.agents', 'skills'),
      skillDirName: 'global-agents-skill',
    })
    writeSkill({
      skillsRoot: path.join(projectDir, '.claude', 'skills'),
      skillDirName: 'project-claude-skill',
    })
    writeSkill({
      skillsRoot: path.join(projectDir, '.agents', 'skills'),
      skillDirName: 'project-agents-skill',
    })
  }

  test('discovers project skills, and by default ONLY project skills', async () => {
    writeSkillInEveryRoot()

    const skills = await loadSkills({ cwd: projectDir })

    // The home roots are deliberately absent. A host that embeds this SDK in a
    // server process would otherwise be served that SERVER's home directory —
    // see LoadSkillsOptions.includeHomeSkills.
    expect(Object.keys(skills).sort()).toEqual([
      'project-agents-skill',
      'project-claude-skill',
    ])
    expect(skills['project-agents-skill']?.description).toBe(
      'Description for project-agents-skill',
    )
  })

  test('discovers skills from all four roots when home skills are opted in', async () => {
    writeSkillInEveryRoot()

    const skills = await loadSkills({
      cwd: projectDir,
      includeHomeSkills: true,
    })

    expect(Object.keys(skills).sort()).toEqual([
      'global-agents-skill',
      'global-claude-skill',
      'project-agents-skill',
      'project-claude-skill',
    ])
    expect(skills['global-claude-skill']?.filePath).toBe(
      path.join(homeDir, '.claude', 'skills', 'global-claude-skill', 'SKILL.md'),
    )
  })

  test('loads skills from an explicit skillsPath only', async () => {
    const explicitSkillsDir = path.join(tempRoot, 'custom-skills')

    writeSkill({
      skillsRoot: explicitSkillsDir,
      skillDirName: 'custom-skill',
      description: 'Loaded from explicit skillsPath',
    })
    writeSkill({
      skillsRoot: path.join(projectDir, '.agents', 'skills'),
      skillDirName: 'project-skill',
      description: 'Should be ignored when skillsPath is set',
    })

    const skills = await loadSkills({
      cwd: projectDir,
      skillsPath: explicitSkillsDir,
    })

    expect(Object.keys(skills)).toEqual(['custom-skill'])
    expect(skills['custom-skill']?.description).toBe(
      'Loaded from explicit skillsPath',
    )
  })

  test('applies override precedence as project over global and .agents over .claude', async () => {
    writeSkill({
      skillsRoot: path.join(homeDir, '.claude', 'skills'),
      skillDirName: 'shared-skill',
      description: 'global claude',
    })
    writeSkill({
      skillsRoot: path.join(homeDir, '.agents', 'skills'),
      skillDirName: 'shared-skill',
      description: 'global agents',
    })
    writeSkill({
      skillsRoot: path.join(projectDir, '.claude', 'skills'),
      skillDirName: 'shared-skill',
      description: 'project claude',
    })
    writeSkill({
      skillsRoot: path.join(projectDir, '.agents', 'skills'),
      skillDirName: 'shared-skill',
      description: 'project agents',
    })

    const skills = await loadSkills({ cwd: projectDir, includeHomeSkills: true })

    expect(skills['shared-skill']?.description).toBe('project agents')
    expect(skills['shared-skill']?.filePath).toBe(
      path.join(projectDir, '.agents', 'skills', 'shared-skill', 'SKILL.md'),
    )
  })

  test('prefers project .claude skills over global .agents skills', async () => {
    writeSkill({
      skillsRoot: path.join(homeDir, '.agents', 'skills'),
      skillDirName: 'priority-skill',
      description: 'global agents',
    })
    writeSkill({
      skillsRoot: path.join(projectDir, '.claude', 'skills'),
      skillDirName: 'priority-skill',
      description: 'project claude',
    })

    const skills = await loadSkills({ cwd: projectDir, includeHomeSkills: true })

    expect(skills['priority-skill']?.description).toBe('project claude')
  })

  test('skips invalid skill directories and malformed skill definitions', async () => {
    const skillsRoot = path.join(projectDir, '.agents', 'skills')
    const consoleError = spyOn(console, 'error').mockImplementation(() => { })
    const consoleWarn = spyOn(console, 'warn').mockImplementation(() => { })

    mkdirSync(path.join(skillsRoot, 'missing-skill-file'), { recursive: true })

    const malformedDir = path.join(skillsRoot, 'malformed-frontmatter')
    mkdirSync(malformedDir, { recursive: true })
    writeFileSync(
      path.join(malformedDir, 'SKILL.md'),
      ['---', '{invalid yaml: [unclosed', '---'].join('\n'),
      'utf8',
    )

    writeSkill({
      skillsRoot,
      skillDirName: 'mismatch-dir',
      frontmatterName: 'different-name',
      description: 'Mismatched name',
    })

    const tooLongName = 'a'.repeat(SKILL_NAME_MAX_LENGTH + 1)
    writeSkill({
      skillsRoot,
      skillDirName: tooLongName,
      description: 'Too long',
    })

    writeSkill({
      skillsRoot,
      skillDirName: 'Uppercase-Skill',
      description: 'Uppercase invalid',
    })
    writeSkill({
      skillsRoot,
      skillDirName: 'special_skill',
      description: 'Special char invalid',
    })
    writeSkill({
      skillsRoot,
      skillDirName: 'valid-skill',
      description: 'Valid skill',
    })

    const skills = await loadSkills({ cwd: projectDir, verbose: true })

    expect(Object.keys(skills)).toEqual(['valid-skill'])
    expect(skills['valid-skill']?.description).toBe('Valid skill')

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Invalid frontmatter in skill file'),
    )
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "Skill name 'different-name' does not match directory name 'mismatch-dir'",
      ),
    )
    expect(consoleWarn).toHaveBeenCalledWith(
      `Skipping invalid skill directory name: ${tooLongName}`,
    )
    expect(consoleWarn).toHaveBeenCalledWith(
      'Skipping invalid skill directory name: Uppercase-Skill',
    )
    expect(consoleWarn).toHaveBeenCalledWith(
      'Skipping invalid skill directory name: special_skill',
    )
  })

  test('loads skills from skillsPath and bypasses default search roots', async () => {
    const customSkillsDir = path.join(tempRoot, 'custom-skills')
    mkdirSync(customSkillsDir, { recursive: true })

    // Put a skill in a default root that should NOT be found
    writeSkill({
      skillsRoot: path.join(projectDir, '.agents', 'skills'),
      skillDirName: 'default-skill',
      description: 'Should not be found',
    })

    // Put a skill in the custom directory that SHOULD be found
    writeSkill({
      skillsRoot: customSkillsDir,
      skillDirName: 'custom-skill',
      description: 'Found via skillsPath',
    })

    const skills = await loadSkills({
      cwd: projectDir,
      skillsPath: customSkillsDir,
    })

    expect(Object.keys(skills).sort()).toEqual(['custom-skill'])
    expect(skills['custom-skill']?.description).toBe('Found via skillsPath')
    expect(skills['custom-skill']?.filePath).toBe(
      path.join(customSkillsDir, 'custom-skill', 'SKILL.md'),
    )
  })
})

describe('parseSkillFileContent', () => {
  // gray-matter treats text after the opening `---` as the frontmatter
  // language and eval()s `---js` blocks. Skill files come from repos and
  // registries, and this parser runs on our servers.
  test.each(['---js', '---javascript', '---JS', '--- js', '---coffee'])(
    'never runs a %s frontmatter block',
    (opener) => {
      const marker = `__skillEval_${opener.replace(/\W/g, '')}`
      const content = [
        opener,
        `globalThis.${marker} = true; ({ name: 'deploy', description: 'x' })`,
        '---',
        '',
        '# Deploy',
      ].join('\n')

      expect(
        parseSkillFileContent(content, {
          directoryName: 'deploy',
          filePath: '/skills/deploy/SKILL.md',
        }),
      ).toBeNull()
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined()
    },
  )

  test('still reads a plain opener with a byte-order mark or trailing spaces', () => {
    for (const opener of ['\uFEFF---', '---  ', '---\r']) {
      const content = `${opener}\nname: deploy\ndescription: Deploy safely\n---\n\n# Deploy`
      expect(
        parseSkillFileContent(content, {
          directoryName: 'deploy',
          filePath: '/skills/deploy/SKILL.md',
        }),
      ).toMatchObject({ name: 'deploy' })
    }
  })

  test('validates in-memory edits with the same rules as disk discovery', () => {
    const valid = [
      '---',
      'name: deploy',
      'description: Deploy safely',
      '---',
      '',
      '# Deploy',
    ].join('\n')
    expect(
      parseSkillFileContent(valid, {
        directoryName: 'deploy',
        filePath: '/skills/deploy/SKILL.md',
      }),
    ).toMatchObject({ name: 'deploy', description: 'Deploy safely', content: valid })
    expect(
      parseSkillFileContent(valid.replace('name: deploy', 'name: release'), {
        directoryName: 'deploy',
        filePath: '/skills/deploy/SKILL.md',
      }),
    ).toBeNull()
  })

  test('preserves the user-only invocation setting', () => {
    const content = [
      '---',
      'name: deploy',
      'description: Deploy safely',
      'disable-model-invocation: true',
      '---',
      '',
      '# Deploy',
    ].join('\n')

    expect(
      parseSkillFileContent(content, {
        directoryName: 'deploy',
        filePath: '/skills/deploy/SKILL.md',
      }),
    ).toMatchObject({ disableModelInvocation: true })
  })

  // registries nest their own bookkeeping under `metadata` (skills.sh stamps a
  // `hermes:` block onto every skill it serves); rejecting those made popular
  // skills impossible to install AND invisible when placed on disk by hand
  test('accepts nested metadata a publisher or registry added', () => {
    const content = [
      '---',
      'name: i-have-adhd',
      'description: Shape output for a reader with ADHD',
      'metadata:',
      '  hermes:',
      '    tags: [ADHD, Productivity]',
      '    category: productivity',
      '  freebuff-builtin: review',
      '---',
      '',
      '# i-have-adhd',
    ].join('\n')

    const parsed = parseSkillFileContent(content, {
      directoryName: 'i-have-adhd',
      filePath: '/skills/i-have-adhd/SKILL.md',
    })

    expect(parsed).toMatchObject({ name: 'i-have-adhd' })
    // flat entries stay readable — that is how a Freebuff-authored skill is tagged
    expect(parsed?.metadata?.['freebuff-builtin']).toBe('review')
    expect(parsed?.metadata?.hermes).toMatchObject({ category: 'productivity' })
  })

  test('clamps an over-long description instead of rejecting the skill', () => {
    const description = 'x'.repeat(SKILL_DESCRIPTION_MAX_LENGTH + 44)
    const content = [
      '---',
      'name: claude-api',
      `description: ${description}`,
      '---',
      '',
      '# claude-api',
    ].join('\n')

    const parsed = parseSkillFileContent(content, {
      directoryName: 'claude-api',
      filePath: '/skills/claude-api/SKILL.md',
    })

    expect(parsed?.description).toHaveLength(SKILL_DESCRIPTION_MAX_LENGTH)
    // the body is untouched; only the discovery blurb is shortened
    expect(parsed?.content).toBe(content)
  })
})

/**
 * Guards the home-directory boundary itself.
 *
 * The bug these exist for is invisible from the outside: skills load fine, they
 * are just the WRONG MACHINE's. Freebuff Cloud embeds this runner in the
 * freebuff/web server process while the repo lives in a Daytona sandbox, so an
 * always-on `os.homedir()` search meant every Cloud turn parsed the web
 * server's `~/.claude/skills` and offered it to the model. Nothing downstream
 * can tell that apart from working correctly, so it has to be caught here.
 *
 * These assert on the RESOLVED SEARCH PATHS rather than on load results, so
 * they fail even if the home directory happens to be empty on the machine
 * running the suite.
 */
describe('home-directory boundary', () => {
  const SANDBOX_CWD = '/home/daytona/codebase'

  test('the default search never leaves the project', () => {
    const dirs = resolveSkillsDirs({ cwd: SANDBOX_CWD })

    expect(dirs).toEqual([
      path.join(SANDBOX_CWD, '.claude', 'skills'),
      path.join(SANDBOX_CWD, '.agents', 'skills'),
    ])
    expect(dirs.every((dir) => dir.startsWith(SANDBOX_CWD))).toBe(true)
  })

  test('a home directory is searched only when one is supplied', () => {
    const withHome = resolveSkillsDirs({
      cwd: SANDBOX_CWD,
      homeDir: '/home/webserver',
    })

    // Home roots come first: lower precedence than the project's.
    expect(withHome).toEqual([
      path.join('/home/webserver', '.claude', 'skills'),
      path.join('/home/webserver', '.agents', 'skills'),
      path.join(SANDBOX_CWD, '.claude', 'skills'),
      path.join(SANDBOX_CWD, '.agents', 'skills'),
    ])
  })

  test('an explicit skillsPath is the whole search, home or not', () => {
    expect(
      resolveSkillsDirs({
        cwd: SANDBOX_CWD,
        skillsPath: '/explicit/skills',
        homeDir: '/home/webserver',
      }),
    ).toEqual(['/explicit/skills'])
  })

  test('a server-embedded run cannot reach the home directory', async () => {
    // A real home containing a real, valid skill, reached the way the runtime
    // reaches it — so this fails loudly if the fallback ever returns.
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'skills-home-guard-'))
    const fakeHome = path.join(tempRoot, 'home')
    const sandboxCwd = path.join(tempRoot, 'not-the-repo')
    mkdirSync(fakeHome, { recursive: true })
    mkdirSync(sandboxCwd, { recursive: true })
    writeSkill({
      skillsRoot: path.join(fakeHome, '.claude', 'skills'),
      skillDirName: 'server-side-skill',
    })

    const homedirSpy = spyOn(os, 'homedir').mockReturnValue(fakeHome)
    try {
      // What a server-embedded runner does: a cwd that is not its own repo,
      // and no statement that this process belongs to any user.
      expect(await loadSkills({ cwd: sandboxCwd })).toEqual({})

      // The same call from a process that IS the user's finds it — without
      // this the assertion above could pass for the wrong reason (a bad seed).
      expect(
        Object.keys(
          await loadSkills({ cwd: sandboxCwd, includeHomeSkills: true }),
        ),
      ).toEqual(['server-side-skill'])
    } finally {
      homedirSpy.mockRestore()
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
