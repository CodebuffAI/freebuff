import {
  FREEBUFF_GPT_61_SOL_MODEL_ID,
  FREEBUFF_GPT_61_SOL_REASONING_EFFORT,
} from '@codebuff/common/constants/freebuff-models'

import { createBase2 } from './base2'

// The base2 rollback root for GPT-6.1 Sol, bundled alongside its base3 twin so
// the FREEBUFF_BASE3_HARNESS_DISABLED kill switch has somewhere to route.
const definition = {
  ...createBase2('free', {
    model: FREEBUFF_GPT_61_SOL_MODEL_ID,
  }),
  id: 'base2-free-gpt-6-1-sol',
  displayName: 'Buffy the GPT-6.1 Sol Free Orchestrator',
  // The server applies this default too (applyFreebuffReasoningDefaults), both
  // reading the shared constant.
  reasoningOptions: {
    enabled: true,
    effort: FREEBUFF_GPT_61_SOL_REASONING_EFFORT,
  },
}

export default definition
