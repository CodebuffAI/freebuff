import { FREEBUFF_GPT_61_SOL_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { publisher } from '../constants'
import type { SecretAgentDefinition } from '../types/secret-agent-definition'
import { createReviewer } from './code-reviewer'

// Every CLI-selectable model needs a reviewer running THE SAME model: base2
// otherwise falls back to the DeepSeek Flash reviewer, which this model's
// session is not allowed to run, and the subagent 403s mid-session.
const definition: SecretAgentDefinition = {
  id: 'code-reviewer-gpt-6-1-sol',
  publisher,
  ...createReviewer(FREEBUFF_GPT_61_SOL_MODEL_ID),
}

export default definition
