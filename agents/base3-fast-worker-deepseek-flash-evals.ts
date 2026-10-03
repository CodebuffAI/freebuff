import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase3FastWorker } from './base3-fast'

/**
 * The buffbench worker: the production worker pinned to the ORDINARY Flash
 * id, because the bench runs against the live API as a paid caller and the
 * fast-mode wire id is not something a client can send before it ships. On
 * a paid request Flash enters the DeepSeek cascade on DeepSeek direct, the
 * same lane the fast row is pinned to, so the comparison stays on one
 * provider. Never registered for free mode.
 */
const definition = {
  ...createBase3FastWorker(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID),
  id: 'base3-fast-worker-deepseek-flash-evals',
  displayName: 'Buffy Worker on DeepSeek Flash (evals)',
}

export default definition
