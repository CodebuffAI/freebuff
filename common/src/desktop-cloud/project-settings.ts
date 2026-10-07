import { z } from 'zod/v4'

export const cloudSkillSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    description: z.string().trim().min(1).max(1000),
    instructions: z.string().trim().min(1).max(50000),
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .max(256)
              .refine(
                (path) =>
                  !!path &&
                  !path.startsWith('/') &&
                  !path.includes('\\') &&
                  path.toLowerCase() !== 'skill.md' &&
                  !/[<>:"|?*]/.test(path) &&
                  path
                    .split('/')
                    .every((part) => !!part && part !== '.' && part !== '..') &&
                  !/[\x00-\x1f]/.test(path),
                'Invalid skill resource path',
              ),
            contents: z.string().max(100000),
          })
          .strict(),
      )
      .max(50)
      .refine(
        (files) =>
          files.every((file, i) =>
            files.every(
              (other, j) =>
                i === j ||
                (file.path.toLowerCase() !== other.path.toLowerCase() &&
                  !file.path
                    .toLowerCase()
                    .startsWith(`${other.path.toLowerCase()}/`)),
            ),
          ),
        'Skill resources must have distinct file paths',
      )
      .optional(),
  })
  .strict()
export const cloudProjectSettingsSchema = z
  .object({
    startupScript: z.string().max(16000).default(''),
    skills: z.array(cloudSkillSchema).max(50).default([]),
  })
  .strict()
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= 2_500_000,
    'Cloud project skills must total less than 2.5 MB',
  )
  .refine(
    (value) =>
      new Set(value.skills.map((s) => s.name)).size === value.skills.length,
    'Skill names must be unique',
  )
export type CloudProjectSettings = z.infer<typeof cloudProjectSettingsSchema>
export type CloudProjectSettingsSnapshot = {
  revision: number
  settings: CloudProjectSettings
}
export const cloudProjectSettingsUpdateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: cloudProjectSettingsSchema,
  })
  .strict()

/** Account-wide managed skills; startup scripts remain project scoped. */
export const accountSkillsSchema = z
  .object({ skills: z.array(cloudSkillSchema).max(50) })
  .strict()
  .refine(
    (value) =>
      new Set(value.skills.map((s) => s.name)).size === value.skills.length,
    'Skill names must be unique',
  )
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= 2_500_000,
    'Skills must total less than 2.5 MB',
  )
export const accountSkillsUpdateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: accountSkillsSchema,
  })
  .strict()
export type AccountSkillsSnapshot = {
  revision: number
  settings: z.infer<typeof accountSkillsSchema>
}
