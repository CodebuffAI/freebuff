import { describe, expect, test } from 'bun:test'

import { formatAvailableSkillsXml } from './skills'

import type { SkillsMap } from '../types/skill'

describe('formatAvailableSkillsXml', () => {
  test('omits skills that only the user may invoke', () => {
    const skills: SkillsMap = {
      deploy: {
        name: 'deploy',
        description: 'Deploy the application',
        content: 'deployment instructions',
        disableModelInvocation: true,
        filePath: '/skills/deploy/SKILL.md',
      },
      review: {
        name: 'review',
        description: 'Review code changes',
        content: 'review instructions',
        filePath: '/skills/review/SKILL.md',
      },
    }

    const xml = formatAvailableSkillsXml(skills)

    expect(xml).toContain('<name>review</name>')
    expect(xml).not.toContain('deploy')
  })

  test('keeps model-only skills in the model listing (user-invocable: false)', () => {
    const skills: SkillsMap = {
      legacy: {
        name: 'legacy',
        description: 'How the legacy system works',
        content: 'legacy system context',
        userInvocable: false,
        filePath: '/skills/legacy/SKILL.md',
      },
    }

    // Model-only means "hidden from the user", not "hidden from the model" —
    // and this listing IS the model's, so the skill appears here.
    const xml = formatAvailableSkillsXml(skills)
    expect(xml).toContain('<name>legacy</name>')
  })

  test('appends when_to_use as trigger context', () => {
    const skills: SkillsMap = {
      deploy: {
        name: 'deploy',
        description: 'Deploy the application',
        content: 'deployment instructions',
        whenToUse: 'When the user asks to ship or release',
        filePath: '/skills/deploy/SKILL.md',
      },
    }

    const xml = formatAvailableSkillsXml(skills)
    expect(xml).toContain(
      '<when_to_use>When the user asks to ship or release</when_to_use>',
    )
  })

  test('returns an empty listing when every skill is user-only', () => {
    const skills: SkillsMap = {
      deploy: {
        name: 'deploy',
        description: 'Deploy the application',
        content: 'deployment instructions',
        disableModelInvocation: true,
        filePath: '/skills/deploy/SKILL.md',
      },
    }

    expect(formatAvailableSkillsXml(skills)).toBe('')
  })
})
