import { describe, expect, test } from 'bun:test'

import { createCodeReviewerMultiPrompt } from '../reviewer/multi-prompt/code-reviewer-multi-prompt'

import type { AgentState, ToolCall } from '../types/agent-definition'

describe('code-reviewer-multi-prompt', () => {
  test("combines reviewers' plain-text answers and errors", () => {
    const agentState: AgentState = {
      agentId: 'code-reviewer-multi-prompt-test',
      runId: 'test-run',
      parentId: undefined,
      messageHistory: [],
      output: undefined,
      systemPrompt: '',
      toolDefinitions: {},
      contextTokenCount: 0,
    }
    const generator = createCodeReviewerMultiPrompt().handleSteps!({
      agentState,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      } as any,
      params: { prompts: ['correctness', 'style', 'security'] },
    })
    generator.next() // set_messages
    generator.next({ agentState, toolResult: undefined, stepsComplete: false }) // spawn_agents

    const result = generator.next({
      agentState,
      toolResult: [
        {
          type: 'json',
          value: [
            { agentType: 'code-reviewer-opus', value: 'Looks correct.' },
            // A spawn that failed.
            {
              agentType: 'code-reviewer-opus',
              value: { errorMessage: 'Error spawning agent: boom' },
            },
            // A reviewer that wrote no answer.
            {
              agentType: 'code-reviewer-opus',
              value: { type: 'error', message: 'No response from agent' },
            },
          ],
        },
      ],
      stepsComplete: false,
    })

    expect((result.value as ToolCall<'set_output'>).input).toEqual({
      reviews: [
        'Looks correct.',
        'Error: Error spawning agent: boom',
        'Error: No response from agent',
      ],
    })
  })
})
