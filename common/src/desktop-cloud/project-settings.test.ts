import { expect, test } from 'bun:test'
import {
  cloudProjectSettingsSchema,
  cloudProjectSettingsUpdateSchema,
} from './project-settings'

test('old projects default to empty settings while writes reject malformed and oversized skills', () => {
  expect(cloudProjectSettingsSchema.parse({})).toEqual({
    startupScript: '',
    skills: [],
  })
  const skill = {
    name: 'review',
    description: 'Review changes',
    instructions: 'Read the diff.',
  }
  expect(
    cloudProjectSettingsSchema.safeParse({ skills: [skill, skill] }).success,
  ).toBe(false)
  expect(
    cloudProjectSettingsSchema.safeParse({
      skills: [{ ...skill, name: '../escape' }],
    }).success,
  ).toBe(false)
  expect(
    cloudProjectSettingsSchema.safeParse({ startupScript: 'x'.repeat(16001) })
      .success,
  ).toBe(false)
  expect(
    cloudProjectSettingsSchema.safeParse({
      skills: [{ ...skill, instructions: 'x'.repeat(50001) }],
    }).success,
  ).toBe(false)
  expect(
    cloudProjectSettingsUpdateSchema.safeParse({ settings: {} }).success,
  ).toBe(false)
  expect(
    cloudProjectSettingsUpdateSchema.safeParse({ revision: -1, settings: {} })
      .success,
  ).toBe(false)
  expect(
    cloudProjectSettingsUpdateSchema.safeParse({
      revision: 1,
      userId: 'another',
      settings: {},
    }).success,
  ).toBe(false)
})

test('skill packages reject escaping resource paths', () => {
  for (const path of [
    '../secret',
    '/etc/passwd',
    'dir/../../secret',
    'dir\\secret',
  ]) {
    expect(
      cloudProjectSettingsSchema.safeParse({
        skills: [
          {
            name: 'review',
            description: 'Review',
            instructions: 'Read resource',
            files: [{ path, contents: 'data' }],
          },
        ],
      }).success,
    ).toBe(false)
  }
})
