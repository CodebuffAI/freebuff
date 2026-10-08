import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { handleSkill } from '../skill'

import type { ProjectFileContext } from '@codebuff/common/util/file'

function writeSkill(
  projectRoot: string,
  name: string,
  description: string,
  options: {
    disableModelInvocation?: boolean
    source?: '.agents' | '.claude'
  } = {},
) {
  const skillDir = path.join(
    projectRoot,
    options.source ?? '.claude',
    'skills',
    name,
  )
  fs.mkdirSync(skillDir, { recursive: true })
  const disableModelInvocation = options.disableModelInvocation
    ? 'disable-model-invocation: true\n'
    : ''
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${disableModelInvocation}---\n# ${name}\nbody for ${description}\n`,
  )
}

function callSkill(name: string, fileContext: Partial<ProjectFileContext>) {
  return handleSkill({
    previousToolCallFinished: Promise.resolve(),
    toolCall: { toolName: 'skill', input: { name } } as any,
    fileContext: fileContext as ProjectFileContext,
  })
}

describe('handleSkill', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'))
  })

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })

  it('loads a skill installed during the session from disk', async () => {
    writeSkill(projectRoot, 'demo', 'installed at runtime')

    const { output } = await callSkill('demo', { projectRoot, skills: {} })
    const value = (output as any)[0].value

    expect(value.name).toBe('demo')
    expect(value.description).toBe('installed at runtime')
    expect(value.content).toContain('body for installed at runtime')
  })

  it('never evaluates a JavaScript frontmatter block found on disk', async () => {
    const skillDir = path.join(projectRoot, '.agents', 'skills', 'demo')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      "---js\nglobalThis.__skillHandlerEval = true; ({ name: 'demo', description: 'x' })\n---\n# demo\n",
    )

    const { output } = await callSkill('demo', { projectRoot, skills: {} })

    expect((globalThis as Record<string, unknown>).__skillHandlerEval).toBeUndefined()
    expect((output as any)[0].value.content).toContain("Skill 'demo' not found")
  })

  it('prefers the on-disk copy over a stale pre-loaded cache', async () => {
    writeSkill(projectRoot, 'demo', 'fresh on disk')

    const { output } = await callSkill('demo', {
      projectRoot,
      skills: {
        demo: {
          name: 'demo',
          description: 'stale cached',
          content: 'old cached body',
          filePath: '/nonexistent/SKILL.md',
        },
      },
    })
    const value = (output as any)[0].value

    expect(value.description).toBe('fresh on disk')
    expect(value.content).toContain('body for fresh on disk')
  })

  it('honors user-only policy from the highest-precedence project skill', async () => {
    writeSkill(projectRoot, 'demo', 'project claude')
    writeSkill(projectRoot, 'demo', 'project agents', {
      source: '.agents',
      disableModelInvocation: true,
    })

    const { output } = await callSkill('demo', { projectRoot, skills: {} })
    const value = (output as any)[0].value

    expect(value.content).toContain(
      "Skill 'demo' can only be invoked by the user",
    )
    expect(value.content).not.toContain('body for project claude')
  })

  it('falls back to the cache when the skill is not on disk', async () => {
    const { output } = await callSkill('demo', {
      projectRoot,
      skills: {
        demo: {
          name: 'demo',
          description: 'cache only',
          content: 'cached body',
          filePath: '/nonexistent/SKILL.md',
        },
      },
    })
    const value = (output as any)[0].value

    expect(value.description).toBe('cache only')
    expect(value.content).toBe('cached body')
  })

  it('returns a not-found error when the skill is missing everywhere', async () => {
    const { output } = await callSkill('missing', { projectRoot, skills: {} })
    const value = (output as any)[0].value

    expect(value.content).toContain("Skill 'missing' not found")
  })

  it('does not advertise user-only cached skills to the model', async () => {
    const { output } = await callSkill('missing', {
      projectRoot,
      skills: {
        deploy: {
          name: 'deploy',
          description: 'manual deploy',
          content: 'private deployment instructions',
          disableModelInvocation: true,
          filePath: '/nonexistent/SKILL.md',
        },
        review: {
          name: 'review',
          description: 'review changes',
          content: 'review instructions',
          filePath: '/nonexistent/SKILL.md',
        },
      },
    })
    const value = (output as any)[0].value

    expect(value.content).toContain('Available skills: review')
    expect(value.content).not.toContain('deploy')
  })
})

describe('handleSkill home-directory opt-in', () => {
  let projectRoot: string
  let fakeHome: string
  let realHomedir: typeof os.homedir

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-project-'))
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-home-'))
    realHomedir = os.homedir
    // Stand in for the HOST's home. On a server this is the server's own home
    // while `projectRoot` is someone else's checkout — on Freebuff Cloud, a
    // Daytona sandbox path.
    ;(os as any).homedir = () => fakeHome
  })

  afterEach(() => {
    ;(os as any).homedir = realHomedir
    fs.rmSync(projectRoot, { recursive: true, force: true })
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('does NOT read the host home by default', async () => {
    writeSkill(fakeHome, 'deploy', 'the HOST machine copy')

    const { output } = await callSkill('deploy', { projectRoot, skills: {} })
    const value = (output as any)[0].value

    // Not found at all: the project has no such skill and home is off-limits.
    expect(JSON.stringify(value)).not.toContain('the HOST machine copy')
  })

  it('reads the host home when a caller explicitly opts in', async () => {
    writeSkill(fakeHome, 'deploy', 'the HOST machine copy')

    const { output } = await callSkill('deploy', {
      projectRoot,
      skills: {},
      includeHomeSkills: true,
    })
    const value = (output as any)[0].value

    expect(value.name).toBe('deploy')
  })

  it('never lets a host-home skill shadow the repo, even when opted in', async () => {
    // The precedence that made this dangerous: the disk lookup wins over the
    // pre-loaded cache, so a same-named skill on the server would be served in
    // place of the repo's. Project must come first regardless.
    writeSkill(projectRoot, 'deploy', 'the REPO copy')
    writeSkill(fakeHome, 'deploy', 'the HOST machine copy')

    const { output } = await callSkill('deploy', {
      projectRoot,
      skills: {},
      includeHomeSkills: true,
    })

    expect(JSON.stringify((output as any)[0].value)).toContain('the REPO copy')
  })
})
