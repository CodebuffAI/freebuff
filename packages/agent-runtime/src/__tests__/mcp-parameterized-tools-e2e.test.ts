import {
  callMCPTool,
  getMCPClient,
  listMCPTools,
} from '@codebuff/common/mcp/client'
import { beforeAll, describe, expect, test } from 'bun:test'
import { asSchema } from 'ai'

import { getMCPToolData } from '../mcp'
import { getToolSet } from '../tools/prompts'
import { parseRawCustomToolCall } from '../tools/tool-executor'

import type { MCPConfig } from '@codebuff/common/types/mcp'
import type { CustomToolDefinitions } from '@codebuff/common/util/file'

/**
 * One parameterized MCP tool call, end to end over a real stdio server:
 * tools/list -> stored definition -> schema served to the model -> argument
 * parsing -> tools/call. The fixture mirrors the Roblox Studio MCP server.
 *
 * The user-visible failure (Discord #help, 2026-10-01, Freebuff CLI 0.1.2;
 * public #912 / #1306 for other servers): the zero-argument
 * `list_roblox_studios` worked, every other tool failed with
 * "studio_id: expected string, received undefined", because the model was
 * shown `{ "properties": {} }` for each of them and so sent `{}`. The served
 * schema is the half that broke; the server echo pins the arguments half.
 */

const SERVER = 'Roblox_Studio'

const config: MCPConfig = {
  type: 'stdio',
  command: process.execPath,
  args: [
    Bun.resolveSync(
      '@codebuff/common/mcp/__tests__/parameterized-tools-server',
      import.meta.dir,
    ),
  ],
  env: {},
}

let defs: CustomToolDefinitions

async function servedSchema(tool: string): Promise<Record<string, any>> {
  const toolSet = await getToolSet({
    toolNames: [],
    windowedFileReads: false,
    additionalToolDefinitions: async () => defs,
    agentTools: {},
    skills: {},
  })
  const served = toolSet[`${SERVER}__${tool}`] as { inputSchema: unknown }
  return (await asSchema(served.inputSchema as never).jsonSchema) as Record<
    string,
    any
  >
}

async function callThroughRuntime(tool: string, input: unknown) {
  const parsed = parseRawCustomToolCall({
    customToolDefs: defs,
    rawToolCall: { toolName: `${SERVER}__${tool}`, toolCallId: 'call-1', input },
  })
  if ('error' in parsed) throw new Error(parsed.error)
  const [output] = (await callMCPTool(await getMCPClient(config), {
    name: tool,
    arguments: parsed.input,
  })) as { type: string; value: string }[]
  return JSON.parse(output.value) as { tool: string; received: unknown }
}

describe('parameterized MCP tools over stdio', () => {
  beforeAll(async () => {
    defs = await getMCPToolData({
      toolNames: [],
      mcpServers: { [SERVER]: config },
      requestMcpToolData: async ({ mcpConfig }) =>
        (await listMCPTools(await getMCPClient(mcpConfig))).tools,
    })
  })

  test('the model is shown every argument the server requires', async () => {
    const schema = await servedSchema('get_studio_state')
    expect(Object.keys(schema.properties)).toEqual(['studio_id'])
    expect(schema.required).toEqual(['studio_id'])

    const luau = await servedSchema('execute_luau')
    expect(Object.keys(luau.properties).sort()).toEqual([
      'code',
      'datamodel_type',
      'studio_id',
    ])
    expect(luau.properties.datamodel_type.enum).toEqual([
      'Edit',
      'Client',
      'Server',
    ])
    expect(luau.required).toEqual(['code', 'datamodel_type', 'studio_id'])
  })

  test('the server receives the arguments the model sent', async () => {
    expect(
      await callThroughRuntime('get_studio_state', {
        studio_id: '1e0b10e9-9f4e-41a1-a355-9daa51c6fe72',
      }),
    ).toEqual({
      tool: 'get_studio_state',
      received: { studio_id: '1e0b10e9-9f4e-41a1-a355-9daa51c6fe72' },
    })

    // Some providers deliver tool arguments as a JSON string.
    const luauArgs = {
      code: 'return workspace.Name',
      datamodel_type: 'Edit',
      studio_id: 'abc',
    }
    expect(
      await callThroughRuntime('execute_luau', JSON.stringify(luauArgs)),
    ).toEqual({ tool: 'execute_luau', received: luauArgs })
  })

  test('a zero-argument tool still calls with an empty object', async () => {
    expect(await callThroughRuntime('list_roblox_studios', {})).toEqual({
      tool: 'list_roblox_studios',
      received: {},
    })
  })

  test('a call missing a required argument is refused before the server', () => {
    const parsed = parseRawCustomToolCall({
      customToolDefs: defs,
      rawToolCall: {
        toolName: `${SERVER}__get_studio_state`,
        toolCallId: 'call-2',
        input: {},
      },
    })
    expect('error' in parsed && parsed.error).toContain('studio_id')
  })
})
