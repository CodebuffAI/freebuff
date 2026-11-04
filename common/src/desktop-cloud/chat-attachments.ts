import { z } from 'zod/v4'
import { PROJECT_FILE_MAX_BYTES, validProjectFileName } from './project-files'

const fields = {
  id: z.string().uuid(),
  name: z.string().refine(validProjectFileName),
  mediaType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/).max(120),
  bytes: z.number().int().min(0).max(PROJECT_FILE_MAX_BYTES),
}

/** Originals awaiting a new chat, or files already added to its shared sources. */
export const chatAttachmentSchema = z.discriminatedUnion('kind', [
  z.object({
    ...fields,
    kind: z.literal('upload'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    ...fields,
    kind: z.literal('stored'),
    scope: z.object({ kind: z.enum(['project', 'chat']), id: z.string().min(1).max(200) }).strict(),
  }).strict(),
])

export type ChatAttachment = z.infer<typeof chatAttachmentSchema>
export type ChatAttachmentUpload = Extract<ChatAttachment, { kind: 'upload' }>
export const CHAT_ATTACHMENT_MAX_COUNT = 9
