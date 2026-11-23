/**
 * Stdio MCP server fixture whose first `tools/list` fails and every later one
 * answers, like a server still warming up when the client first asks.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'flaky-list-tools-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

let lists = 0
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (lists++ === 0) throw new Error('not ready yet')
  return {
    tools: [{ name: 'ready', inputSchema: { type: 'object', properties: {} } }],
  }
})

await server.connect(new StdioServerTransport())
