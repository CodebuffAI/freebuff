import { FREEBUFF_SPACE_BUNNY_ALPHA_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { publisher } from '../constants'
import type { SecretAgentDefinition } from '../types/secret-agent-definition'
import { createReviewer } from './code-reviewer'

const definition: SecretAgentDefinition = {
  id: 'code-reviewer-space-bunny-alpha',
  publisher,
  ...createReviewer(FREEBUFF_SPACE_BUNNY_ALPHA_MODEL_ID),
}

export default definition
