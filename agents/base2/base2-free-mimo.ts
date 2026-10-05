import {
  FREEBUFF_MIMO_V25_MODEL_ID,
  getFreebuffModel,
} from '@codebuff/common/constants/freebuff-models'

import { createBase2 } from './base2'

const definition = {
  ...createBase2('free', {
    model: FREEBUFF_MIMO_V25_MODEL_ID,
    modelLabel: getFreebuffModel(FREEBUFF_MIMO_V25_MODEL_ID).displayName,
  }),
  id: 'base2-free-mimo',
  displayName: 'Buffy the MiMo Free Orchestrator',
}

export default definition
