import fs from 'fs'
import path from 'path'

import { withTimeout } from '@codebuff/common/util/promise'
import { z } from 'zod/v4'

import type { EvalCommitV2, FileDiff } from './types'
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
  /** What the judges were shown, when the input had to be shortened to fit:
   *  the sections that lost content and the sizes before and after. Absent
   *  when everything fit, which is every task but the largest few. */
  judgeInput?: {
    truncated: string[]
    sizes: Record<string, { before: number; after: number }>
  }
}

/**
 * Character budgets for the judge prompt, per section. A judge that is handed
 * 600 KB of context, ground truth and diff fails outright (no structured
 * output, or a timeout), and the tasks that fail that way are exactly the
 * large cross-cutting changes a comparison most wants scored. So the prompt
 * is built to fit: whole per-file sections in relevance order until a
 * section's budget is spent, then a list of what was left out, so the judge
 * knows the file list is complete even where the content is not. Roughly
 * four characters to a token; the total is about 90k tokens at these values.
 */
export interface JudgePromptBudget {
  /** All context files together. */
  contextChars: number
  /** Any one context file; longer files keep their head. */
  contextFileChars: number
  groundTruthChars: number
  agentDiffChars: number
  finalCheckChars: number
}

export const DEFAULT_JUDGE_BUDGET: JudgePromptBudget = {
  contextChars: 120_000,
  contextFileChars: 24_000,
  groundTruthChars: 100_000,
  agentDiffChars: 100_000,
  finalCheckChars: 16_000,
}

export interface JudgePromptInput {
  prompt: string
  fileDiffs: FileDiff[]
  contextFiles: Record<string, string>
  agentDiff: string
  error?: string
  finalCheckOutputs?: string
}

export interface BuiltJudgePrompt {
  prompt: string
  truncated: string[]
  sizes: Record<string, { before: number; after: number }>
}

interface DiffSection {
  path: string
  text: string
  added: number
  removed: number
}

/** A unified diff split into its per-file sections. A diff without
 *  `diff --git` headers is one section. */
export function splitUnifiedDiff(diff: string): DiffSection[] {
  const sections: DiffSection[] = []
  const headers = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)]
  if (headers.length === 0) {
    return diff.trim()
      ? [{ path: '(diff)', text: diff, ...countChanges(diff) }]
      : []
  }
  headers.forEach((header, i) => {
    const start = header.index!
    const end = i + 1 < headers.length ? headers[i + 1].index! : diff.length
    const text = diff.slice(start, end)
    sections.push({ path: header[2]!, text, ...countChanges(text) })
  })
  return sections
}

function countChanges(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

/**
 * Keep whole sections, most relevant first, until the budget is spent; name
 * the rest. `priority` paths (the files the other side of the comparison
 * also touched) come first, then the smallest sections, so the most files
 * fit. A single section larger than the whole budget is cut to the budget
 * with a note rather than dropped, since it may be the whole change.
 */
function fitSections(
  sections: DiffSection[],
  budget: number,
  priority: Set<string>,
  render: (section: DiffSection) => string,
): { text: string; elided: DiffSection[]; keptChars: number } {
  const ordered = [...sections].sort((a, b) => {
    const pa = priority.has(a.path) ? 0 : 1
    const pb = priority.has(b.path) ? 0 : 1
    return pa - pb || a.text.length - b.text.length
  })
  const kept: string[] = []
  const elided: DiffSection[] = []
  let used = 0
  let keptChars = 0
  for (const section of ordered) {
    const rendered = render(section)
    if (used + rendered.length <= budget) {
      kept.push(rendered)
      used += rendered.length
      keptChars += section.text.length
    } else if (kept.length === 0 && rendered.length > budget) {
      kept.push(
        `${rendered.slice(0, budget)}\n... (this file's diff continues; ${rendered.length - budget} more characters not shown)`,
      )
      used = budget
      keptChars += Math.min(section.text.length, budget)
    } else {
      elided.push(section)
    }
  }
  // Back to the diff's own order, so the judge reads it as the agent made it.
  const byPath = new Map(kept.map((text, i) => [ordered[i]!.path, text]))
  const text = sections
    .filter((section) => byPath.has(section.path))
    .map((section) => byPath.get(section.path)!)
    .join('\n\n')
  return { text, elided, keptChars }
}

const elisionList = (elided: DiffSection[]) =>
  elided
    .map((s) => `- ${s.path} (+${s.added} −${s.removed} lines, not shown)`)
    .join('\n')

/** The judge prompt, built to the budget. Pure, so a test can hold it to it. */
export function buildJudgePrompt(
  input: JudgePromptInput,
  budget: JudgePromptBudget = DEFAULT_JUDGE_BUDGET,
): BuiltJudgePrompt {
  const { prompt, fileDiffs, contextFiles, agentDiff, error } = input
  const truncated: string[] = []
  const sizes: BuiltJudgePrompt['sizes'] = {}

  // Context files: whole files until the total budget, each file capped.
  const contextEntries = Object.entries(contextFiles)
  const contextBefore = contextEntries.reduce((n, [, c]) => n + c.length, 0)
  const contextParts: string[] = []
  const contextElided: string[] = []
  let contextUsed = 0
  for (const [filePath, content] of contextEntries) {
    let body = content
    if (body.length > budget.contextFileChars) {
      const lines = body.split('\n')
      body = body.slice(0, budget.contextFileChars)
      const shownLines = body.split('\n').length
      body += `\n... (${lines.length - shownLines} more lines of this file not shown)`
    }
    const rendered = `### ${filePath}\n\`\`\`\n${body}\n\`\`\``
    if (contextUsed + body.length <= budget.contextChars) {
      contextParts.push(rendered)
      contextUsed += Math.min(body.length, content.length)
    } else {
      contextElided.push(
        `- ${filePath} (${content.split('\n').length} lines, not shown)`,
      )
    }
  }
  if (contextElided.length > 0 || contextUsed < contextBefore) {
    truncated.push('context files')
  }
  sizes['context files'] = { before: contextBefore, after: contextUsed }
  const contextFilesContent =
    contextParts.join('\n\n') +
    (contextElided.length > 0
      ? `\n\nContext files not shown for length:\n${contextElided.join('\n')}`
      : '')

  // Ground truth: whole per-file diffs, the files the agent also touched first.
  const agentSections = splitUnifiedDiff(agentDiff || '')
  const agentPaths = new Set(agentSections.map((s) => s.path))
  const truthSections: DiffSection[] = fileDiffs.map((fd) => ({
    path: fd.path,
    text: fd.diff,
    ...countChanges(fd.diff),
  }))
  const truthBefore = truthSections.reduce((n, s) => n + s.text.length, 0)
  const truth = fitSections(
    truthSections,
    budget.groundTruthChars,
    agentPaths,
    (s) => `### ${s.path}\n\`\`\`diff\n${s.text}\n\`\`\``,
  )
  if (truth.elided.length > 0 || truth.keptChars < truthBefore) {
    truncated.push('ground truth')
  }
  sizes['ground truth'] = { before: truthBefore, after: truth.keptChars }
  const groundTruthDiffs =
    truth.text +
    (truth.elided.length > 0
      ? `\n\nGround-truth files not shown for length:\n${elisionList(truth.elided)}`
      : '')

  // The agent's diff: the files the ground truth also touched first.
  const truthPaths = new Set(fileDiffs.map((fd) => fd.path))
  const agentBefore = (agentDiff || '').length
  const agent = fitSections(
    agentSections,
    budget.agentDiffChars,
    truthPaths,
    (s) => s.text,
  )
  if (agent.elided.length > 0 || agent.keptChars < agentBefore) {
    truncated.push("agent's changes")
  }
  sizes["agent's changes"] = { before: agentBefore, after: agent.keptChars }
  const agentChanges =
    (agent.text || '(No changes made)') +
    (agent.elided.length > 0
      ? `\n\`\`\`\n\nAgent files not shown for length (every changed file is listed here):\n${elisionList(agent.elided)}\n\`\`\`diff`
      : '')

  let finalCheckOutputs = input.finalCheckOutputs
  if (finalCheckOutputs && finalCheckOutputs.length > budget.finalCheckChars) {
    sizes['final checks'] = {
      before: finalCheckOutputs.length,
      after: budget.finalCheckChars,
    }
    finalCheckOutputs = `${finalCheckOutputs.slice(0, budget.finalCheckChars)}\n... (output cut for length)`
    truncated.push('final checks')
  }

  const lengthNote =
    truncated.length > 0
      ? `\n## Note on length\nTo fit your input, these sections were shortened: ${truncated.join(', ')}. Whole files were kept where possible, the most relevant first, and every file left out is named with its line counts, so the file lists are complete even where the content is not. Judge what is shown; do not count as missing anything the list says was left out.\n`
      : ''

  const built = `## User Prompt (What the agent was asked to do)
${prompt}
${lengthNote}
## Context Files (from parent commit)
${contextFilesContent || '(No context files)'}

## Ground Truth Changes (One valid implementation)
${groundTruthDiffs}

## Agent's Changes (What the agent actually did)
\`\`\`diff
${agentChanges}
\`\`\`
${error ? `\n## Error Encountered\n${error}` : ''}
${finalCheckOutputs ? `\n## Final Check Command Outputs\n${finalCheckOutputs}` : ''}`

  return { prompt: built, truncated, sizes }
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

/** Up to three attempts, with a pause before each retry: a judge that
 *  returns nothing is as often a dropped connection or a backend that would
 *  not start the run as a real refusal, and those clear in seconds rather
 *  than instantly. A task scored by one judge instead of two is a quieter
 *  failure than a task not scored at all. */
const JUDGE_RETRY_DELAYS_MS = [10_000, 45_000]

async function runSingleJudge(
  input: JudgeCommitResultInput,
  judgePrompt: string,
  judgeAgentId: string,
): Promise<JudgingResult | null> {
  for (let attempt = 0; ; attempt++) {
    const result = await runSingleJudgeOnce(input, judgePrompt, judgeAgentId)
    if (result) return result
    const delay = JUDGE_RETRY_DELAYS_MS[attempt]
    if (delay === undefined) return null
    console.warn(
      `Judge ${judgeAgentId} returned nothing; retrying in ${delay / 1000}s`,
    )
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}

async function runSingleJudgeOnce(
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

  const {
    prompt: judgePrompt,
    truncated,
    sizes,
  } = buildJudgePrompt({
    prompt: commit.prompt,
    fileDiffs: commit.fileDiffs,
    contextFiles,
    agentDiff,
    error,
    finalCheckOutputs,
  })
  if (truncated.length > 0) {
    console.warn(
      `Judge input for ${commit.id} shortened to fit: ${truncated.join(', ')} ` +
        Object.entries(sizes)
          .filter(([, v]) => v.after < v.before)
          .map(([k, v]) => `${k} ${v.before} → ${v.after}`)
          .join('; '),
    )
  }
  const judgeInput = truncated.length > 0 ? { truncated, sizes } : undefined

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
      ...(judgeInput ? { judgeInput } : {}),
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
    ...(judgeInput ? { judgeInput } : {}),
  }
}
