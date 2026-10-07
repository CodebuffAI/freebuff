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

export function encodeAccountSkillsUpload(value: AccountSkillsSnapshot) {
  const bytes = new TextEncoder().encode(
    JSON.stringify(accountSkillsUpdateSchema.parse(value)),
  )
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return { encoding: 'base64' as const, data: btoa(binary) }
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
