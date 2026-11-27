import { z } from 'zod/v4'
import {
  accountSkillsUpdateSchema,
  type AccountSkillsSnapshot,
} from './project-settings'

// Skill packages contain arbitrary source code and documentation. Transport
// them as encoded file data so edge form filters do not interpret that content
// as executable request fields. Authentication and decoded validation still
// happen on the API; this encoding provides no secrecy or authorization.
export const ACCOUNT_SKILLS_UPLOAD_MAX_BYTES = 4 * 1024 * 1024

// Older Desktop builds use a strict skill schema without `enabled`.
export const ACCOUNT_SKILLS_STATE_QUERY = 'includeEnabled'
/**
 * A client that knows skill folders asks for them. Without it the server leaves
 * `folder` out of what it sends (older builds parse skills strictly and would
 * refuse the key) and keeps each saved skill's folder on a save.
 */
export const ACCOUNT_SKILLS_FOLDERS_QUERY = 'folders'
export const ACCOUNT_SKILLS_STATE_PATH = `/api/v1/cloud/skills?${ACCOUNT_SKILLS_STATE_QUERY}=1`
/** The web workspace's route: it deploys with the server, so it always knows folders. */
export const ACCOUNT_SKILLS_WORKSPACE_PATH = `${ACCOUNT_SKILLS_STATE_PATH}&${ACCOUNT_SKILLS_FOLDERS_QUERY}=1`

/**
 * The bytes of one uploaded skill package (a SKILL.md or a .zip) before
 * encoding. This bounds the archive, not the skill: a GitHub "Download ZIP" is
 * the whole repository, README images and all, around a skill of a few KB.
 * Only the chosen skill's own files are read and held to the library's 2.5 MB.
 */
export const SKILL_PACKAGE_MAX_BYTES = 16_000_000
const SKILL_PACKAGE_MAX_BASE64 = Math.ceil(SKILL_PACKAGE_MAX_BYTES / 3) * 4
/** The upload request: the base64 package plus its small JSON envelope. */
export const SKILL_UPLOAD_MAX_BYTES = SKILL_PACKAGE_MAX_BASE64 + 4096

export const skillPackageUploadSchema = z
  .object({
    encoding: z.literal('base64'),
    format: z.enum(['markdown', 'zip']),
    data: z.string().min(1).max(SKILL_PACKAGE_MAX_BASE64),
    /** Which folder of a .zip holding several skills to add. */
    skill: z.string().min(1).max(512).optional(),
  })
  .strict()
export type SkillPackageUpload = z.infer<typeof skillPackageUploadSchema>

function toBase64(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}

export function encodeSkillPackageUpload(
  bytes: Uint8Array,
  format: SkillPackageUpload['format'],
  skill?: string,
): SkillPackageUpload {
  return {
    encoding: 'base64',
    format,
    data: toBase64(bytes),
    ...(skill ? { skill } : {}),
  }
}

export function encodeAccountSkillsUpload(value: AccountSkillsSnapshot) {
  const bytes = new TextEncoder().encode(
    JSON.stringify(accountSkillsUpdateSchema.parse(value)),
  )
  return { encoding: 'base64' as const, data: toBase64(bytes) }
}

const encodedUploadSchema = z
  .object({
    encoding: z.literal('base64'),
    data: z.string().max(ACCOUNT_SKILLS_UPLOAD_MAX_BYTES),
  })
  .strict()
  .transform((value, ctx) => {
    try {
      const bytes = Uint8Array.from(atob(value.data), (char) =>
        char.charCodeAt(0),
      )
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid skill package encoding',
      })
      return z.NEVER
    }
  })
  .pipe(accountSkillsUpdateSchema)

// Keep existing clients working during the server-first rollout.
export const accountSkillsUploadSchema = z.union([
  accountSkillsUpdateSchema,
  encodedUploadSchema,
])
