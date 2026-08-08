import thinker from './thinker'
import type { SecretAgentDefinition } from '../types/secret-agent-definition'

const definition: SecretAgentDefinition = {
  ...thinker,
  id: 'thinker-gpt',
  model: 'openai/gpt-5.4',
  outputMode: 'last_message',
  inheritParentSystemPrompt: false,
  instructionsPrompt: `You are the thinker-gpt agent. Think deeply about the user request and when satisfied, write out your response.

The parent agent will see your response. DO NOT call any tools. No need to spawn the thinker agent, because you are already the thinker agent. Just do the thinking work now.`,
  *handleSteps() {
    yield 'STEP_ALL'
  },
}

export default definition
