import { FREEBUFF_SPACE_BUNNY_ALPHA_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase2 } from './base2'

// The base2 rollback root for Space Bunny Alpha, bundled alongside its base3
// twin so the FREEBUFF_BASE3_HARNESS_DISABLED kill switch has somewhere to
// route. No `reasoningOptions`, for the reason on base3-free-space-bunny-alpha.
const definition = {
  ...createBase2('free', {
    model: FREEBUFF_SPACE_BUNNY_ALPHA_MODEL_ID,
  }),
  id: 'base2-free-space-bunny-alpha',
  displayName: 'Buffy the Space Bunny Alpha Free Orchestrator',
}

export default definition
