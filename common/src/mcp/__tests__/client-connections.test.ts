import { createServer } from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { expect, test } from 'bun:test'

import { getMCPClient, listMCPTools } from '../client'

/**
 * Real loopback MCP handshakes can take over a second. Concurrent initialization
 * must not open duplicate connections, including when callers retry a failure.
 */
test('shares an in-flight MCP connection and retries after its failure', async () => {
  let handshakes = 0
  let failHandshake = true
  const http = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (body.method === 'initialize') {
        handshakes++
        if (failHandshake) {
          res.writeHead(503).end('fixture not ready')
          return
        }
      }
      const rpc = new McpServer({
        name: 'connection-sharing',
        version: '1.0.0',
      })
      rpc.registerTool('ping', { inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'pong' }],
      }))
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      res.on('close', () => {
        void rpc.close()
      })
      await rpc.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error))
    }
  })

  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', resolve)
    })
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('Missing port')
    const config = {
      type: 'http' as const,
      url: `http://127.0.0.1:${address.port}/mcp`,
      params: {},
      headers: {},
    }
    const failed = await Promise.allSettled([
      getMCPClient(config),
      getMCPClient(config),
    ])
    expect(failed.map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
    ])
    expect(handshakes).toBe(1)

    failHandshake = false
    const [first, second] = await Promise.all([
      getMCPClient(config),
      getMCPClient(config),
    ])
    expect(handshakes).toBe(2)
    expect(first).toBe(second)
    expect((await listMCPTools(first)).tools.map((tool) => tool.name)).toEqual([
      'ping',
    ])
    expect(await getMCPClient(config)).toBe(first)
    expect(handshakes).toBe(2)
  } finally {
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
}, 10_000)
