
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
