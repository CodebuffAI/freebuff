import path from 'path'

import { remainingTaskIds } from './main-fast-harness'
import { runBuffBench } from './run-buffbench'

/**
 * DeepSeek V4.1 Flash by provider: Pareto vs Luminal vs RouterPlus, the
 * three warm lanes (add DeepSeek direct with --direct).
 *
 * Same agent (base3-free-deepseek-flash-evals) on every arm; the arms differ
 * only in the one Flash lane prod web serves them from (`providerOptions.only`,
 * honoured for admins and gods in web/src/llm-api/deepseek-eval-lane.ts), so
 * each arm gets our own per-lane request shaping and no fallback. The arms
 * run PAIRED on each task, so a slow minute lands on all of them.
 *
 * Run as an admin or god account (the CLI's token), with --freestyle. NOT
 * with .env.local's CODEBUFF_API_KEY: that is the freebuff-web service
 * account, which may not pin a lane, so every arm silently gets ordinary
 * routing (2026-11-22: all three arms were served by Pareto). Pass your own
 * token as CODEBUFF_API_KEY (the Freebuff CLI keeps it in the keychain,
 * service `freebuff-cli`, name = the credentials.json path), then check the
 * arms' `message.provider` before trusting a result. Your own account is
 * METERED: the agents and the judge spend its Codebuff credits, and a 402
 * ("Out of credits") zeroes every task after it (2026-11-22: ~14 of 62 tasks
 * before the balance ran out; a full run took ~5,000 credits), so top up
 * first. --resume does NOT retry those: a failed task still writes its result
 * files, which `remainingTaskIds` counts as done. Rerun failed tasks by
 * passing their ids as the second argument (comma-separated) instead:
 *
 *   bun run buffbench/main-flash-lanes-harness.ts 5 all --freestyle
 *   bun run buffbench/main-flash-lanes-harness.ts 5 all --freestyle --resume=<logsDir>
 *   bun run buffbench/main-flash-lanes-harness.ts 5 all --freestyle --direct
 */
export const FLASH_LANE_AGENTS = [
  'base3-free-deepseek-flash-pareto-evals',
  'base3-free-deepseek-flash-luminal-evals',
  'base3-free-deepseek-flash-routerplus-evals',
]
const DIRECT_AGENT = 'base3-free-deepseek-flash-deepseek-evals'

async function main() {
  const agents = process.argv.includes('--direct')
    ? [...FLASH_LANE_AGENTS, DIRECT_AGENT]
    : FLASH_LANE_AGENTS
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
        agents,
        logsDirs: resume,
      }).filter((task) => !only || only.includes(task))
    : only
  if (resume) console.log(`Resuming: ${taskIds!.length} task(s) left`)
  await runBuffBench({
    sandbox: process.argv.includes('--freestyle') ? 'freestyle' : 'local',
    evalDataPaths: [evalDataPath],
    agents,
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
