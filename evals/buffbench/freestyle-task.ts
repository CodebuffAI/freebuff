import fs from 'fs'
import path from 'path'

import { API_KEY_ENV_VAR } from '@codebuff/common/old-constants'
import { CodebuffClient, loadLocalAgents } from '@codebuff/sdk'

import { logger } from '../logger'
import { runAgentOnCommit } from './agent-runner'
import { VM_INPUT_PATH, VM_RESULT_PATH } from './freestyle-sandbox'
import { installBinaries } from './run-buffbench'

import type { FreestyleTaskInput } from './freestyle-sandbox'

// Runs inside a Freestyle VM (freestyle-sandbox.ts): one agent on one task,
// as a local run does.
const input: FreestyleTaskInput = JSON.parse(
  fs.readFileSync(VM_INPUT_PATH, 'utf-8'),
)
// The agent shares this machine and has no business reading its task file.
fs.rmSync(VM_INPUT_PATH)

const result = await runAgentOnCommit({
  client: new CodebuffClient({ logger, apiKey: process.env[API_KEY_ENV_VAR] }),
  agentId: input.agentId,
  commit: input.task,
  repoUrl: input.repoUrl,
  initCommand: input.initCommand,
  env: { ...installBinaries(input.binInstalls).env, ...input.env },
  localAgentDefinitions: Object.values(
    await loadLocalAgents({ agentsPath: path.join(__dirname, '../../agents') }),
  ),
  printEvents: false,
  finalCheckCommands: input.finalCheckCommands,
  externalAgentType: input.externalAgentType,
})
// Read once the VM has powered off, so the write is complete by then.
fs.writeFileSync(VM_RESULT_PATH, JSON.stringify(result))
process.exit(0)
