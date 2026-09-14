import { describe, expect, test } from 'bun:test'

import {
  estimateTokens,
  matchesSkillQuery,
  renderTokens,
} from '../skills-panel-format'

import type { SkillDefinition } from '@codebuff/common/types/skill'

const skill = (overrides: Partial<SkillDefinition> = {}): SkillDefinition => ({
  name: 'release-notes',
  description: 'Draft release notes from recent commits',
  content: 'x'.repeat(400),
  filePath: '/project/.agents/skills/release-notes/SKILL.md',
  ...overrides,
})

describe('estimateTokens', () => {
  test('scales with content length at ~4 chars per token', () => {
    // Both cases pass an empty description so content dominates the math.
    expect(
      estimateTokens(skill({ content: 'x'.repeat(400), description: '' })),
    ).toBe(100)
    expect(
      estimateTokens(skill({ content: 'x'.repeat(4000), description: '' })),
    ).toBe(1000)
  })

  test('counts the description and never returns zero', () => {
    // 12 chars of description + empty content still rounds to 3.
    expect(estimateTokens(skill({ content: '', description: '123456789012' }))).toBe(
      3,
    )
    expect(estimateTokens(skill({ content: '', description: '' }))).toBe(1)
  })
})

describe('renderTokens', () => {
  test('plain numbers below 1000, k notation above', () => {
    expect(renderTokens(70)).toBe('70 tok')
    expect(renderTokens(999)).toBe('999 tok')
    expect(renderTokens(1000)).toBe('1k tok')
    expect(renderTokens(2800)).toBe('2.8k tok')
  })
})

describe('matchesSkillQuery', () => {
  const ponytail = skill({
    name: 'ponytail',
    description: 'Forces the laziest solution that actually works',
  })

  test('empty or whitespace queries match everything', () => {
    expect(matchesSkillQuery(ponytail, '')).toBe(true)
    expect(matchesSkillQuery(ponytail, '   ')).toBe(true)
  })

  test('matches by name or description, case-insensitively', () => {
    expect(matchesSkillQuery(ponytail, 'pony')).toBe(true)
    expect(matchesSkillQuery(ponytail, 'PONY')).toBe(true)
    expect(matchesSkillQuery(ponytail, 'laziest')).toBe(true)
    expect(matchesSkillQuery(ponytail, 'git-helper')).toBe(false)
  })

  test('trims the query before matching', () => {
    expect(matchesSkillQuery(ponytail, '  pony  ')).toBe(true)
    expect(matchesSkillQuery(ponytail, '  zzz  ')).toBe(false)
  })
})
