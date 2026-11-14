import path from 'path'

import { remainingTaskIds } from './main-fast-harness'
import { runBuffBench } from './run-buffbench'

/**
 * DeepSeek V4.1 Flash by provider: Pareto vs Luminal vs DeepSeek direct.
 *
 * Same agent (base3-free-deepseek-flash-evals), three arms that differ only in
 * the one Flash lane prod web serves them from (`providerOptions.only`,
 * honoured for admins and gods in web/src/llm-api/deepseek-eval-lane.ts), so
 * each arm gets our own per-lane request shaping and no fallback. The arms
 * run PAIRED on each task, so a slow minute lands on all three.
 *
 * Run as an admin or god account (the CLI's token), with --freestyle:
 *
 *   bun run buffbench/main-flash-lanes-harness.ts 5 all --freestyle
 *   bun run buffbench/main-flash-lanes-harness.ts 5 all --freestyle --resume=<logsDir>
 */
export const FLASH_LANE_AGENTS = [
  'base3-free-deepseek-flash-pareto-evals',
  'base3-free-deepseek-flash-luminal-evals',
  'base3-free-deepseek-flash-deepseek-evals',
]

async function main() {
  const concurrency = Number(process.argv[2] ?? '5')
  const only = process.argv[3] && process.argv[3] !== 'all'
    ? process.argv[3].split(',')
    : undefined
  const resume = process.argv
    .find((arg) => arg.startsWith('--resume='))
    ?.slice('--resume='.length)
    .split(',')
    .filter(Boolean)
  const evalDataPath = path.join(__dirname, 'eval-codebuff.json')
  const taskIds = resume
    ? remainingTaskIds({
        evalDataPath,
        agents: FLASH_LANE_AGENTS,
        logsDirs: resume,
      }).filter((task) => !only || only.includes(task))
    : only
  if (resume) console.log(`Resuming: ${taskIds!.length} task(s) left`)
  await runBuffBench({
    sandbox: process.argv.includes('--freestyle') ? 'freestyle' : 'local',
    evalDataPaths: [evalDataPath],
    agents: FLASH_LANE_AGENTS,
    taskIds,
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
