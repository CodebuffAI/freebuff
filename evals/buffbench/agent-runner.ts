import { execSync, exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

import { withTimeout } from '@codebuff/common/util/promise'

import { withTestRepo } from '../subagents/test-repo-utils'
import { benchToolOverrides } from './tool-overrides'
import { ClaudeRunner } from './runners/claude'
import { CodebuffRunner } from './runners/codebuff'
import { CodexRunner } from './runners/codex'
import { OpenCodeRunner } from './runners/opencode'

import type { Runner, AgentStep } from './runners/runner'
import type { EvalCommitV2, FinalCheckOutput } from './types'
import type { CodebuffClient } from '@codebuff/sdk'

export type { AgentStep }

export type ExternalAgentType = 'claude' | 'codex' | 'opencode'

export async function runAgentOnCommit({
  client,
  agentId,
  commit,
  repoUrl,
  initCommand,
  env,
  localAgentDefinitions,
  printEvents,
  finalCheckCommands,
  externalAgentType,
}: {
  client: CodebuffClient
  agentId: string
  commit: EvalCommitV2
  repoUrl: string
  initCommand?: string
  env?: Record<string, string>
  localAgentDefinitions: any[]
  printEvents: boolean
  finalCheckCommands?: string[]
  externalAgentType?: ExternalAgentType
}): Promise<{
  diff: string
  contextFiles: Record<string, string>
  /** Whole task: clone, install, agent, final checks. */
  durationMs: number
  /** The agent's own run alone — the number a speed comparison should read.
   *  `durationMs` also counts the clone, the install and the final-check
   *  commands, which are the same work for every arm and dwarf a fast turn. */
  agentDurationMs?: number
  cost: number
  error?: string
  trace: AgentStep[]
  finalCheckOutputs?: FinalCheckOutput[]
}> {
  console.log(`[${commit.id}] Running agent ${agentId}...`)
  const startTime = Date.now()
  let diff = ''
  let contextFiles: Record<string, string> = {}
  let error: string | undefined
  let cost = 0
  let agentDurationMs: number | undefined
  const trace: AgentStep[] = []
  let finalCheckOutputs: FinalCheckOutput[] | undefined

  try {
    const timeoutMs = 60 * 60 * 1000 // 60 minutes
    await withTimeout(
      withTestRepo(
        {
          repoUrl,
          parentSha: commit.parentSha,
          initCommand,
          env,
        },
        async (repoDir) => {
          // Select the appropriate runner
          let runner: Runner
          if (externalAgentType === 'claude') {
            runner = new ClaudeRunner(repoDir, env)
          } else if (externalAgentType === 'codex') {
            runner = new CodexRunner(repoDir, env)
          } else if (externalAgentType === 'opencode') {
            runner = new OpenCodeRunner(repoDir, env)
          } else {
            runner = new CodebuffRunner({
              cwd: repoDir,
              env,
              client,
              agentId,
              localAgentDefinitions,
              printEvents,
              commitId: commit.id,
              parentSha: commit.parentSha,
              // No arm may read the task's own upstream (tool-overrides.ts).
              overrideTools: benchToolOverrides({ repoUrl }),
            })
          }

          console.log(
            `[${commit.id}] Running agent: ${externalAgentType || 'codebuff'}`,
          )

          const agentStart = Date.now()
          const result = await runner.run(commit.prompt)
          agentDurationMs = Date.now() - agentStart
          if (result.error) error = result.error
          trace.push(...result.steps)
          cost = result.totalCostUsd
          diff = result.diff

          const contextFilePaths = new Set<string>([
            ...commit.supplementalFiles,
            ...commit.fileDiffs.map((fd) => fd.path),
          ])
          for (const { status, path } of commit.fileDiffs) {
            if (status === 'added') {
              contextFilePaths.delete(path)
            }
          }

          for (const filePath of contextFilePaths) {
            try {
              const content = execSync(
                `git show ${commit.parentSha}:${JSON.stringify(filePath)}`,
                {
                  cwd: repoDir,
                  encoding: 'utf-8',
                  maxBuffer: 10 * 1024 * 1024,
                },
              )
              contextFiles[filePath] = content
            } catch (error) {
              contextFiles[filePath] = ''
            }
          }

          // Run final check commands if specified
          if (finalCheckCommands && finalCheckCommands.length > 0) {
            console.log(
              `[${commit.id}] Running ${finalCheckCommands.length} final check commands...`,
            )
            finalCheckOutputs = await runFinalCheckCommands(
              finalCheckCommands,
              repoDir,
              env,
            )
          }
        },
      ),
      timeoutMs,
      `Agent ${agentId} timed out after ${timeoutMs / 1000} seconds`,
    )
  } catch (e) {
    error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e)
  }

  const durationMs = Date.now() - startTime

  return {
    diff,
    contextFiles,
    durationMs,
    agentDurationMs,
    cost,
    error,
    trace,
    finalCheckOutputs,
  }
}

async function runFinalCheckCommands(
  commands: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<FinalCheckOutput[]> {
  const results: FinalCheckOutput[] = []

  for (const command of commands) {
    console.log(`  Running: ${command}`)
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        env: { ...process.env, ...env },
      })
      results.push({
        command,
        exitCode: 0,
        stdout,
        stderr,
      })
      console.log(`  ✓ Command succeeded: ${command}`)
    } catch (error: any) {
      // Command failed, but we still capture the output
      results.push({
        command,
        exitCode: error.code || 1,
        stdout: error.stdout || '',
        stderr: error.stderr || error.message || '',
      })
      console.log(`  ✗ Command failed (exit ${error.code}): ${command}`)
    }
  }

  return results
}
