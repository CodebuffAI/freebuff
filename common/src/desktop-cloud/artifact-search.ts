import { ARTIFACT_KINDS, type ArtifactMeta } from './artifacts'
import { z } from 'zod'

export const artifactSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  scope: z.enum(['all', 'mine', 'shared']).default('all'),
  kind: z.enum(ARTIFACT_KINDS).optional(),
  cursor: z.string().min(1).max(256).optional(),
  /** Collect stored slide photos for visual inspection, even when they have no searchable text. */
  images: z.literal('1').optional(),
}).strict()

export type ArtifactSearchTarget =
  | { kind: 'artifact' }
  | { kind: 'slides'; slideId: string; elementId?: string; assetId?: string }

export type ArtifactSearchHit = {
  artifact: ArtifactMeta
  target: ArtifactSearchTarget
  label: string
  snippet: string
}

export type ArtifactSearchResponse = {
  hits: ArtifactSearchHit[]
  nextCursor: string | null
}
