import { describe, expect, it } from 'bun:test'

import { buildJudgePrompt, judgeTraceSessionId, splitUnifiedDiff } from './judge'

import type { FileDiff } from './types'

/**
 * The judge used to be handed context, ground truth and diff whole, and on
 * the largest tasks returned nothing — the large cross-cutting changes a
 * comparison most wants scored came back 0 for both arms. The prompt is now
 * built to a budget: whole per-file sections, the most relevant first, and a
 * complete list of what was left out.
 */

const fileDiff = (path: string, lines: number): FileDiff => ({
  path,
  status: 'modified',
  diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${Array.from({ length: lines }, (_, i) => `+line ${i} of ${path}`).join('\n')}\n`,
})

const agentSection = (path: string, lines: number) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${Array.from({ length: lines }, (_, i) => `+agent line ${i} of ${path}`).join('\n')}\n`

const small = {
  prompt: 'Add the thing',
  fileDiffs: [fileDiff('src/a.ts', 3), fileDiff('src/b.ts', 2)],
  contextFiles: { 'src/a.ts': 'const a = 1\n', 'src/b.ts': 'const b = 2\n' },
  agentDiff: agentSection('src/a.ts', 3) + agentSection('src/c.ts', 1),
}

describe('splitUnifiedDiff', () => {
  it('splits on diff --git headers and counts the changed lines', () => {
    const sections = splitUnifiedDiff(small.agentDiff)
    expect(sections.map((s) => s.path)).toEqual(['src/a.ts', 'src/c.ts'])
    expect(sections[0]!.added).toBe(3)
    expect(sections[1]!.added).toBe(1)
    expect(sections.map((s) => s.text).join('')).toBe(small.agentDiff)
  })

  it('treats a headerless diff as one section and an empty one as none', () => {
    expect(splitUnifiedDiff('')).toEqual([])
    expect(
      splitUnifiedDiff('@@ -1 +1 @@\n-x\n+y\n').map((s) => s.path),
    ).toEqual(['(diff)'])
  })
})

describe('buildJudgePrompt', () => {
  it('shows everything, in order, when it fits', () => {
    const built = buildJudgePrompt(small)
    expect(built.truncated).toEqual([])
    expect(built.prompt).toContain('## User Prompt')
    expect(built.prompt).toContain('### src/a.ts\n```\nconst a = 1')
    // Both of the agent's files, whole and in the diff's own order (sections
    // are separated by a blank line in the prompt).
    const [a, c] = splitUnifiedDiff(small.agentDiff)
    expect(built.prompt).toContain(a!.text.trim())
    expect(built.prompt).toContain(c!.text.trim())
    expect(built.prompt.indexOf('b/src/a.ts')).toBeLessThan(
      built.prompt.indexOf('b/src/c.ts'),
    )
    expect(built.prompt).not.toContain('Note on length')
    expect(built.sizes["agent's changes"]).toEqual({
      before: small.agentDiff.length,
      after: small.agentDiff.length,
    })
  })

  it("keeps the agent's files that the ground truth also touched, lists the rest, stays in budget", () => {
    const agentDiff =
      agentSection('src/huge-unrelated.ts', 400) +
      agentSection('src/a.ts', 5) +
      agentSection('src/other.ts', 50)
    const built = buildJudgePrompt(
      { ...small, agentDiff },
      {
        contextChars: 100_000,
        contextFileChars: 24_000,
        groundTruthChars: 100_000,
        agentDiffChars: 3_000,
        finalCheckChars: 16_000,
      },
    )
    expect(built.truncated).toEqual(["agent's changes"])
    // The shared file is shown whole; the huge unrelated one is named, not shown.
    expect(built.prompt).toContain('+agent line 4 of src/a.ts')
    expect(built.prompt).not.toContain(
      '+agent line 399 of src/huge-unrelated.ts',
    )
    expect(built.prompt).toContain(
      '- src/huge-unrelated.ts (+400 −0 lines, not shown)',
    )
    expect(built.prompt).toContain('## Note on length')
    expect(built.sizes["agent's changes"]!.after).toBeLessThanOrEqual(3_000)
    expect(built.sizes["agent's changes"]!.before).toBe(agentDiff.length)
  })

  it('cuts a single oversized file to the budget rather than dropping the whole change', () => {
    const agentDiff = agentSection('src/only.ts', 2_000)
    const built = buildJudgePrompt(
      { ...small, agentDiff },
      {
        contextChars: 100_000,
        contextFileChars: 24_000,
        groundTruthChars: 100_000,
        agentDiffChars: 2_000,
        finalCheckChars: 16_000,
      },
    )
    expect(built.prompt).toContain('+agent line 0 of src/only.ts')
    expect(built.prompt).toContain("this file's diff continues")
    expect(built.truncated).toEqual(["agent's changes"])
  })

  it('caps each context file and the context total, naming what is left out', () => {
    const big = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join('\n')
    const built = buildJudgePrompt(
      {
        ...small,
        contextFiles: {
          'src/big.ts': big,
          'src/also-big.ts': big,
          'src/tiny.ts': 'x\n',
        },
      },
      {
        contextChars: 12_000,
        contextFileChars: 8_000,
        groundTruthChars: 100_000,
        agentDiffChars: 100_000,
        finalCheckChars: 16_000,
      },
    )
    expect(built.truncated).toEqual(['context files'])
    expect(built.prompt).toContain('more lines of this file not shown')
    expect(built.prompt).toContain('Context files not shown for length:')
    expect(built.sizes['context files']!.after).toBeLessThanOrEqual(12_000)
  })

  it('shortens ground truth the same way, the files the agent touched first', () => {
    const built = buildJudgePrompt(
      {
        ...small,
        fileDiffs: [fileDiff('src/elsewhere.ts', 300), fileDiff('src/a.ts', 4)],
      },
      {
        contextChars: 100_000,
        contextFileChars: 24_000,
        groundTruthChars: 1_200,
        agentDiffChars: 100_000,
        finalCheckChars: 16_000,
      },
    )
    expect(built.truncated).toEqual(['ground truth'])
    expect(built.prompt).toContain('+line 3 of src/a.ts')
    expect(built.prompt).toContain(
      '- src/elsewhere.ts (+300 −0 lines, not shown)',
    )
  })
})

describe('judge prompt caching', () => {
  it('puts the length note after the agent\'s changes, so the shared prefix does not depend on the run', () => {
    const big = 'x'.repeat(200)
    const built = buildJudgePrompt(
      {
        prompt: 'do it',
        fileDiffs: [{ path: 'src/a.ts', diff: `diff --git a/src/a.ts b/src/a.ts\n+${big}` } as never],
        contextFiles: { 'src/a.ts': big },
        agentDiff: `diff --git a/src/a.ts b/src/a.ts\n+${big}`,
      },
      { contextChars: 50, contextFileChars: 50, groundTruthChars: 1_000, agentDiffChars: 1_000, finalCheckChars: 100 },
    )
    expect(built.prompt).toContain('## Note on length')
    expect(built.prompt.indexOf('## Note on length')).toBeGreaterThan(
      built.prompt.indexOf("## Agent's Changes"),
    )
  })

  it('renders the ground truth identically whatever the agent touched, when it fits', () => {
    const fileDiffs = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map(
      (path) => ({ path, diff: `diff --git a/${path} b/${path}\n+line of ${path}` }) as never,
    )
    const one = buildJudgePrompt({ prompt: 'p', fileDiffs, contextFiles: {}, agentDiff: 'diff --git a/src/c.ts b/src/c.ts\n+mine' })
    const two = buildJudgePrompt({ prompt: 'p', fileDiffs, contextFiles: {}, agentDiff: 'diff --git a/src/a.ts b/src/a.ts\n+other' })
    const prefix = (s: string) => s.slice(0, s.indexOf("## Agent's Changes"))
    expect(prefix(one.prompt)).toBe(prefix(two.prompt))
  })

  it('gives every judge call on a task the same UUID-shaped trace session, distinct per judge and task', () => {
    const a = judgeTraceSessionId('commit-1', 'judge-luna')
    expect(a).toBe(judgeTraceSessionId('commit-1', 'judge-luna'))
    expect(a).not.toBe(judgeTraceSessionId('commit-2', 'judge-luna'))
    expect(a).not.toBe(judgeTraceSessionId('commit-1', 'judge-gpt-6-sol'))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
