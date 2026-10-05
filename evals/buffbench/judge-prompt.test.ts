import { describe, expect, it } from 'bun:test'

import { buildJudgePrompt, splitUnifiedDiff } from './judge'

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
