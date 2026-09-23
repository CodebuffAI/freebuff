import { FREEBUFF_SOLAR_MINI_4_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase3CliRoot } from './base3'

const definition = {
  ...createBase3CliRoot({
    model: FREEBUFF_SOLAR_MINI_4_MODEL_ID,
    isFreebuff: true,
  }),
  id: 'base3-free-solar-mini4',
  displayName: 'Buffy on Solar Mini 4',
}

export default definition
