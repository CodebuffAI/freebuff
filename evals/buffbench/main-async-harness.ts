import path from 'path'

import { FAST_HARNESS_TASK_IDS, remainingTaskIds } from './main-fast-harness'
import { runBuffBench } from './run-buffbench'

/**
 * base3 vs base3-async (agents/base3-async.ts) on DeepSeek V4.1 Flash, paired:
 * every arm runs each task in the same minutes, so a provider slowdown lands
 * on all of them. Analysis off, traces saved, as in main-fast-harness.ts.
 *
 *   bun run buffbench/main-async-harness.ts <concurrency> [all|ten|<id,id>]
 *     [--agents=<id,id>] [--freestyle] [--resume=<logsDir>[,<logsDir>]]
 *
 * `ten` is main-fast-harness.ts's ten tasks; the default is all 62. Read the
 * result with async-arms-report.ts.
 */
const ASYNC_HARNESS_AGENTS = [
  'base3-free-deepseek-flash-evals',
  'base3-async-free-deepseek-flash-evals',
]

async function main() {
  const concurrency = Number(process.argv[2] ?? '5')
  const selection = process.argv[3] ?? 'all'
  const flag = (name: string) =>
    process.argv
      .find((arg) => arg.startsWith(`--${name}=`))
      ?.slice(name.length + 3)
      .split(',')
      .filter(Boolean)
  const agents = flag('agents') ?? ASYNC_HARNESS_AGENTS
  const resume = flag('resume')
  const evalDataPath = path.join(__dirname, 'eval-codebuff.json')

  let taskIds: string[] | undefined =
    selection === 'all'
      ? undefined
      : selection === 'ten'
        ? FAST_HARNESS_TASK_IDS
        : selection.split(',').filter(Boolean)
  if (resume) {
    const remaining = remainingTaskIds({
      evalDataPath,
      agents,
      logsDirs: resume,
    })
    taskIds = remaining.filter((task) => !taskIds || taskIds.includes(task))
    console.log(`Resuming: ${taskIds.length} task(s) left`)
  }

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
