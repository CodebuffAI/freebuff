import { z } from 'zod/v4'

export const CLOUD_DOCUMENT_MAX_COUNT = 5
export const CLOUD_DOCUMENT_MAX_CHARS = 1_000_000
export const CLOUD_DOCUMENT_MAX_BYTES = 4 * CLOUD_DOCUMENT_MAX_CHARS
export const CLOUD_DOCUMENT_UPLOAD_BYTES = 5 * 1024 * 1024

/** Only extracted text is stored. The id is its hash, scoped to the uploader. */
export const cloudDocumentSchema = z
  .object({
    kind: z.literal('document'),
    id: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(200),
    mediaType: z.literal('text/plain'),
    bytes: z.number().int().positive().max(CLOUD_DOCUMENT_MAX_BYTES),
    truncated: z.boolean(),
  })
  .strict()
export type CloudDocument = z.infer<typeof cloudDocumentSchema>

export const cloudDocumentUploadSchema = z
  .object({
    name: z.string().min(1).max(200),
    text: z.string().min(1).max(CLOUD_DOCUMENT_MAX_CHARS),
    truncated: z.boolean(),
  })
  .strict()
