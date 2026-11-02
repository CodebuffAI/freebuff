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

// Documents routinely contain shell commands and file paths that Render's edge
// WAF blocks with an HTML 403 (docs/render-edge-waf.md), so the browser sends
// the file's bytes base64-encoded, as Skills uploads do. Encoding is transport
// only; the gateway decodes and validates exactly as it does a multipart file.
const CLOUD_DOCUMENT_ENCODED_CHARS = Math.ceil(CLOUD_DOCUMENT_UPLOAD_BYTES / 3) * 4
export const CLOUD_DOCUMENT_ENCODED_UPLOAD_BYTES =
  CLOUD_DOCUMENT_ENCODED_CHARS + 4096

export const cloudDocumentFileUploadSchema = z
  .object({
    encoding: z.literal('base64'),
    name: z.string().max(1024),
    mediaType: z.string().max(255),
    data: z.string().max(CLOUD_DOCUMENT_ENCODED_CHARS),
  })
  .strict()
export type CloudDocumentFileUpload = z.infer<
  typeof cloudDocumentFileUploadSchema
>

export async function encodeCloudDocumentUpload(
  file: File,
): Promise<CloudDocumentFileUpload> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return {
    encoding: 'base64',
    name: file.name,
    mediaType: file.type,
    data: btoa(binary),
  }
}

export const cloudDocumentUploadSchema = z
  .object({
    name: z.string().min(1).max(200),
    text: z.string().min(1).max(CLOUD_DOCUMENT_MAX_CHARS),
    truncated: z.boolean(),
  })
  .strict()
