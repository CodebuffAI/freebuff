import { FREEBUFF_BASE3_FAST_AGENT_ID } from '@codebuff/common/constants/free-agents'
import { FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase3FastCliRoot } from './base3-fast'

/** DeepSeek V4.1 Flash, fast mode: the base3-fast root on DeepSeek's own API. */
const definition = {
  ...createBase3FastCliRoot(FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID),
  id: FREEBUFF_BASE3_FAST_AGENT_ID,
  displayName: 'Buffy on DeepSeek Flash (fast mode)',
}

export default definition
