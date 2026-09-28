import { OPUS_MODEL, publisher } from '../../constants'

import type { AgentStepContext, ToolCall } from '../../types/agent-definition'
import type { SecretAgentDefinition } from '../../types/secret-agent-definition'

/**
 * Creates a multi-prompt code reviewer agent that spawns one code-reviewer per prompt.
 * Each prompt specifies a slightly different review focus or perspective.
 * Combines all review outputs into a single comprehensive review.
 */
export function createCodeReviewerMultiPrompt(): Omit<
  SecretAgentDefinition,
  'id'
> {
  return {
    publisher,
    model: OPUS_MODEL,
    providerOptions: {
      only: ['amazon-bedrock'],
    },
    displayName: 'Multi-Prompt Code Reviewer',
    spawnerPrompt:
      'Reviews code by spawning multiple code-reviewer agents with different focus prompts, then combines all review outputs into a comprehensive review. Make sure to read relevant files before spawning this agent. Pass an input array of short prompts specifying several different review focuses or perspectives.',

    includeMessageHistory: true,
    inheritParentSystemPrompt: true,

    toolNames: ['spawn_agents', 'set_output'],
    spawnableAgents: ['code-reviewer-opus'],

    inputSchema: {
      params: {
        type: 'object',
        properties: {
          prompts: {
            type: 'array',
            items: { type: 'string' },
            description: `Array of 3-5 short prompts, each specifying a different review focus or perspective. Can be specific parts of the code that was changed (frontend), or angles like reviewing with an eye for simplifying the code or design or code style.
Example 1:
["api design", "correctness and edge cases", "find ways to simplify the code or reuse existing code", "security concerns", "overall review"]
Example 2:
[ "frontend changes", "backend changes", "code style, maintainability, and readability"]
`,
          },
        },
        required: ['prompts'],
      },
    },
    outputMode: 'structured_output',

    handleSteps: handleStepsMultiPrompt,
  }
}

function* handleStepsMultiPrompt({
  params,
  agentState,
}: AgentStepContext): ReturnType<
  NonNullable<SecretAgentDefinition['handleSteps']>
> {
  const prompts = (params?.prompts as string[] | undefined) ?? []

  if (prompts.length === 0) {
    yield {
      toolName: 'set_output',
      input: {
        error:
          'No prompts provided. Please pass an array of review focus prompts.',
      },
    } satisfies ToolCall<'set_output'>
    return
  }

  const { messageHistory } = agentState
  // Remove last user messages (prompt, subagent spawn message, instructions prompt)
  while (messageHistory.length > 0 && messageHistory[messageHistory.length - 1].role === 'user') {
    messageHistory.pop()
  }

  yield {
    toolName: 'set_messages',
    input: {
      messages: messageHistory,
    },
    includeToolCall: false,
  } satisfies ToolCall<'set_messages'>

  // Spawn one code-reviewer per prompt
  const reviewerAgents: { agent_type: string; prompt: string }[] = prompts.map(
    (prompt) => ({
      agent_type: 'code-reviewer-opus',
      prompt: `Review the above code changes with the following focus: ${prompt}`,
    }),
  )

  // Spawn all reviewer agents
  const { toolResult: reviewerResults } = yield {
    toolName: 'spawn_agents',
    input: {
      agents: reviewerAgents,
    },
    includeToolCall: false,
  } satisfies ToolCall<'spawn_agents'>

  const spawnedReviews = extractSpawnResults(reviewerResults)

  const reviewTexts = spawnedReviews.map((review) =>
    typeof review === 'string' ? review : `Error: ${review.errorMessage}`,
  )

  // Set output with the simplified reviews (array of strings)
  yield {
    toolName: 'set_output',
    input: {
      reviews: reviewTexts,
    },
    includeToolCall: false,
  } satisfies ToolCall<'set_output'>

  /**
   * Extracts each code-reviewer's plain-text answer, or its error, from the
   * spawn_agents tool output.
   */
  function extractSpawnResults(
    results: { type: string; value?: unknown }[] | undefined,
  ): (string | { errorMessage: string })[] {
    if (!results || results.length === 0) return []

    const jsonResult = results.find((r) => r.type === 'json')
    if (!jsonResult?.value) return []

    const spawnedResults = Array.isArray(jsonResult.value)
      ? jsonResult.value
      : [jsonResult.value]

    const extracted: (string | { errorMessage: string })[] = []
    for (const result of spawnedResults) {
      const innerValue = result?.value
      if (typeof innerValue === 'string') {
        extracted.push(innerValue)
      } else if (innerValue != null) {
        // A failed spawn ({ errorMessage }) or a reviewer that wrote no
        // answer ({ type: 'error', message }).
        extracted.push({
          errorMessage: String(innerValue.errorMessage ?? innerValue.message),
        })
      }
    }
    return extracted
  }
}

const definition = {
  ...createCodeReviewerMultiPrompt(),
  id: 'code-reviewer-multi-prompt',
}
export default definition
