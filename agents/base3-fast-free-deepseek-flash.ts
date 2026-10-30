import { FREEBUFF_BASE3_FAST_AGENT_ID } from '@codebuff/common/constants/free-agents'
import { FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase3CliRoot } from './base3'

/**
 * DeepSeek V4.1 Flash, fast mode: Flash's base3 root, batching
 * included, on Pareto in front of DeepSeek's own API.
 * It ran the base3-fast fan-out (agents/base3-fast.ts) until 2026-10-30. The
 * id keeps its old name because released CLIs still send it, with the fan-out
 * root they compiled in.
 */
const definition = {
  ...createBase3CliRoot({
    model: FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
    isFreebuff: true,
  }),
  id: FREEBUFF_BASE3_FAST_AGENT_ID,
  displayName: 'Buffy on DeepSeek Flash (fast mode)',
}

export default definition
