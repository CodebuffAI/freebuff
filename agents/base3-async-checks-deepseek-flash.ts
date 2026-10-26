import { FREEBUFF_BASE3_ASYNC_CHECKS_AGENT_ID } from '@codebuff/common/constants/free-agents'
import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '@codebuff/common/constants/freebuff-model-ids'

import { createBase3AsyncWorker } from './base3-async'

/**
 * The base3-async harness's CHECKS subagent on the CLI and Desktop. It sends
 * Flash's plain id, the model its root's handle resolves to: a subagent never
 * carries a handle (docs/freebuff-model-catalog.md, "Row harnesses").
 */
const definition = {
  ...createBase3AsyncWorker(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID),
  id: FREEBUFF_BASE3_ASYNC_CHECKS_AGENT_ID,
}

export default definition
