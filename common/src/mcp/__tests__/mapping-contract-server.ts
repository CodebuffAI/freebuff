
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
