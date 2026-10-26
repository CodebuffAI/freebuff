import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase3AsyncCliRoot } from './base3-async'

/**
 * base3-async on DeepSeek V4 Flash: the buffbench arm against
 * `base3-free-deepseek-flash-evals`. Same model, same `noAskUser` and `noWeb`,
 * same Freebuff branding; the team harness is the only difference.
 */
const definition = {
  ...createBase3AsyncCliRoot(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, {
    workerAgentId: 'base3-async-worker-deepseek-flash-evals',
    noAskUser: true,
    noWeb: true,
  }),
  id: 'base3-async-free-deepseek-flash-evals',
}

export default definition
