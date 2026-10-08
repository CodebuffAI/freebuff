import path from 'path'

import { runBuffBench } from './run-buffbench'

async function main() {
  const saveTraces = process.argv.includes('--save-traces')

  await runBuffBench({
    sandbox: process.argv.includes('--freestyle') ? 'freestyle' : 'local',
    evalDataPaths: [path.join(__dirname, 'eval-codebuff.json')],
    agents: ['base2-kimi-2-7-code'],
    taskIds: ['server-agent-validation'],
    saveTraces,
  })

  process.exit(0)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Error running buffbench:', error)
    process.exit(1)
  })
}
