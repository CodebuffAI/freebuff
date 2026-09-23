import { FREEBUFF_GPT_6_LUNA_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase3CliRoot } from './base3'

/**
 * GPT-6 Luna on the CLI (and, by the shared root id, the Desktop).
 *
 * No `reasoningOptions`, like every base3 root: the catalog owns the ladder and
 * the server fills the effort in, so the picker and the wire cannot drift.
 */
const definition = {
  ...createBase3CliRoot({
    model: FREEBUFF_GPT_6_LUNA_MODEL_ID,
    isFreebuff: true,
  }),
  id: 'base3-free-luna-6',
  displayName: 'Buffy on GPT-6 Luna',
}

export default definition
