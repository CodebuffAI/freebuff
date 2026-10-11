import { describe, expect, test } from 'bun:test'

import { publicRepositorySpec } from './agentic-ad-lab'
import {
  LAB_BATCH_MAX_REPOSITORIES,
  LAB_BATCH_MAX_RUNS,
  type LabBatch,
  type LabRunGrade,
} from './agentic-ad-lab-batch'
import {
  LAB_BENCH,
  compareLabBatches,
  labBatchFacetBreakdown,
  labBenchSpec,
} from './agentic-ad-lab-bench'

const grade = (tier: LabRunGrade['tier']): LabRunGrade => ({
  tier,
  causeKey: tier === 'perfect' ? 'none' : 'stuck',
  cause: '',
  stepsCompleted: null,
  stepsTotal: null,
  grader: 'model',
  rubricVersion: 'v',
})

function batch(
  tiers: Record<string, LabRunGrade['tier'][]>,
  overrides: Partial<LabBatch> = {},
): LabBatch {
  const entries = Object.keys(tiers).map(
    (fullName) => LAB_BENCH.find((e) => e.fullName === fullName)!,
  )
  return {
    id: crypto.randomUUID(),
    name: 'b',
    adName: 'ad',
    procedureSha256: 'x',
    environment: 'default',
    signup: 'decline',
    repetitions: Math.max(...Object.values(tiers).map((t) => t.length)),
    repositories: entries.map((e, i) => ({
      projectId: `p${i}-${crypto.randomUUID()}`,
      fullName: e.fullName,
      commit: e.commit,
    })),
    state: 'running',
    createdAt: '',
    runs: [],
    ...overrides,
  }
}
function graded(b: LabBatch, tiers: Record<string, LabRunGrade['tier'][]>) {
  b.runs = b.repositories.flatMap((r) =>
    tiers[r.fullName]!.map((tier, slot) => ({
      workspaceId: `${r.projectId}-${slot}`,
      projectId: r.projectId,
      slot,
      runId: `run-${r.projectId}-${slot}`,
      runStatus: 'completed',
      signup: 'declined',
      grade: grade(tier),
      probe: null,
    })),
  )
  return b
}

describe('the bench', () => {
  test('is about 25 distinct repositories, each pinned to a full SHA the lab accepts', () => {
    expect(LAB_BENCH.length).toBe(25)
    expect(LAB_BENCH.length).toBeLessThanOrEqual(LAB_BATCH_MAX_REPOSITORIES)
    // One run each fits a single batch, with room for three repetitions.
    expect(LAB_BENCH.length * 3).toBeLessThanOrEqual(LAB_BATCH_MAX_RUNS)
    const names = new Set(LAB_BENCH.map((e) => e.fullName.toLowerCase()))
    expect(names.size).toBe(LAB_BENCH.length)
    for (const entry of LAB_BENCH)
      expect(publicRepositorySpec(labBenchSpec(entry))).toEqual({
        fullName: entry.fullName,
        commit: entry.commit,
      })
  })
  test('covers every framework and package manager Desktop reports', () => {
    const frameworks = new Set(LAB_BENCH.map((e) => e.facets.framework))
    expect([...frameworks].sort()).toEqual(
      ['nextjs', 'nodejs', 'react-vite', 'unknown', 'unsupported'].sort(),
    )
    const managers = new Set(LAB_BENCH.map((e) => e.facets.packageManager))
    expect([...managers].sort()).toEqual(
      ['bun', 'npm', 'pnpm', 'unknown', 'yarn'].sort(),
    )
  })
  test('carries the four Supabase scenario repositories at their scenario commits', () => {
    for (const spec of [
      'obro79/Continuum@89857ee8d15c97571ed7411b24ef72b75754ec60',
      'obro79/stormhacks@81789291b9790159e20d62c11a3a75f8fb966fba',
      'obro79/blind-hunt@46c84f23ec6779890ba61162d6704c4ea5855bde',
      'obro79/promptetheus-service@1088e1af9859b9201a83bc2d838a9e748af2fcc6',
    ])
      expect(LAB_BENCH.map(labBenchSpec)).toContain(spec)
  })
})

describe('facet breakdown', () => {
  test('rolls each repository up under its stack, skipping unpinned repositories', () => {
    const tiers = {
      'obro79/Continuum': ['perfect', 'perfect'],
      'leerob/next-saas-starter': ['perfect', 'partial'],
      'satnaing/shadcn-admin': ['broken', 'broken'],
    } satisfies Record<string, LabRunGrade['tier'][]>
    const b = graded(batch(tiers), tiers)
    b.repositories.push({ projectId: 'x', fullName: 'acme/unpinned' })
    const rows = labBatchFacetBreakdown(b)
    expect(
      rows.find((r) => r.facet === 'framework' && r.value === 'nextjs'),
    ).toMatchObject({
      repositories: 2,
      graded: 4,
      perfect: 3,
      perfectRate: 0.75,
    })
    expect(
      rows.find((r) => r.facet === 'framework' && r.value === 'react-vite'),
    ).toMatchObject({ repositories: 1, perfectRate: 0 })
    expect(
      rows.find((r) => r.facet === 'supabase' && r.value === 'client'),
    ).toMatchObject({ repositories: 1, perfectRate: 1 })
    expect(
      rows.reduce(
        (n, r) => (r.facet === 'framework' ? n + r.repositories : n),
        0,
      ),
    ).toBe(3)
  })
})

describe('comparing two batches', () => {
  const before = {
    'obro79/Continuum': ['perfect'],
    'leerob/next-saas-starter': ['partial'],
  } satisfies Record<string, LabRunGrade['tier'][]>
  test('passes when no repository gets worse', () => {
    const after = {
      'obro79/Continuum': ['perfect'],
      'leerob/next-saas-starter': ['perfect'],
    } satisfies Record<string, LabRunGrade['tier'][]>
    const result = compareLabBatches(
      graded(batch(before), before),
      graded(batch(after), after),
    )
    expect(result.verdict).toBe('pass')
    expect(result.repositories.map((r) => r.change)).toEqual([
      'same',
      'improved',
    ])
  })
  test('fails on one repository going down even when the average goes up', () => {
    const base = {
      'obro79/Continuum': ['perfect', 'perfect'],
      'leerob/next-saas-starter': ['partial', 'partial'],
    } satisfies Record<string, LabRunGrade['tier'][]>
    const next = {
      'obro79/Continuum': ['perfect', 'broken'],
      'leerob/next-saas-starter': ['perfect', 'perfect'],
    } satisfies Record<string, LabRunGrade['tier'][]>
    const result = compareLabBatches(
      graded(batch(base), base),
      graded(batch(next), next),
    )
    expect(result.next.perfectRate).toBeGreaterThan(result.base.perfectRate!)
    expect(result.verdict).toBe('regressed')
    expect(
      result.repositories.find((r) => r.fullName === 'obro79/Continuum')
        ?.change,
    ).toBe('regressed')
  })
  test('refuses to compare batches that did not test the same thing', () => {
    const base = graded(batch(before), before)
    const otherEnv = graded(batch(before, { environment: 'node-nvm' }), before)
    expect(compareLabBatches(base, otherEnv)).toMatchObject({
      verdict: 'incomparable',
    })
    const unfinished = batch(before)
    expect(compareLabBatches(base, unfinished).reasons.join(' ')).toContain(
      'ungraded',
    )
    const unpinned = graded(batch(before), before)
    unpinned.repositories = unpinned.repositories.map(
      ({ commit: _, ...r }) => r,
    )
    expect(compareLabBatches(base, unpinned).reasons.join(' ')).toContain(
      'Not pinned',
    )
    const fewer = { 'obro79/Continuum': ['perfect'] } satisfies Record<
      string,
      LabRunGrade['tier'][]
    >
    expect(
      compareLabBatches(base, graded(batch(fewer), fewer)).reasons.join(' '),
    ).toContain('Not run in the new batch')
  })
})
