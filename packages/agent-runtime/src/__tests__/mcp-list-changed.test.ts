/**
 * #1696: a progressive MCP catalog must reach the next model step in one turn.
 * A real Node stdio server is necessary to cover notifications and pagination;
 * process startup and the runtime loop may take over a second on Windows.
 */
import {
  callMCPTool,
  getMCPClient,
  listMCPTools,
} from '@codebuff/common/mcp/client'
import {
  createTestAgentRuntimeParams,
  mockFileContext,
} from '@codebuff/common/testing/fixtures/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { asSchema } from 'ai'
import { expect, mock, test } from 'bun:test'

import { loopAgentSteps } from '../run-agent-step'
import { createToolCallChunk } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { PromptAiSdkStreamFn } from '@codebuff/common/types/contracts/llm'
import type { MCPConfig } from '@codebuff/common/types/mcp'

test('replaces a notified MCP catalog before the next model request in one turn', async () => {
  const config: MCPConfig = {
    type: 'stdio',
    command: 'node',
    args: [import.meta.dir + '/list-changed-server.mjs'],
    env: {},
  }
  const clientId = await getMCPClient(config)
  const runtime = createTestAgentRuntimeParams()
  const template = {
    ...runtime.agentTemplate,
    instructionsPrompt: '',
    toolNames: [
      'end_turn',
      'host_tool',
      'probe/ping',
      'probe/add_tool',
      'probe/third_tool',
    ],
    mcpServers: { probe: config },
  } as AgentTemplate
  const fileContext = {
    ...mockFileContext,
    customToolDefinitions: {
      host_tool: {
        inputSchema: { type: 'object', properties: {} },
        description: 'Host tool',
      },
    },
  }
  runtime.requestMcpToolData = mock(async ({ mcpConfig, toolNames }) => {
    const result = await listMCPTools(await getMCPClient(mcpConfig))
    return result.tools.filter((t) => !toolNames || toolNames.includes(t.name))
  })
  runtime.requestToolCall = mock(async ({ toolName, input }) => ({
    output: await callMCPTool(clientId, { name: toolName, arguments: input }),
  }))
  const seen: { names: string[]; schema?: unknown }[] = []
  const stream: PromptAiSdkStreamFn = async function* ({ tools }) {
    const third = tools?.probe__third_tool
    seen.push({
      names: Object.keys(tools ?? {}).sort(),
      schema: third ? await asSchema(third.inputSchema).jsonSchema : undefined,
    })
    yield createToolCallChunk(
      ['probe__add_tool', 'probe__third_tool', 'end_turn'][seen.length - 1],
      {},
    )
    return promptSuccess('fixture-response')
  }
  runtime.promptAiSdkStream = mock(stream)
  const result = await loopAgentSteps({
    ...runtime,
    fileContext,
    agentType: template.id,
    agentTemplate: template,
    localAgentTemplates: { [template.id]: template },
    agentState: {
      ...getInitialSessionState(fileContext).mainAgentState,
      stepsRemaining: 4,
    },
    repoId: undefined,
    repoUrl: undefined,
    userInputId: 'fixture-input',
    clientSessionId: 'fixture-session',
    fingerprintId: 'fixture-fingerprint',
    userId: 'fixture-user',
    prompt: 'Discover and use a tool.',
    spawnParams: undefined,
    ancestorRunIds: [],
    signal: new AbortController().signal,
  })
  expect(seen.map((s) => s.names)).toEqual([
    ['end_turn', 'host_tool', 'probe__add_tool', 'probe__ping'],
    [
      'end_turn',
      'host_tool',
      'probe__add_tool',
      'probe__ping',
      'probe__third_tool',
    ],
    ['end_turn', 'host_tool', 'probe__add_tool', 'probe__third_tool'],
  ])
  expect(seen[1].schema).toEqual({ type: 'object', properties: {} })
  expect(seen[2].schema).toEqual({
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  })
  expect(result.agentState.toolDefinitions?.probe__ping).toBeUndefined()
  expect(result.output.type).not.toBe('error')
})
