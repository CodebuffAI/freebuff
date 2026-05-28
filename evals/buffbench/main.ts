import path from 'path'

import { runBuffBench } from './run-buffbench'

async function main() {
  const saveTraces = process.argv.includes('--save-traces')

  // Compare Codebuff agents against external CLI agents
  // Use 'external:claude' for Claude Code CLI
  // Use 'external:codex' for OpenAI Codex CLI
  // Use 'external:opencode' for OpenCode CLI
  await runBuffBench({
    evalDataPaths: [path.join(__dirname, 'eval-codebuff.json')],
    agents: ['base2-free-deepseek'],
    taskConcurrency: 6,
    saveTraces,
  })

  process.exit(0)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Error running example:', error)
    process.exit(1)
  })
}
