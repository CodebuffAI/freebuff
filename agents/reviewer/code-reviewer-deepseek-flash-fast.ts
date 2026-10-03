import { FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { publisher } from '../constants'
import type { SecretAgentDefinition } from '../types/secret-agent-definition'
import { createReviewer } from './code-reviewer'

/** Pinned to the fast row like every other per-model reviewer; its base2 root
 *  sets `noReview`, so this is spawned by nothing today. */
const definition: SecretAgentDefinition = {
  id: 'code-reviewer-deepseek-flash-fast',
  publisher,
  ...createReviewer(FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID),
}

export default definition
