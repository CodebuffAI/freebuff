import { FREEBUFF_MUSE_SPARK_12_CONTRIBUTOR_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { publisher } from '../constants'
import type { SecretAgentDefinition } from '../types/secret-agent-definition'
import { createReviewer } from './code-reviewer'

// Registered so every CLI-selectable model has a reviewer running ITS OWN
// model: a missing entry falls back to the DeepSeek Flash reviewer, which a
// Muse Spark session may not run, and the subagent 403s mid-session. Spawned by
// nothing today — the Muse Spark root sets `noReview`.
const definition: SecretAgentDefinition = {
  id: 'code-reviewer-muse-spark',
  publisher,
  ...createReviewer(FREEBUFF_MUSE_SPARK_12_CONTRIBUTOR_MODEL_ID),
}

export default definition
