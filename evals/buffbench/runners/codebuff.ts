import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

import type { Runner, RunnerResult, AgentStep } from './runner'
import type { CodebuffClient, TerminalCommandBroker } from '@codebuff/sdk'


const DEBUG_ERROR = true

export class CodebuffRunner implements Runner {
  private cwd: string
  private env?: Record<string, string>
  private client: CodebuffClient
  private agentId: string
  private localAgentDefinitions: any[]
  private printEvents: boolean
  private commitId: string
  private parentSha: string
  private terminalCommandBroker?: TerminalCommandBroker
  private overrideTools?: Parameters<CodebuffClient['run']>[0]['overrideTools']
  private collectDiff: boolean

  constructor(options: {
    cwd: string
    env?: Record<string, string>
    client: CodebuffClient
    agentId: string
    localAgentDefinitions: any[]
    printEvents: boolean
    commitId: string
    parentSha: string
    terminalCommandBroker?: TerminalCommandBroker
    overrideTools?: Parameters<CodebuffClient['run']>[0]['overrideTools']
    collectDiff?: boolean
  }) {
    this.cwd = options.cwd
    // Eval JSON can contain numeric or boolean values despite its TS type.
    this.env =
      options.env &&
      Object.fromEntries(
        Object.entries(options.env).map(([key, value]) => [key, String(value)]),
      )
    this.client = options.client
    this.agentId = options.agentId
    this.localAgentDefinitions = options.localAgentDefinitions
    this.printEvents = options.printEvents
    this.commitId = options.commitId
    this.parentSha = options.parentSha
    this.terminalCommandBroker = options.terminalCommandBroker
    this.overrideTools = options.overrideTools
    this.collectDiff = options.collectDiff ?? true
  }

  async run(prompt: string): Promise<RunnerResult> {
    const steps: AgentStep[] = []
    let totalCostUsd = 0

    const maxAgentSteps = 40
    const result = await this.client.run({
      agent: this.agentId,
      prompt,
      agentDefinitions: this.localAgentDefinitions,
      cwd: this.cwd,
      env: this.env,
      terminalCommandBroker: this.terminalCommandBroker,
      overrideTools: this.overrideTools,
      fileFilter: (filePath) => ({
        status:
          path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes('..')
            ? 'blocked'
            : 'allow',
      }),
      maxAgentSteps,
      handleEvent: (event) => {
        if (
          (event.type === 'tool_call' || event.type === 'tool_result') &&
          event.toolName === 'set_messages'
        ) {
          return
        }
        if (event.type === 'error') {
          console.error(
            `[${this.commitId}:${this.agentId}] Error event:`,
            event.message,
          )
          if (DEBUG_ERROR && !event.message.startsWith('Invalid JSON')) {
            // Save errors in a file, but not tool calls with invalid json.
            fs.writeFileSync(
              path.join(
                __dirname,
                '..',
                `${this.commitId}-${this.agentId}-error-${Math.random().toString(36).substring(2, 6)}.json`,
              ),
              JSON.stringify(
                {
                  error: event.message,
                  trace: steps,
                },
                null,
                2,
              ),
            )
          }
        } else if (this.printEvents) {
          console.log(
            `[${this.commitId}:${this.agentId}]`,
            JSON.stringify(event, null, 2),
          )
        }
        steps.push(event)
      },
    })

    if (result.output.type === 'error') {
      console.error(
        `[${this.commitId}:${this.agentId}] Error:`,
        result.output.message,
      )
      if (DEBUG_ERROR) {
        // Save errors in a file, but not tool calls with invalid json.
        fs.writeFileSync(
          path.join(
            __dirname,
            '..',
            `${this.commitId}-${this.agentId}-error-${Math.random().toString(36).substring(2, 6)}.json`,
          ),
          JSON.stringify(
            {
              ...result.output,
              trace: steps,
            },
            null,
            2,
          ),
        )
      }
    }

    totalCostUsd = (result.sessionState?.mainAgentState.creditsUsed ?? 0) / 100

    // Get git diff after Codebuff has made changes. Sponsored evals disable
    // this host-side path and collect through their scrubbed OS broker instead.
    let diff = ''
    if (this.collectDiff) {
      try {
        execSync('git add .', { cwd: this.cwd, stdio: 'ignore' })
        diff = execSync(`git diff ${this.parentSha}`, {
          cwd: this.cwd,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
        })
      } catch {
        // Ignore git errors
      }
    }

    return {
      steps,
      totalCostUsd,
      diff,
    }
  }
}
