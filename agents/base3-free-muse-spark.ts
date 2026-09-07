import { FREEBUFF_MUSE_SPARK_12_CONTRIBUTOR_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase3CliRoot } from './base3'

/**
 * Muse Spark 1.2 Contributor on the CLI, and by the shared root id on Desktop.
 *
 * Restored on 2026-09-07, when 1.3 was withdrawn: it answered `404
 * model_not_found` on all four keys while this version answered every probe.
 *
 * The single-loop harness suits this row twice over: Meta meters the
 * Contributor tier per TEAM, so every subagent or reviewer pass would spend
 * requests from budgets shared with every other Freebuff user. No
 * `reasoningOptions`, like every Freebuff root — the catalog owns the ladder
 * and the server fills it in, so the picker and the wire cannot drift.
 */
const definition = {
  ...createBase3CliRoot({
    model: FREEBUFF_MUSE_SPARK_12_CONTRIBUTOR_MODEL_ID,
    isFreebuff: true,
  }),
  id: 'base3-free-muse-spark',
  displayName: 'Buffy on Muse Spark 1.2',
}

export default definition
