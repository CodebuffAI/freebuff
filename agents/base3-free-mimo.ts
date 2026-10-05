import {
  FREEBUFF_MIMO_V25_MODEL_ID,
  getFreebuffModel,
} from '@codebuff/common/constants/freebuff-models'

import { createBase3CliRoot } from './base3'

const definition = {
  ...createBase3CliRoot({
    model: FREEBUFF_MIMO_V25_MODEL_ID,
    // The compatibility id still says 2.5; the served model's name does not.
    modelLabel: getFreebuffModel(FREEBUFF_MIMO_V25_MODEL_ID).displayName,
    isFreebuff: true,
  }),
  id: 'base3-free-mimo',
  displayName: 'Buffy on MiMo',
}

export default definition
