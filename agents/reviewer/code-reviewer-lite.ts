import { publisher } from '../constants'
import type { SecretAgentDefinition } from '../types/secret-agent-definition'
import { createReviewer } from './code-reviewer'

const definition: SecretAgentDefinition = {
  id: 'code-reviewer-lite',
  publisher,
  ...createReviewer('minimax/minimax-m2.7'),
}

export default definition
