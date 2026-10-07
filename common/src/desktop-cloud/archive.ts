import { z } from 'zod/v4'

// Application budgets, shared by the importer, API and sandbox extractor.
export const CLOUD_ARCHIVE_BYTES = 4 * 1024 ** 3
export const CLOUD_EXPANDED_BYTES = 16 * 1024 ** 3
export const CLOUD_SOURCE_FILES = 200_000
export const CLOUD_UPLOAD_PART_BYTES = 8 * 1024 ** 2
// A shared project's multi-GiB checkpoint can outlast the old panel timeouts.
export const CLOUD_RESTORE_WAIT_MS = 15 * 60_000
export const archiveCheckpointSchema = z
  .object({
    key: z.string().max(512),
    bytes: z.number().int().positive().max(CLOUD_ARCHIVE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    version: z.literal(1),
  })
  .strict()
export const sourceArchiveSchema = z
  .object({
    checkpoint: archiveCheckpointSchema,
    id: z.string().uuid(),
  })
  .strict()
export type SourceArchive = z.infer<typeof sourceArchiveSchema>
