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

/**
 * The bytes of one uploaded skill package (a SKILL.md or a .zip) before
 * encoding. Base64 keeps the body under `ACCOUNT_SKILLS_UPLOAD_MAX_BYTES`, the
 * limit the browser gateway already applies to a skills save.
 */
export const SKILL_PACKAGE_MAX_BYTES = 3_000_000

export const skillPackageUploadSchema = z
  .object({
    encoding: z.literal('base64'),
    format: z.enum(['markdown', 'zip']),
    data: z.string().min(1).max(ACCOUNT_SKILLS_UPLOAD_MAX_BYTES),
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
): SkillPackageUpload {
  return { encoding: 'base64', format, data: toBase64(bytes) }
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
