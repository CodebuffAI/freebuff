import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { CodebuffClient } from '../client'
import * as mcpClientModule from '@codebuff/common/mcp/client'
import * as databaseModule from '../impl/database'

import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { MCPConfig } from '@codebuff/common/types/mcp'

const browserMcpConfig: MCPConfig = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'fake-mcp-server'],
  env: {},
}

const TEST_AGENT: AgentDefinition = {
  id: 'mcp-filter-agent',
  displayName: 'MCP Filter Agent',
  model: 'openai/gpt-5-mini',
  reasoningOptions: { effort: 'minimal' },
  mcpServers: {
    browser: browserMcpConfig,
  },
  toolNames: ['browser/browser_navigate', 'browser/browser_snapshot'],
  systemPrompt: 'Test MCP filtering.',
}

describe('MCP tool filtering', () => {
  afterEach(() => {
    mock.restore()
  })

  it('returns only allowlisted MCP tools when an agent restricts toolNames', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      name: null,
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')

    spyOn(mcpClientModule, 'getMCPClient').mockResolvedValue('mcp-client-id')
    spyOn(mcpClientModule, 'listMCPTools').mockResolvedValue({
      tools: [
        {
          name: 'browser_navigate',
          description: 'Navigate to a page',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'browser_snapshot',
          description: 'Capture snapshot',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'browser_click',
          description: 'Click an element',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    } as Awaited<ReturnType<typeof mcpClientModule.listMCPTools>>)

    let filteredTools: Array<{ name: string }> = []

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestMcpToolData } = params
        const sessionState = getInitialSessionState(getStubProjectFileContext())

        filteredTools = await requestMcpToolData({
          mcpConfig: browserMcpConfig,
          toolNames: TEST_AGENT.toolNames!
            .filter((toolName) => toolName.startsWith('browser/'))
            .map((toolName) => toolName.slice('browser/'.length)),
        })

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new CodebuffClient({
      apiKey: 'test-key',
      agentDefinitions: [TEST_AGENT],
    })

    const result = await client.run({
      agent: TEST_AGENT.id,
      prompt: 'List MCP tools',
    })

    expect(result.output.type).toBe('lastMessage')
    expect(filteredTools.map((tool: { name: string }) => tool.name)).toEqual([
      'browser_navigate',
      'browser_snapshot',
    ])
  })
})
