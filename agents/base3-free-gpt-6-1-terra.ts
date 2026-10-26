import { FREEBUFF_GPT_61_TERRA_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase3CliRoot } from './base3'

/**
 * GPT-6.1 Terra on the CLI (and, by the shared root id, the Desktop). Open to
 * every full-access account, plan-only at limited access
 * (FREEBUFF_LIMITED_TIER_PLAN_ONLY_MODEL_IDS); admission is the gate.
 *
 * No `reasoningOptions`, like every base3 root: the catalog owns the ladder and
 * the server fills the effort in, so the picker and the wire cannot drift.
 */
const definition = {
  ...createBase3CliRoot({
    model: FREEBUFF_GPT_61_TERRA_MODEL_ID,
    isFreebuff: true,
  }),
  id: 'base3-free-gpt-6-1-terra',
  displayName: 'Buffy on GPT-6.1 Terra',
}

export default definition
