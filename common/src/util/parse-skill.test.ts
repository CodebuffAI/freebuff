import { describe, expect, test } from 'bun:test'

import { parseSkillFileContent } from './parse-skill'

describe('parseSkillFileContent', () => {
  const baseOptions = {
    directoryName: 'deploy',
    filePath: '/skills/deploy/SKILL.md',
  }

  test('parses name, description, and license', () => {
    const skill = parseSkillFileContent(
      [
        '---',
        'name: deploy',
        'description: Deploy the application',
        'license: MIT',
        '---',
        'Run the deploy script.',
      ].join('\n'),
      baseOptions,
    )

    expect(skill).toMatchObject({
      name: 'deploy',
      description: 'Deploy the application',
      license: 'MIT',
      filePath: '/skills/deploy/SKILL.md',
    })
    expect(skill?.content).toContain('Run the deploy script.')
  })

  test('accepts Claude Code frontmatter fields', () => {
    const skill = parseSkillFileContent(
      [
        '---',
        'name: deploy',
        'description: Deploy the application',
        'user-invocable: false',
        // Claude Code's docs write this unquoted: YAML parses it as a flow
        // sequence, which we join back to the display string — brackets are
        // lost to YAML either way, in Claude Code just as here.
        'argument-hint: [environment]',
        'when_to_use: When the user asks to ship or release',
        'disable-model-invocation: true',
        '---',
        'Deploy steps.',
      ].join('\n'),
      baseOptions,
    )

    expect(skill).not.toBeNull()
    expect(skill?.userInvocable).toBe(false)
    expect(skill?.argumentHint).toBe('environment')
    expect(skill?.whenToUse).toBe(
      'When the user asks to ship or release',
    )
    expect(skill?.disableModelInvocation).toBe(true)
  })

  test('rejects a name that does not match the directory', () => {
    const skill = parseSkillFileContent(
      '---\nname: other\ndescription: Mismatched\n---\nbody',
      baseOptions,
    )

    expect(skill).toBeNull()
  })

  test('returns null when there is no frontmatter', () => {
    expect(parseSkillFileContent('Just some instructions.', baseOptions)).toBe(
      null,
    )
  })

  test('returns null when frontmatter is invalid per the schema', () => {
    // uppercase name violates SKILL_NAME_REGEX
    const skill = parseSkillFileContent(
      '---\nname: Deploy\ndescription: Bad name casing\n---\nbody',
      baseOptions,
    )

    expect(skill).toBeNull()
  })
})
