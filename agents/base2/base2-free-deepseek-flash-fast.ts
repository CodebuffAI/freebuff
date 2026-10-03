import { FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase2 } from './base2'

/**
 * The base2 twin of the fast-mode DeepSeek Flash row. Nothing routes here
 * while the base3 harness is on; it exists for the same reason every other
 * model's does — the Web/Cloud kill switch and the CLI's base2 fallback need
 * a root pinned to this model, or a turn on it 403s. `noReview`: the fast
 * row's reviewer is registered for the map's sake and never spawned.
 */
const definition = {
  ...createBase2('free', {
    noReview: true,
    model: FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
  }),
  id: 'base2-free-deepseek-flash-fast',
  displayName: 'Buffy the DeepSeek Flash Fast Free Orchestrator',
}

export default definition
