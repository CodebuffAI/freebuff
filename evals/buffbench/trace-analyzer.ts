import { getErrorObject } from '@codebuff/common/util/error'
import { withTimeout } from '@codebuff/common/util/promise'

import { truncateTrace } from './trace-utils'

import type { AgentStep } from './agent-runner'
import type { JudgingResult } from './judge'
import type { FinalCheckOutput } from './types'
import type { AgentDefinition, CodebuffClient } from '@codebuff/sdk'



export interface AgentTraceData {
  agentId: string
  commitSha: string
  prompt: string
  trace: AgentStep[]
  diff: string
  judgeResult: JudgingResult
  cost: number
  durationMs: number
  /** The agent's own run alone; see agent-runner.ts. */
  agentDurationMs?: number
  error?: string
  timestamp: string
  finalCheckOutputs?: FinalCheckOutput[]
}

const traceAnalyzerAgent: AgentDefinition = {
  id: 'trace-analyzer',
  displayName: 'Trace Analyzer',
  model: 'openai/gpt-5',
  toolNames: ['set_output'],
  inputSchema: {
    prompt: { type: 'string', description: 'The analysis prompt' },
  },
  outputMode: 'structured_output',
  outputSchema: {
    type: 'object',
    properties: {
      overallAnalysis: {
        type: 'string',
        description: 'Overall comparison of all agents',
      },
      agentFeedback: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            agentId: { type: 'string' },
            strengths: {
              type: 'array',
              items: { type: 'string' },
            },
            weaknesses: {
              type: 'array',
              items: { type: 'string' },
            },
            recommendations: {
              type: 'array',
              items: { type: 'string' },
              description:
                "Recommendations for improving this agent and it's process. Note: do not include recommendations for improving the code in this task",
            },
          },
          required: ['agentId', 'strengths', 'weaknesses', 'recommendations'],
        },
      },
    },
    required: ['overallAnalysis', 'agentFeedback'],
  },
  systemPrompt: `You are an expert AI agent evaluator analyzing how different coding agents approach problems and make decisions.

## Your Role

You will receive:
1. Complete agent definitions showing their configuration, tools, prompts, and capabilities
2. Agent type definitions explaining the available options and structure
3. A task prompt (for context only)
4. Full traces from each agent showing their step-by-step process
5. Performance metrics (scores, cost, time, errors)

## Focus on Agent Processes

Your analysis should focus on how agents work, not what they accomplished:

Key Analysis Areas:
- Agent Configuration: How did the agent's configuration (tools, model, prompts, etc.) influence their behavior?
- Problem-Solving Approach: How did each agent break down and approach the problem?
- Tool Usage Patterns: Which tools did they use, in what sequence, and why? Compare to available tools in their config.
- Decision-Making Strategy: What information did they gather before acting? How did they validate assumptions?
- Workflow Efficiency: Did they follow a systematic process or jump around? Were steps logically ordered?
- Context Gathering: How thoroughly did they explore the codebase before making changes?
- Iterative Refinement: Did they test, verify, or refine their work? How?
- Prompt Engineering: How well did the agent's system/instructions/step prompts guide their behavior?

## Output Format

Provide:
- Overall Analysis: Compare agent workflows, highlighting different process strategies
- Agent Feedback: For each agent:
  - Strengths: Process steps that worked well (e.g., thoroughly explored codebase before editing)
  - Weaknesses: Process gaps or inefficiencies (e.g., made changes without reading related files)
  - Relative Performance: How this agent's process compared to others
- Recommendations: Generalizable improvements to agent workflows and decision-making processes

Important: Focus on the agent's process and methodology, not on the object-level content of the code changes. We want to understand how to improve the agent's approach to any problem.

Note: read_files tool results show [TRUNCATED] for file contents to save space.`,
}

export async function analyzeAgentTraces({
  client,
  traces,
  codingAgentPrompt,
  analyzerContext,
}: {
  client: CodebuffClient
  traces: AgentTraceData[]
  codingAgentPrompt: string
  analyzerContext: {
    agentDefinitions: any[]
    agentTypeDefinition: string
    testedAgentIds: string[]
  }
}): Promise<{
  overallAnalysis: string
  agentFeedback: Array<{
    agentId: string
    strengths: string[]
    weaknesses: string[]
    recommendations: string[]
  }>
}> {
  try {
    const truncatedTraces = traces.map((t) => ({
      agentId: t.agentId,
      trace: truncateTrace(t.trace),
      judgeResult: t.judgeResult,
      cost: t.cost,
      durationMs: t.durationMs,
      error: t.error,
    }))

    // Filter agent definitions to only include tested agents
    const filteredAgentDefinitions = analyzerContext.agentDefinitions.filter(
      (def) => analyzerContext.testedAgentIds.includes(def.id),
    )

    const prompt = `## Agent Definitions Being Evaluated

Below are the complete agent definitions for the agents being tested. Use this to understand their configuration, tools, prompts, and capabilities.

${JSON.stringify(filteredAgentDefinitions, null, 2)}

## Agent Type Definition Reference

For reference, here is the TypeScript type definition that agents use:

\`\`\`typescript
${analyzerContext.agentTypeDefinition}
\`\`\`

## Coding Agent Prompt (for context)
${codingAgentPrompt}

## Agent Traces and Results
${JSON.stringify(truncatedTraces, null, 2)}

Analyze how these agents approached the problem, focusing on their processes and workflows rather than the specific task:

1. Overall Process Comparison: How did agents differ in their problem-solving approach?
   - What was their overall strategy/workflow?
   - How did they sequence their actions?
   - What patterns emerged in how they gathered context vs. taking action?

2. Per-Agent Process Analysis: For each agent, identify:
   - Process strengths: What systematic steps or decisions worked well?
   - Process weaknesses: Where did their workflow have gaps or inefficiencies?
   - Key differences: How did this agent's process differ from others?

3. Generalizable Recommendations: Suggest improvements to agent workflows that would help on any task:
   - Better context-gathering strategies
   - More effective tool usage patterns
   - Improved decision-making processes
   - Workflow optimizations

Focus on the HOW, not the WHAT: We want to understand and improve how agents work, not evaluate their specific code output.`

    const agentOutput: string[] = []
    const analyzerResult = await withTimeout(
      client.run({
        agent: 'trace-analyzer',
        prompt,
        agentDefinitions: [traceAnalyzerAgent],
        handleEvent: (event) => {
          if (event.type === 'text') {
            agentOutput.push(event.text)
          } else if (event.type === 'tool_call') {
            agentOutput.push(JSON.stringify(event, null, 2))
          } else if (event.type === 'error') {
            console.warn('[Trace Analyzer] Error event:', event.message)
          }
        },
      }),
      20 * 60 * 1000,
      'Trace analyzer agent timed out after 20 minutes',
    )

    const { output } = analyzerResult

    if (output.type !== 'structuredOutput' || output.value === null) {
      console.error(
        'Error running trace analyzer - not structured output',
        JSON.stringify(output, null, 2),
      )
      console.error('Trace analyzer output trace:', agentOutput.join(''))
      return {
        overallAnalysis: 'Error running trace analyzer - not structured output',
        agentFeedback: [],
      }
    }

    return output.value as any
  } catch (error) {
    console.error(`Failed to analyze traces:`, getErrorObject(error))
    return {
      overallAnalysis: `Error running trace analyzer: ${getErrorObject(error).message}`,
      agentFeedback: [],
    }
  }
}
