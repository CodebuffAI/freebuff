import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { callMCPTool, getMCPClient } from '../client'

import type { MCPConfig } from '../../types/mcp'

/**
 * Application-tier regression tests: a real stdio MCP server is spawned
 * with bun and called through the real callMCPTool. Tool results replay
 * from history into every later prompt build, so the mapping contract
 * (text resources as json values, only images as media, non-image
 * binaries degraded to descriptive text) protects the session from
 * permanent prompt-build poisoning.
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

server.registerTool('get_gzip_resource', { inputSchema: {} }, async () => ({
  content: [{
    type: 'resource',
    resource: {
      uri: 'file:///archive.gz',
      mimeType: 'application/gzip',
      blob: 'aGVsbG8=',
    },
  }],
}))

server.registerTool('get_png_resource', { inputSchema: {} }, async () => ({
  content: [{
    type: 'resource',
    resource: {
      uri: 'file:///logo.png',
      mimeType: 'image/png',
      blob: 'aGVsbG8=',
    },
  }],
}))

await server.connect(new StdioServerTransport())
`

const EXPECTED_TEXT_RESOURCE = 'Resource 1: This is a plain text resource.'

const startServer = async (): Promise<string> => {
  const scriptPath = join(dirname(import.meta.path), 'mapping-contract-server.ts')
  writeFileSync(scriptPath, SERVER_SCRIPT)
  const config: MCPConfig = {
    type: 'stdio',
    command: 'bun',
    args: [scriptPath],
    env: process.env as Record<string, string>,
  }
  return getMCPClient(config)
}

const callResourceTool = async (
  clientId: string,
  toolName: string,
): Promise<{ type: string; value?: string; mediaType?: string }[]> => {
  const outputs = await callMCPTool(clientId, { name: toolName, arguments: {} } as never)
  return outputs as never
}

describe('callMCPTool resource mapping contract', () => {
  test('maps_text_resource_to_json_value', async () => {
    const clientId = await startServer()

    const outputs = await callResourceTool(clientId, 'get_text_resource')

    expect(outputs).toHaveLength(1)
    expect(outputs[0].type).toBe('json')
    expect(outputs[0].value).toBe(EXPECTED_TEXT_RESOURCE)
  })

  test('degrades_non_image_binary_resource_to_descriptive_text', async () => {
    const clientId = await startServer()

    const outputs = await callResourceTool(clientId, 'get_gzip_resource')

    expect(outputs).toHaveLength(1)
    expect(outputs[0].type).toBe('json')
    expect(outputs[0].value).toContain('application/gzip')
    expect(outputs[0].value).toContain('not displayable')
  })

  test('keeps_image_resource_as_media_with_server_mime_type', async () => {
    const clientId = await startServer()

    const outputs = await callResourceTool(clientId, 'get_png_resource')

    expect(outputs).toHaveLength(1)
    expect(outputs[0].type).toBe('media')
    expect(outputs[0].mediaType).toBe('image/png')
  })
})
