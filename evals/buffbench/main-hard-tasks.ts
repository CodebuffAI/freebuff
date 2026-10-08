import fs from 'fs'
import path from 'path'

import { runBuffBench } from './run-buffbench'

import type { EvalDataV2 } from './types'

// Load task IDs from an eval file
function loadTaskIds(evalPath: string): string[] {
  const content = fs.readFileSync(evalPath, 'utf-8')
  const evalData: EvalDataV2 = JSON.parse(content)
  return evalData.evalCommits.map((commit) => commit.id)
}

async function main() {
  const saveTraces = process.argv.includes('--save-traces')

  const evalPaths = [
    path.join(__dirname, 'eval-codebuff2.json'),
    path.join(__dirname, 'eval-manifold2.json'),
    path.join(__dirname, 'eval-plane2.json'),
    path.join(__dirname, 'eval-saleor2.json'),
  ]

  // Load all task IDs from the eval files
  const allTaskIds = evalPaths.flatMap(loadTaskIds)

  console.log(
    `Running ${allTaskIds.length} hard tasks across ${evalPaths.length} eval sets`,
  )

  // Run all hard tasks across all 4 eval sets
  await runBuffBench({
    sandbox: process.argv.includes('--freestyle') ? 'freestyle' : 'local',
    evalDataPaths: evalPaths,
    agents: ['base2', 'external:claude'],
    taskIds: allTaskIds,
    taskConcurrency: 4,
    saveTraces,
  })

  process.exit(0)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Error running hard tasks evaluation:', error)
    process.exit(1)
  })
}
