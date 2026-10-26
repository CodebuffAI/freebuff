import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase3AsyncWorker } from './base3-async'

/**
 * The subagent the base3-async buffbench arm starts. It runs its root's
 * model, so its requests share the root's cached prefix.
 */
const definition = {
  ...createBase3AsyncWorker(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID),
  id: 'base3-async-worker-deepseek-flash-evals',
}

export default definition
