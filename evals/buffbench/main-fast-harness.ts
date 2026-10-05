import fs from 'fs'
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
 *
 * A run dies with its process (an app restart kills a detached one). To finish
 * it, pass the logs directories it already wrote, comma-separated: every task
 * that has BOTH arms' result files in any of them is skipped, the rest run into
 * a new directory, and compare-arms.ts reads several directories at once.
 *
 *   bun run buffbench/main-fast-harness.ts 5 all --resume=<logsDir>[,<logsDir>]
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

/** The tasks a paired run still owes: those without both arms' results in any
 *  of the given logs directories. */
export function remainingTaskIds(params: {
  evalDataPath: string
  agents: readonly string[]
  logsDirs: readonly string[]
}): string[] {
  const { evalDataPath, agents, logsDirs } = params
  const tasks: string[] = JSON.parse(
    fs.readFileSync(evalDataPath, 'utf8'),
  ).evalCommits.map((commit: { id: string }) => commit.id)
  const done = new Map<string, Set<string>>()
  for (const dir of logsDirs) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json') || file.includes('-ANALYSIS-')) continue
      for (const agent of agents) {
        const marker = `-${agent}-`
        const at = file.indexOf(marker)
        if (at < 0) continue
        const task = file.slice(file.indexOf('-') + 1, at)
        if (!done.has(task)) done.set(task, new Set())
        done.get(task)!.add(agent)
      }
    }
  }
  return tasks.filter((task) => done.get(task)?.size !== agents.length)
}

async function main() {
  const concurrency = Number(process.argv[2] ?? '5')
  const allTasks = process.argv[3] === 'all'
  const resume = process.argv
    .find((arg) => arg.startsWith('--resume='))
    ?.slice('--resume='.length)
    .split(',')
    .filter(Boolean)
  const evalDataPath = path.join(__dirname, 'eval-codebuff.json')
  const taskIds = resume
    ? remainingTaskIds({
        evalDataPath,
        agents: FAST_HARNESS_AGENTS,
        logsDirs: resume,
      }).filter((task) => allTasks || FAST_HARNESS_TASK_IDS.includes(task))
    : allTasks
      ? undefined
      : FAST_HARNESS_TASK_IDS
  if (resume) console.log(`Resuming: ${taskIds!.length} task(s) left`)
  await runBuffBench({
    evalDataPaths: [evalDataPath],
    agents: FAST_HARNESS_AGENTS,
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
