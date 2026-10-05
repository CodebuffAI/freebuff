/**
 * The root a catalog-mode turn runs as (docs/freebuff-model-catalog.md).
 *
 * ONE root id for every catalog row, `base3-free-catalog`, whose definition is
 * built here from the row at send time: the row's HANDLE is the model (the
 * server resolves it; it admits no plain id on this root), the row's display
 * name is what the prompt tells the model it runs on (the handle is opaque and
 * must not be), and the row's compaction policy replaces the per-model lookup
 * that cannot key on a handle. A new model therefore needs no new root and no
 * release.
 *
 * The one exception is the harness: a row that replaces a fast-mode model
 * (FREEBUFF_FAST_MODE_MODEL_IDS, by its legacy digests) runs the base3-fast
 * root, with `spawn_agents` and its file-picker, code-searcher and worker
 * fan-out, as its compiled root does. Its helpers keep their own plain model
 * ids; the worker's is the fast id the handle resolves to, so the session
 * gate admits it.
 *
 * Built fresh for every run rather than cached, because the handle rotates:
 * `loadAgentDefinitions` is read per send, so a refetched catalog reaches the
 * very next turn.
 */
import { createBase3CliRoot } from '../../../agents/base3'
import { createBase3FastCliRoot } from '../../../agents/base3-fast'
import { FREEBUFF_CLI_CATALOG_ROOT_AGENT_ID } from '@codebuff/common/constants/free-agents'
import { isFreebuffFastModeModel } from '@codebuff/common/constants/freebuff-model-ids'
import { compiledFreebuffModelIdOfRow } from '@codebuff/common/util/freebuff-catalog-compiled-model'

import type { FreebuffCatalogRow } from '@codebuff/common/types/freebuff-model-catalog'
import type { AgentDefinition } from '@codebuff/sdk'

export function freebuffCatalogRootAgent(
  row: Pick<
    FreebuffCatalogRow,
    'handle' | 'displayName' | 'compaction' | 'legacyDigests'
  >,
): AgentDefinition {
  const rowOptions = { modelLabel: row.displayName, compaction: row.compaction }
  const root = isFreebuffFastModeModel(compiledFreebuffModelIdOfRow(row))
    ? createBase3FastCliRoot(row.handle, rowOptions)
    : createBase3CliRoot({ model: row.handle, isFreebuff: true, ...rowOptions })
  return {
    ...root,
    id: FREEBUFF_CLI_CATALOG_ROOT_AGENT_ID,
    // The bundled roots' naming ("Buffy on MiMo"), from the row.
    displayName: `Buffy on ${row.displayName}`,
  } as AgentDefinition
}
