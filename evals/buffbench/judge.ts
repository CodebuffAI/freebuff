import fs from 'fs'
import path from 'path'

import { withTimeout } from '@codebuff/common/util/promise'
import { z } from 'zod/v4'

import type { EvalCommitV2 } from './types'
import type { AgentDefinition, CodebuffClient } from '@codebuff/sdk'

const DEBUG_ERROR = true

export const JudgingResultSchema = z.object({
  analysis: z
    .string()
    .describe('Detailed analysis comparing agent changes to ground truth'),
  strengths: z
    .array(z.string())
    .describe('Key strengths of the implementation'),
  weaknesses: z.array(z.string()).describe('Key weaknesses or issues found'),
  completionScore: z
    .number()
    .min(0)
    .max(10)
    .describe('How completely the prompt was addressed'),
  codeQualityScore: z
    .number()
    .min(0)
    .max(10)
    .describe('Code structure and maintainability'),
  overallScore: z.number().min(0).max(10).describe('Combined assessment'),
})

export type JudgingResult = z.infer<typeof JudgingResultSchema>

/** One judge's own verdict, kept alongside the panel average. */
export interface JudgeScore {
  judgeId: string
  overallScore?: number
  completionScore?: number
  codeQualityScore?: number
  failed?: boolean
}

/** The panel's aggregate, plus what each judge said before averaging. */
export type PanelJudgingResult = JudgingResult & {
  judgeScores?: JudgeScore[]
}

const judgeAgentBase: Omit<AgentDefinition, 'id' | 'model'> = {
  displayName: 'Judge',
  toolNames: ['set_output'],
  inputSchema: {
    prompt: { type: 'string', description: 'The evaluation prompt' },
  },
  outputMode: 'structured_output',
  outputSchema: {
    type: 'object',
    properties: {
      analysis: {
        type: 'string',
        description:
          'Detailed analysis comparing agent changes to ground truth',
      },
      strengths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Key strengths of the implementation',
      },
      weaknesses: {
        type: 'array',
        items: { type: 'string' },
        description: 'Key weaknesses or issues found',
      },
      completionScore: {
        type: 'number',
        minimum: 0,
        maximum: 10,
        description: 'How completely the prompt was addressed',
      },
      codeQualityScore: {
        type: 'number',
        minimum: 0,
        maximum: 10,
        description: 'Code structure and maintainability',
      },
      overallScore: {
        type: 'number',
        minimum: 0,
        maximum: 10,
        description: 'Combined assessment',
      },
    },
    required: [
      'analysis',
      'strengths',
      'weaknesses',
      'completionScore',
      'codeQualityScore',
      'overallScore',
    ],
  },
  systemPrompt: `You are an expert software engineer evaluating AI-generated code changes with empathy for the task given.

## Your Role

You will receive:
1. The user prompt that the coding agent was given
2. Context files from the codebase
3. The ground truth changes (expected outcome)
4. The agent's actual changes

## Evaluation Philosophy

**Judge based on what the agent was asked to do, not on perfection.**

- If the prompt is vague or high-level (e.g., "add authentication"), be lenient and accept any reasonable implementation that achieves the goal
- If the prompt is specific and detailed, expect the implementation to match those details more closely
- Focus on whether the agent understood and addressed the user's intent
- Consider that there are often multiple valid ways to implement the same feature

## Evaluation Criteria

- **Completion** (0-10): How well did the agent address what was asked in the prompt? Consider the specificity of the prompt.
- **Code Quality** (0-10): How well-structured and maintainable is the code?
- **Overall** (0-10): Combined assessment of whether the agent successfully completed the task as requested

## Ground Truth

The ground truth shows ONE valid implementation, but it's not the only correct answer. The agent's implementation should be judged on:
- Does it achieve the same functional outcome?
- Is it a reasonable approach given the prompt?
- Does it maintain code quality?

Provide detailed analysis, strengths, weaknesses, and numerical scores.`,
}

const judgeAgents: Record<string, AgentDefinition> = {
  'judge-gpt': {
    id: 'judge-gpt',
    model: 'openai/gpt-5.4',
    ...judgeAgentBase,
  },
  'judge-gpt-6-sol': {
    id: 'judge-gpt-6-sol',
    model: 'openai/gpt-6-sol',
    ...judgeAgentBase,
  },
  'judge-gemini': {
    id: 'judge-gemini',
    model: 'google/gemini-3.1-pro-preview',
    ...judgeAgentBase,
  },
  'judge-sonnet': {
    id: 'judge-sonnet',
    model: 'anthropic/claude-sonnet-4.6',
    ...judgeAgentBase,
  },
}

/**
 * The judges that actually score a run.
 *
 * Not judge-gemini: Gemini Pro is gated to the gemini-thinker subagent
 * server-side, so that judge 403s with free_mode_gemini_thinker_required on
 * every task. It failed silently for a long time — failures are dropped and the
 * remaining judge still reports a confident number — which meant scores billed
 * as a median were really one model's opinion.
 *
 * judge-gpt-6-sol replaced judge-gpt (gpt-5.4) on 2026-09-26: the stronger
 * judge, and gpt-5.4 had failed every task of that day's runs on OpenAI
 * credits, leaving sonnet alone. judge-gpt stays defined for old logs.
 */
const ACTIVE_JUDGE_IDS = ['judge-gpt-6-sol', 'judge-sonnet'] as const

interface JudgeCommitResultInput {
  client: CodebuffClient
  commit: EvalCommitV2
  contextFiles: Record<string, string>
  agentDiff: string
  error?: string
  finalCheckOutputs?: string
}

async function runSingleJudge(
  input: JudgeCommitResultInput,
  judgePrompt: string,
  judgeAgentId: string,
): Promise<JudgingResult | null> {
  const { client } = input

  const judgeAgent = judgeAgents[judgeAgentId]
  const agentOutput: string[] = []
  try {
    const judgeResult = await withTimeout(
      client.run({
        agent: judgeAgent.id,
        prompt: judgePrompt,
        agentDefinitions: Object.values(judgeAgents),
        handleEvent: (event) => {
          if (event.type === 'text') {
            agentOutput.push(event.text)
          } else if (event.type === 'tool_call') {
            agentOutput.push(JSON.stringify(event, null, 2))
          } else if (event.type === 'error') {
            console.warn(`[Judge ${judgeAgentId}] Error event:`, event.message)
          }
        },
      }),
      20 * 60 * 1000,
      'Judge agent timed out after 20 minutes',
    )

    if (judgeResult.output.type !== 'structuredOutput') {
      console.error(
        `Judge ${judgeAgentId} - not structured output`,
        JSON.stringify(judgeResult.output, null, 2),
      )
      console.error(
        'Judge agent output:',
        JSON.stringify(judgeResult.output, null, 2),
        'Judge agent output trace:',
        agentOutput.join(''),
      )
      if (DEBUG_ERROR) {
        fs.writeFileSync(
          path.join(
            __dirname,
            '..',
            `${input.commit.id}-${judgeAgentId}-agent-output-error.json`,
          ),
          JSON.stringify(
            { output: judgeResult.output, trace: agentOutput },
            null,
            2,
          ),
        )
      }
      return null
    }

    return judgeResult.output.value as JudgingResult
  } catch (error) {
    console.warn(`Judge ${judgeAgentId} failed:`, error)
    return null
  }
}

export async function judgeCommitResult(
  input: JudgeCommitResultInput,
): Promise<PanelJudgingResult> {
  const { commit, contextFiles, agentDiff, error, finalCheckOutputs } = input

  const { prompt, fileDiffs } = commit

  const groundTruthDiffs = fileDiffs
    .map(({ path, diff }) => {
      return `### ${path}\n\`\`\`diff\n${diff}\n\`\`\``
    })
    .join('\n\n')

  const contextFilesContent = Object.entries(contextFiles)
    .map(([filePath, content]) => {
      return `### ${filePath}\n\`\`\`\n${content}\n\`\`\``
    })
    .join('\n\n')

  const judgePrompt = `## User Prompt (What the agent was asked to do)
${prompt}

## Context Files (from parent commit)
${contextFilesContent || '(No context files)'}

## Ground Truth Changes (One valid implementation)
${groundTruthDiffs}

## Agent's Changes (What the agent actually did)
\`\`\`diff
${agentDiff || '(No changes made)'}
\`\`\`
${error ? `\n## Error Encountered\n${error}` : ''}
${finalCheckOutputs ? `\n## Final Check Command Outputs\n${finalCheckOutputs}` : ''}`

  const judgeResults = await Promise.all(
    ACTIVE_JUDGE_IDS.map((judgeAgentId) =>
      runSingleJudge(input, judgePrompt, judgeAgentId),
    ),
  )
  const validResults = judgeResults.filter(
    (result): result is JudgingResult => result !== null,
  )

  // A dead judge used to vanish into a console.warn, leaving a "median" that
  // was really a single model's score. Say so loudly instead.
  const failedJudges = ACTIVE_JUDGE_IDS.filter((_, i) => !judgeResults[i])
  if (failedJudges.length > 0 && validResults.length > 0) {
    console.warn(
      `⚠️  Judge panel degraded for ${commit.id}: ${failedJudges.join(', ')} failed. ` +
        `Scoring from ${validResults.length}/${ACTIVE_JUDGE_IDS.length} judges.`,
    )
  }

  if (validResults.length === 0) {
    console.error('All judges failed to provide results')
    return {
      analysis: 'Error running judge agent - all judges failed',
      strengths: [],
      weaknesses: ['All judges failed to provide structured output'],
      completionScore: 0,
      codeQualityScore: 0,
      overallScore: 0,
    }
  }

  // Keep what each judge said on its own. The averages hide disagreement, and
  // a panel that splits 8 vs 4 on the same diff is worth knowing about.
  const judgeScores = ACTIVE_JUDGE_IDS.map((judgeId, i) => {
    const result = judgeResults[i]
    return result
      ? {
          judgeId,
          overallScore: result.overallScore,
          completionScore: result.completionScore,
          codeQualityScore: result.codeQualityScore,
        }
      : { judgeId, failed: true }
  })

  // Sort judges by overall score and select the median for analysis
  const sortedResults = validResults.sort(
    (a, b) => a.overallScore - b.overallScore,
  )
  const medianIndex = Math.floor(sortedResults.length / 2)
  const medianResult = sortedResults[medianIndex]

  // Calculate average scores across all valid judges
  const averageCompletionScore =
    validResults.reduce((sum, r) => sum + r.completionScore, 0) /
    validResults.length
  const averageCodeQualityScore =
    validResults.reduce((sum, r) => sum + r.codeQualityScore, 0) /
    validResults.length
  const averageOverallScore =
    validResults.reduce((sum, r) => sum + r.overallScore, 0) /
    validResults.length

  console.log(
    `Judging results overall score: ${averageOverallScore.toFixed(1)} (individual scores: ${validResults.map((r) => r.overallScore.toFixed(1)).join(', ')})`,
  )

  // Return median judge's analysis with averaged scores
  return {
    analysis: medianResult.analysis,
    strengths: medianResult.strengths,
    weaknesses: medianResult.weaknesses,
    completionScore: averageCompletionScore,
    codeQualityScore: averageCodeQualityScore,
    overallScore: averageOverallScore,
    judgeScores,
  }
}
