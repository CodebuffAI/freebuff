import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'

import { describe, expect, it } from 'bun:test'

import { CodebuffClient } from '../client'
import { loadLocalAgents } from '../agents/load-agents'

import type { AgentOutput } from '@codebuff/common/types/session-state'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

const DEFAULT_TIMEOUT_MS = 120_000
const EXPECTED_KEYWORD = 'useActionState'
const RESEARCHER_WEB_MAX_AGENT_STEPS = 10
const RUN_LIVE_INTEGRATION = process.env.RUN_CODEBUFF_E2E === 'true'

function loadEnvValue(name: string): string | undefined {
  if (process.env[name] && process.env[name] !== 'test') {
    return process.env[name]
  }

  for (const envPath of [
    path.join(homedir(), 'codebuff', '.env.local'),
    path.join(process.cwd(), '.env.local'),
  ]) {
    if (!existsSync(envPath)) continue

    const contents = readFileSync(envPath, 'utf8')
    const match = contents.match(new RegExp(`^${name}=(.*)$`, 'm'))
    const value = match?.[1]?.trim().replace(/^['"]|['"]$/g, '')
    if (value && value !== 'test') return value
  }

  return undefined
}

function extractOutputText(output: AgentOutput): string {
  if (output.type === 'error') return output.message
  if (output.type === 'structuredOutput') {
    return JSON.stringify(output.value ?? {})
  }

  const assistantText = output.value.flatMap((message) => {
    if ((message as { role?: unknown }).role !== 'assistant') return []

    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') return [content]
    if (!Array.isArray(content)) return []

    return content.flatMap((part) => {
      if (
        part &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part
      ) {
        return [String(part.text)]
      }
      return []
    })
  })

  return assistantText.join('\n')
}

function summarizeToolTrace(events: PrintModeEvent[]): {
  readUrlCount: number
  lines: string[]
} {
  const lines: string[] = []
  let readUrlCount = 0

  for (const event of events) {
    if (event.type === 'tool_call') {
      if (event.toolName === 'web_search') {
        lines.push(`tool_call web_search query=${event.input.query}`)
      } else if (event.toolName === 'read_url') {
        readUrlCount += 1
        lines.push(`tool_call read_url url=${event.input.url}`)
      } else {
        lines.push(`tool_call ${event.toolName}`)
      }
      continue
    }

    if (event.type !== 'tool_result') continue

    const output = event.output[0]
    const value = output?.type === 'json' ? output.value : undefined
    if (!value || typeof value !== 'object') {
      lines.push(`tool_result ${event.toolName} empty`)
      continue
    }

    if (event.toolName === 'read_url') {
      const result = value as {
        url?: string
        finalUrl?: string
        status?: number
        title?: string
        text?: string
        truncated?: boolean
        errorMessage?: string
      }
      if (result.errorMessage) {
        lines.push(`tool_result read_url error=${result.errorMessage}`)
      } else {
        lines.push(
          [
            'tool_result read_url',
            `status=${result.status}`,
            `finalUrl=${result.finalUrl}`,
            `title=${JSON.stringify(result.title ?? '')}`,
            `textChars=${result.text?.length ?? 0}`,
            `truncated=${result.truncated ?? false}`,
          ].join(' '),
        )
      }
    } else if (event.toolName === 'web_search') {
      const result = value as { result?: string; errorMessage?: string }
      lines.push(
        result.errorMessage
          ? `tool_result web_search error=${result.errorMessage}`
          : `tool_result web_search chars=${result.result?.length ?? 0}`,
      )
    }
  }

  return { readUrlCount, lines }
}

describe('researcher-web SDK integration', () => {
  it(
    `runs researcher-web through the SDK and answers with ${EXPECTED_KEYWORD}`,
    async () => {
      if (!RUN_LIVE_INTEGRATION) {
        console.log(
          'Skipping researcher-web SDK integration test: set RUN_CODEBUFF_E2E=true and CODEBUFF_API_KEY to run.',
        )
        return
      }

      const apiKey = loadEnvValue('CODEBUFF_API_KEY')
      if (!apiKey) {
        console.log(
          'Skipping researcher-web SDK integration test: set RUN_CODEBUFF_E2E=true and CODEBUFF_API_KEY to run.',
        )
        return
      }

      const agentsPath = path.resolve(
        import.meta.dir,
        '../../../agents/researcher',
      )
      const loadedAgents = await loadLocalAgents({ agentsPath })
      const researcherWeb = loadedAgents['researcher-web']
      expect(researcherWeb).toBeDefined()

      const events: PrintModeEvent[] = []
      const client = new CodebuffClient({
        apiKey,
        cwd: process.cwd(),
      })

      const result = await client.run({
        agent: 'researcher-web',
        agentDefinitions: [researcherWeb],
        maxAgentSteps: RESEARCHER_WEB_MAX_AGENT_STEPS,
        handleEvent: (event) => {
          events.push(event)
        },
        prompt: [
          'Use web search to answer this React docs question.',
          'Then use read_url to verify the hook signature on the one official React reference page.',
          'In React 19, which hook returns state, a form action, and an isPending value for form actions?',
          'Answer with the exact hook name and one short sentence.',
        ].join(' '),
      })

      const outputText = extractOutputText(result.output)
      const trace = summarizeToolTrace(events)
      console.log(
        [
          'researcher-web SDK trace:',
          ...trace.lines.map((line) => `  ${line}`),
          `read_url fetch count: ${trace.readUrlCount}`,
        ].join('\n'),
      )
      console.log('researcher-web SDK output:', outputText)

      expect(result.output.type).not.toBe('error')
      expect(outputText).toContain(EXPECTED_KEYWORD)
      expect(events.some((event) => event.type === 'tool_call')).toBe(true)
      expect(
        events.some(
          (event) =>
            event.type === 'tool_call' && event.toolName === 'web_search',
        ),
      ).toBe(true)
      expect(
        events.some(
          (event) =>
            event.type === 'tool_call' && event.toolName === 'read_url',
        ),
      ).toBe(true)
    },
    DEFAULT_TIMEOUT_MS,
  )
})
