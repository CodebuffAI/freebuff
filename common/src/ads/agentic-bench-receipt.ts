/**
 * Bench receipts (bench-v2, B5): what one bench run of one skill version
 * found, committed next to the version as
 * `common/src/ads/sponsored-skills/<id>/<version>.bench.json` and indexed in
 * `sponsored-skills/receipts.ts`. CI checks the newest version of every skill
 * has a current one (`sponsored-skill-bench-receipt.test.ts`) and runs
 * nothing. The bench workflow that wrote receipts was removed in COD-965.
 */
import {
  benchCellPass,
  type BenchCellResult,
  type BenchExpectation,
  type BenchRunOutcome,
} from './agentic-bench-oracle'
import { dropZ } from '../util/two-proportion-z'

import type { BenchOs, BenchSurface } from './agentic-bench-env'
import type { BenchBump, BenchMode, BenchPlan } from './agentic-bench-plan'

/** Smoke and full verdicts need at least this overall `should_run` pass rate. */
export const BENCH_MIN_PASS_RATE = 0.5
/** A drop of this many points in the `should_run` rate, at z ≥ BENCH_MIN_DROP_Z, regresses. */
export const BENCH_MAX_RATE_DROP = 0.1
export const BENCH_MIN_DROP_Z = 2
/** A cell regresses when it passed before and now passes 0 of at least this many attempts. */
export const BENCH_CELL_REGRESSION_ATTEMPTS = 3

export type BenchReceiptCell = {
  id: string
  entry: string
  os: BenchOs
  surface: BenchSurface
  env: string
  expected: BenchExpectation
  attempts: number
  passes: number
  results: BenchCellResult[]
  causeKeys: string[]
  /** One `gs://codebuff-ads-evals-text/bench/…` trace per attempt, when uploaded. */
  traces?: string[]
}

export type BenchVerdict = {
  result: 'pass' | 'regressed' | 'failed'
  /** The receipt it was compared with (`<id>@<version>`), or null for a first. */
  against: string | null
  reasons: string[]
}

export type BenchReceipt = {
  v: 1
  skill: string
  /** `sponsoredSkillSha256` of the version benched; must equal its lock line. */
  skillSha256: string
  benchVersion: string
  mode: BenchMode
  bump: BenchBump
  surfaces: string[]
  createdAt: string
  labBatchIds: string[]
  actionsRunUrl: string | null
  costUsd: number | null
  static: {
    cells: number
    byExpected: Record<BenchExpectation, number>
    labelsSha256: string
    fidelity: string[]
  }
  cells: BenchReceiptCell[]
  verdict: BenchVerdict
}

const rateOf = (cells: readonly BenchReceiptCell[]) => {
  const run = cells.filter((c) => c.expected === 'should_run')
  const hits = run.reduce((n, c) => n + Math.min(c.passes, 1), 0)
  return { hits, n: run.length, rate: run.length ? hits / run.length : null }
}

/** One cell's attempts folded: a pass stops the retries, a mismatch is never forgiven. */
export function benchReceiptCell(
  cell: Pick<
    BenchReceiptCell,
    'id' | 'entry' | 'os' | 'surface' | 'env' | 'expected'
  >,
  outcomes: readonly BenchRunOutcome[],
  traces?: string[],
): BenchReceiptCell {
  const results = outcomes.map((o) => benchCellPass(cell.expected, o))
  return {
    ...cell,
    attempts: results.filter((r) => r !== 'infra').length,
    passes: results.filter((r) => r === 'pass').length,
    results,
    causeKeys: outcomes.map((o) => o.causeKey ?? 'none'),
    ...(traces?.length ? { traces } : {}),
  }
}

/**
 * A receipt's own verdict, with no previous version: no label mismatch, at
 * least one pass in every language family the skill runs on, and an overall
 * `should_run` rate of at least BENCH_MIN_PASS_RATE.
 */
export function benchOwnVerdict(
  cells: readonly BenchReceiptCell[],
  families: ReadonlyMap<string, string>,
): string[] {
  const reasons: string[] = []
  for (const cell of cells)
    if (cell.results.includes('mismatch'))
      reasons.push(
        `${cell.id}: expected ${cell.expected}, the run did the opposite`,
      )
  const run = cells.filter((c) => c.expected === 'should_run')
  const perFamily = new Map<string, number>()
  for (const cell of run) {
    const family = families.get(cell.entry) ?? 'other'
    perFamily.set(
      family,
      (perFamily.get(family) ?? 0) + Math.min(cell.passes, 1),
    )
  }
  for (const [family, passes] of perFamily)
    if (!passes) reasons.push(`No should_run cell passed for ${family}.`)
  const { rate } = rateOf(cells)
  if (rate !== null && rate < BENCH_MIN_PASS_RATE)
    reasons.push(
      `should_run pass rate ${(rate * 100).toFixed(0)}% is below ${BENCH_MIN_PASS_RATE * 100}%.`,
    )
  for (const cell of cells)
    if (cell.attempts === 0 && cell.results.length)
      reasons.push(`${cell.id}: every attempt was infra; not measured.`)
  return reasons
}

/**
 * THE regression rule between two receipts of the same skill (B5): a cell
 * regresses if it had at least one pass before and passes 0 of
 * BENCH_CELL_REGRESSION_ATTEMPTS now; the overall `should_run` rate
 * regresses when it drops BENCH_MAX_RATE_DROP or more at z ≥ BENCH_MIN_DROP_Z.
 * Only cells both receipts ran are compared.
 */
export function compareBenchReceipts(
  previous: Pick<BenchReceipt, 'skill' | 'cells'>,
  next: Pick<BenchReceipt, 'cells'>,
): { regressed: boolean; reasons: string[]; shared: number } {
  const reasons: string[] = []
  const before = new Map(previous.cells.map((c) => [c.id, c]))
  const shared = next.cells.filter((c) => before.has(c.id))
  for (const cell of shared) {
    const old = before.get(cell.id)!
    if (
      old.passes >= 1 &&
      cell.passes === 0 &&
      cell.attempts >= BENCH_CELL_REGRESSION_ATTEMPTS
    )
      reasons.push(
        `${cell.id}: passed ${old.passes}/${old.attempts} in ${previous.skill}, 0/${cell.attempts} now`,
      )
  }
  const a = rateOf(shared.map((c) => before.get(c.id)!))
  const b = rateOf(shared)
  if (a.rate !== null && b.rate !== null) {
    const drop = a.rate - b.rate
    const z = dropZ(a, b)
    if (drop >= BENCH_MAX_RATE_DROP && z >= BENCH_MIN_DROP_Z)
      reasons.push(
        `should_run rate fell ${(drop * 100).toFixed(0)} points (${(a.rate * 100).toFixed(0)}% → ${(b.rate * 100).toFixed(0)}%, z ${z.toFixed(1)})`,
      )
  }
  return { regressed: reasons.length > 0, reasons, shared: shared.length }
}

/** A receipt from a plan and its live outcomes, judged against the previous version's receipt. */
export function buildBenchReceipt(input: {
  plan: BenchPlan
  cells: BenchReceiptCell[]
  labelsSha256: string
  families: ReadonlyMap<string, string>
  previous: BenchReceipt | null
  labBatchIds: string[]
  actionsRunUrl: string | null
  costUsd: number | null
  createdAt: string
  surfaces?: string[]
}): BenchReceipt {
  const { plan } = input
  const byExpected = {
    should_run: 0,
    should_refuse: 0,
    should_fail_gracefully: 0,
  }
  for (const cell of plan.static) byExpected[cell.expected]++
  const fidelity = plan.static.flatMap((c) =>
    c.fidelity ? [`${c.id}: ${c.fidelity}`] : [],
  )
  const own = benchOwnVerdict(input.cells, input.families)
  if (fidelity.length)
    own.push(
      `${fidelity.length} static cell(s) where the fit oracle and the preflight disagree.`,
    )
  const compared = input.previous
    ? compareBenchReceipts(input.previous, { cells: input.cells })
    : null
  return {
    v: 1,
    skill: plan.skill,
    skillSha256: plan.skillSha256,
    benchVersion: plan.benchVersion,
    mode: plan.mode,
    bump: plan.bump,
    surfaces:
      input.surfaces ??
      [
        ...new Set(
          input.cells.map((c) =>
            c.surface === 'lab' ? 'lab' : `desktop-${c.os}`,
          ),
        ),
      ].sort(),
    createdAt: input.createdAt,
    labBatchIds: input.labBatchIds,
    actionsRunUrl: input.actionsRunUrl,
    costUsd: input.costUsd,
    static: {
      cells: plan.static.length,
      byExpected,
      labelsSha256: input.labelsSha256,
      fidelity,
    },
    cells: input.cells,
    verdict: {
      result: own.length
        ? 'failed'
        : compared?.regressed
          ? 'regressed'
          : 'pass',
      against: input.previous?.skill ?? null,
      reasons: [...own, ...(compared?.reasons ?? [])],
    },
  }
}

/** Markdown for a PR body, between `<!-- bench -->` markers the workflow rewrites. */
export function benchVerdictMarkdown(receipt: BenchReceipt): string {
  const lines = [
    '<!-- bench -->',
    `**Bench (${receipt.benchVersion}, ${receipt.mode}): ${receipt.verdict.result.toUpperCase()}**${receipt.verdict.against ? ` against ${receipt.verdict.against}` : ''}`,
    '',
    `Static oracle: ${receipt.static.cells} cells (${receipt.static.byExpected.should_run} should_run, ${receipt.static.byExpected.should_refuse} should_refuse, ${receipt.static.byExpected.should_fail_gracefully} should_fail_gracefully).`,
    '',
    '| Cell | Expected | Passes | Causes | Trace |',
    '| --- | --- | ---: | --- | --- |',
    ...receipt.cells.map(
      (c) =>
        `| ${c.id} | ${c.expected} | ${c.passes}/${c.attempts}${c.results.includes('mismatch') ? ' (mismatch)' : ''} | ${[...new Set(c.causeKeys)].join(', ')} | ${c.passes < c.attempts && c.traces?.length ? c.traces.map((t, i) => `[${i + 1}](${t.replace(/^gs:\/\//, 'https://storage.cloud.google.com/')})`).join(' ') : ''} |`,
    ),
    '',
    ...receipt.verdict.reasons.map((r) => `- ${r}`),
    ...(receipt.actionsRunUrl ? ['', `Run: ${receipt.actionsRunUrl}`] : []),
    '<!-- /bench -->',
  ]
  return lines.join('\n')
}

/** The body with its bench table replaced (or appended). */
export function withBenchVerdict(body: string, receipt: BenchReceipt): string {
  const table = benchVerdictMarkdown(receipt)
  const re = /<!-- bench -->[\s\S]*?<!-- \/bench -->/
  return re.test(body)
    ? body.replace(re, table)
    : `${body.trimEnd()}\n\n${table}\n`
}
