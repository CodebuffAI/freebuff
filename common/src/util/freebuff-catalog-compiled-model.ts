import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '../constants/freebuff-model-ids'
import { SUPPORTED_FREEBUFF_MODELS } from '../constants/freebuff-models'
import { freebuffLegacyModelDigest } from '../types/freebuff-model-catalog'

import type { FreebuffCatalogRow } from '../types/freebuff-model-catalog'

const COMPILED_ID_BY_DIGEST: ReadonlyMap<string, string> = new Map(
  SUPPORTED_FREEBUFF_MODELS.map((model) => [
    freebuffLegacyModelDigest(model.id),
    model.id,
  ]),
)

/**
 * The compiled model id a server-catalog row replaces, by its legacy digests;
 * undefined for a catalog-only row. The CLI and Desktop both read it wherever
 * local policy is still keyed by compiled ids (which harness a row runs, the
 * picker's compiled flags), because a row's handle is opaque.
 */
export function compiledFreebuffModelIdOfRow(
  row: Pick<FreebuffCatalogRow, 'legacyDigests'>,
): string | undefined {
  for (const digest of row.legacyDigests ?? []) {
    const id = COMPILED_ID_BY_DIGEST.get(digest)
    if (id) return id
  }
  return undefined
}

/**
 * Whether the CLI and Desktop run a row on the base3-async harness
 * (agents/base3-async.ts): it names the harness and stands for DeepSeek V4.1
 * Flash, the one model the harness's CHECKS subagent is pinned to
 * (docs/freebuff-model-catalog.md, "Row harnesses").
 */
export function freebuffRowRunsBase3Async(
  row: Pick<FreebuffCatalogRow, 'harness' | 'legacyDigests'>,
): boolean {
  return (
    row.harness === 'base3-async' &&
    compiledFreebuffModelIdOfRow(row) === FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID
  )
}
