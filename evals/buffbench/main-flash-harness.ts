import path from 'path'

import { runBuffBench } from './run-buffbench'

/**
 * base2 vs base3 on DeepSeek V4 Flash 07/31 — the Freebuff free-tier model.
 *
 * The arms run as two separate sweeps rather than paired per task, so each
 * agent gets the full concurrency to itself. Analysis is off: the trace and
 * meta analyzers are extra model calls that say nothing about the score.
 */
const TASK_IDS = [
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

async function main() {
  for (const agent of [
    'base2-free-deepseek-flash-evals',
    'base3-free-deepseek-flash-evals',
  ]) {
    console.log(`\n########## SWEEP: ${agent} ##########\n`)
    await runBuffBench({
      sandbox: process.argv.includes('--freestyle') ? 'freestyle' : 'local',
      evalDataPaths: [path.join(__dirname, 'eval-codebuff.json')],
      agents: [agent],
      taskIds: TASK_IDS,
      taskConcurrency: 10,
      disableAnalysis: true,
    })
  }

  process.exit(0)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Error running buffbench:', error)
    process.exit(1)
  })
}
