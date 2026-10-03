import path from 'path'

import { runBuffBench } from './run-buffbench'

/**
 * base3 vs base3-fast on DeepSeek V4.1 Flash, provider-matched.
 *
 * Both arms run the ordinary Flash wire id as a paid caller of the live API,
 * which enters the DeepSeek cascade on DeepSeek direct — the lane the
 * fast-mode row is pinned to in production — so the harness is the only
 * variable. The arms run PAIRED (both agents on each task, in the same
 * minutes) rather than as two sweeps, so a provider slowdown lands on both
 * sides of every timing comparison. Analysis is off: the trace and meta
 * analyzers are extra model calls that say nothing about the score. Traces
 * are saved for the read-through that follows the numbers.
 *
 * Same ten tasks as main-flash-harness.ts, so the result reads against the
 * base2/base3 numbers in docs/freebuff-base3-harness.md. Pass `all` as the
 * second argument to run every task in the eval file instead:
 *
 *   bun run buffbench/main-fast-harness.ts 5 all
 */
export const FAST_HARNESS_TASK_IDS = [
  'add-sdk-terminal',
  'fix-agent-steps',
  'add-sidebar-fades',
  'validate-custom-tools',
  'extract-agent-parsing',
  'add-reasoning-options',
  'enhance-docs-nav',
  'autodetect-knowledge',
  'type-client-tools',
  'add-run-state-helpers',
]

export const FAST_HARNESS_AGENTS = [
  'base3-free-deepseek-flash-evals',
  'base3-fast-free-deepseek-flash-evals',
]

async function main() {
  const concurrency = Number(process.argv[2] ?? '5')
  const allTasks = process.argv[3] === 'all'
  await runBuffBench({
    evalDataPaths: [path.join(__dirname, 'eval-codebuff.json')],
    agents: FAST_HARNESS_AGENTS,
    taskIds: allTasks ? undefined : FAST_HARNESS_TASK_IDS,
    taskConcurrency: concurrency,
    disableAnalysis: true,
    saveTraces: true,
  })

  process.exit(0)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Error running buffbench:', error)
    process.exit(1)
  })
}
