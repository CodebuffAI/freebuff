import { OPUS_MODEL, publisher } from '../constants'
import type { SecretAgentDefinition } from '../types/secret-agent-definition'

const definition: SecretAgentDefinition = {
  id: 'thinker',
  publisher,
  model: OPUS_MODEL,
  providerOptions: {
    only: ['amazon-bedrock'],
  },
  displayName: 'Theo the Theorizer',
  spawnerPrompt:
    'Does deep thinking given the current conversation history and a specific prompt to focus on. Use this to help you solve a specific problem. You must gather any relevant context before spawning this agent because the thinker agent has no access to tools. You can keep the prompt very short, because the thinker agent can see the entire conversation history for context.',
  inputSchema: {
    prompt: {
      type: 'string',
      description:
        'The problem you are trying to solve, very briefly. No need to provide context, as the thinker agent can see the entire conversation history.',
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: "The response to the user's request",
      },
    },
  },
  outputMode: 'structured_output',
  inheritParentSystemPrompt: true,
  includeMessageHistory: true,
  spawnableAgents: [],
  toolNames: [],

  instructionsPrompt: `
You are a thinker agent. Use the <think> tag to think deeply about the user request.

When satisfied, write out a brief response to the user's request. The parent agent will see your response -- no need to call any tools. DO NOT call the set_output tool, as that will be done for you.
`.trim(),

  *handleSteps() {
    const { agentState } = yield 'STEP'

    // Find the last assistant message without copying the array using findLast
    const lastAssistantMessage = agentState.messageHistory.findLast(
      (m) => m.role === 'assistant'
    )

    if (!lastAssistantMessage) {
      yield {
        toolName: 'set_output',
        input: {
          message: 'Error: No assistant message found in conversation history',
        },
      }
      return
    }

    // Extract text content safely from string or structured content array
    const content = lastAssistantMessage.content
    let textContent = ''

    if (typeof content === 'string') {
      textContent = content
    } else if (Array.isArray(content)) {
      textContent = content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('')
    }

    // Strip <think>...</think> tags and sanitize output
    const cleanedText = textContent
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim()

    yield {
      toolName: 'set_output',
      input: { message: cleanedText },
      includeToolCall: false,
    }
  },
}

export default definition
