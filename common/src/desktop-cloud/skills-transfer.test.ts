import { expect, test } from 'bun:test'
import {
  accountSkillsUploadSchema,
  encodeAccountSkillsUpload,
  ACCOUNT_SKILLS_UPLOAD_MAX_BYTES,
} from './skills-transfer'

test('skill uploads preserve Unicode, code, resources and revisions for new and old clients', () => {
  const snapshot = {
    revision: 7,
    settings: {
      skills: [
        {
          name: 'review',
          description: 'Review 日本語 🧪',
          instructions: 'Review <script> examples and SELECT * FROM users;',
          files: [
            {
              path: 'references/code.ts',
              contents: 'export const hello = "你好"\n'.repeat(2500),
            },
          ],
        },
      ],
    },
  }
  const upload = encodeAccountSkillsUpload(snapshot)
  expect(JSON.stringify(upload)).not.toContain('<script>')
  expect(accountSkillsUploadSchema.parse(upload)).toEqual(snapshot)
  expect(accountSkillsUploadSchema.parse(snapshot)).toEqual(snapshot)
})

test('encoded uploads still reject malformed packages, unsafe paths, and oversized decoded libraries', () => {
  const wrap = (value: unknown) => ({
    encoding: 'base64',
    data: btoa(JSON.stringify(value)),
  })
  const skill = {
    name: 'review',
    description: 'Review',
    instructions: 'Review',
  }
  for (const value of [
    { encoding: 'base64', data: '!' },
    { encoding: 'base64', data: btoa('not json') },
    { encoding: 'base64', data: '/w==' }, // Invalid UTF-8.
    {
      encoding: 'base64',
      data: 'a'.repeat(ACCOUNT_SKILLS_UPLOAD_MAX_BYTES + 1),
    },
    wrap({ revision: -1, settings: { skills: [] } }),
    wrap({ revision: 0, settings: { skills: [skill, skill] } }),
    wrap({
      revision: 0,
      settings: {
        skills: [{ ...skill, files: [{ path: '../escape', contents: '' }] }],
      },
    }),
    wrap({
      revision: 0,
      settings: {
        skills: [
          {
            ...skill,
            files: Array.from({ length: 26 }, (_, i) => ({
              path: `file-${i}`,
              contents: 'x'.repeat(100000),
            })),
          },
        ],
      },
    }),
  ])
    expect(accountSkillsUploadSchema.safeParse(value).success).toBe(false)
})
