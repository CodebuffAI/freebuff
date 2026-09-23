import { FREEBUFF_SOLAR_MINI_4_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { publisher } from '../constants'
import type { SecretAgentDefinition } from '../types/secret-agent-definition'
import { createReviewer } from './code-reviewer'

const definition: SecretAgentDefinition = {
  id: 'code-reviewer-solar-mini4',
  publisher,
  ...createReviewer(FREEBUFF_SOLAR_MINI_4_MODEL_ID),
}

export default definition
