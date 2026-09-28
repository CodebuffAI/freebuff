import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { callMCPTool, getMCPClient } from '../client'

import type { MCPConfig } from '../../types/mcp'

/**
 * Wiring guard: the resource-mapping fix lives in
 * mcpContentToToolResultOutputs (unit-tested exhaustively next door in
 * mcp-content-mapping.test.ts). This test pins only the unique confidence
 * of the wiring — that the real stdio transport's tool results flow
 * through that mapping and reach callMCPTool's caller — not the mapping
 * itself.
 */

const SERVER_SCRIPT = String.raw`
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'mapping-contract-server', version: '1.0.0' })

server.registerTool('get_text_resource', { inputSchema: {} }, async () => ({
  content: [{
    type: 'resource',
    resource: {
      uri: 'file:///notes.txt',
      mimeType: 'text/plain',
      text: 'Resource 1: This is a plain text resource.',
    },
  }],
}))

await server.connect(new StdioServerTransport())
`

const EXPECTED_TEXT = 'Resource 1: This is a plain text resource.'

test('callMCPTool wires real stdio tool results through the resource mapping', async () => {
  const scriptPath = join(dirname(import.meta.path), 'mapping-contract-server.ts')
  writeFileSync(scriptPath, SERVER_SCRIPT)
  const config: MCPConfig = {
    type: 'stdio',
    command: 'bun',
    args: [scriptPath],
    env: process.env as Record<string, string>,
  }

  const clientId = await getMCPClient(config)

  const outputs = (await callMCPTool(clientId, {
    name: 'get_text_resource',
    arguments: {},
  } as never)) as { type: string; value?: string }[]

  expect(outputs).toHaveLength(1)
  expect(outputs[0].type).toBe('json')
  expect(outputs[0].value).toBe(EXPECTED_TEXT)
})
