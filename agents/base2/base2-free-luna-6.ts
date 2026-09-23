import {
  FREEBUFF_GPT_6_LUNA_MODEL_ID,
  FREEBUFF_GPT_6_LUNA_REASONING_EFFORT,
} from '@codebuff/common/constants/freebuff-models'

import { createBase2 } from './base2'

// The base2 rollback root for GPT-6 Luna, bundled alongside its base3 twin so
// the FREEBUFF_BASE3_HARNESS_DISABLED kill switch has somewhere to route.
const definition = {
  ...createBase2('free', {
    model: FREEBUFF_GPT_6_LUNA_MODEL_ID,
  }),
  id: 'base2-free-luna-6',
  displayName: 'Buffy the GPT-6 Luna Free Orchestrator',
  // Same rule as base2-free-luna: the server applies this default too
  // (applyFreebuffReasoningDefaults), both reading the shared constant.
  reasoningOptions: {
    enabled: true,
    effort: FREEBUFF_GPT_6_LUNA_REASONING_EFFORT,
  },
}

export default definition
