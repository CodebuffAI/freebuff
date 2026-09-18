import {
  getFreebuffBase3RootAgentIdForModel,
  getFreebuffRootAgentIdForModel,
} from '@codebuff/common/constants/free-agents'

import { getSelectedFreebuffModel } from '../state/freebuff-model-store'
import {
  AGENT_MODE_TO_ID,
  CLI_HARNESS,
  IS_FREEBUFF,
  type AgentMode,
} from './constants'

/**
 * Freebuff is locked to LITE (chat-store's setAgentMode is a no-op when
 * IS_FREEBUFF), so this is effectively "which root does the selected model
 * run". Both harnesses have a root per picker model; CLI_HARNESS picks the
 * family. Fable 5.1 is a deliberate base2 exception for its trace campaign.
 * The default is currently base3; keeping both branches live preserves the
 * release-based rollback path for the CLI.
 */
export function getFreebuffCliAgentIdForModel(model: string): string {
  return CLI_HARNESS === 'base3'
    ? getFreebuffBase3RootAgentIdForModel(model)
    : getFreebuffRootAgentIdForModel(model)
}

export function getAgentIdForMode(agentMode: AgentMode): string {
  if (IS_FREEBUFF && agentMode === 'LITE') {
    return getFreebuffCliAgentIdForModel(getSelectedFreebuffModel())
  }

  return AGENT_MODE_TO_ID[agentMode]
}
