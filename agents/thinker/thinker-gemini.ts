import { FREEBUFF_GPT_5_6_LUNA_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import thinker from './thinker'

import type { SecretAgentDefinition } from '../types/secret-agent-definition'

/**
 * The freebuff.com/chat thinker child, spawned by base-chat.
 *
 * Uses GPT-5.6 Luna with extra-high reasoning for Chat deliberation.
 *
 * The id stays `thinker-gemini`: chat/agent.ts registers it by import, the
 * hidden-agent list and FREEBUFF_GEMINI_PRO_AGENT_IDS name it, and base-chat's
 * prompt spawns it by name. Renaming buys nothing and touches all of them.
 */
const definition: SecretAgentDefinition = {
  ...thinker,
  id: 'thinker-gemini',
  displayName: 'Thinker',
  model: FREEBUFF_GPT_5_6_LUNA_MODEL_ID,
  providerOptions: undefined,
  reasoningOptions: {
    enabled: true,
    effort: 'xhigh',
  },
  outputSchema: undefined,
  outputMode: 'last_message',
  inheritParentSystemPrompt: false,
  instructionsPrompt: `You are the thinker-gemini agent. Think about the user request and when satisfied, write out a very concise response that captures the most important points. DO NOT be verbose -- say the absolute minimum needed to answer the user's question correctly.
  
The parent agent will see your response. DO NOT call any tools. No need to spawn the thinker agent, because you are already the thinker agent. Just do the thinking work now.`,
  handleSteps: function* () {
    yield 'STEP'
  },
}

export default definition
