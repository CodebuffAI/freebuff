import { createServer } from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { expect, test } from 'bun:test'

import { getMCPClient, listMCPTools } from '../client'

/**
 * Uses a real loopback MCP transport to detect reuse of another identity's
 * catalog. HTTP initialization and shutdown can take over a second.
 */
test('separates remote clients by their authorization headers', async () => {
  const http = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const identity =
      req.headers.authorization === 'Bearer fixture-alpha'
        ? 'alpha'
        : req.headers.authorization === 'Bearer fixture-beta'
          ? 'beta'
          : 'unknown'
    const rpc = new McpServer({ name: 'header-identity', version: '1.0.0' })
    rpc.registerTool(`who_${identity}`, { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: identity }],
    }))
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      void rpc.close()
    })
    try {
      await rpc.connect(transport)
      await transport.handleRequest(req, res)
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
    const base = {
      type: 'http' as const,
      url: `http://127.0.0.1:${address.port}/mcp`,
      params: {},
    }
    const alphaConfig = {
      ...base,
      headers: { Authorization: 'Bearer fixture-alpha' },
    }
    const alphaId = await getMCPClient(alphaConfig)
    const alpha = await listMCPTools(alphaId)
    const betaId = await getMCPClient({
      ...base,
      headers: { Authorization: 'Bearer fixture-beta' },
    })
    const beta = await listMCPTools(betaId)

    expect(beta.tools.map((tool) => tool.name)).toEqual(['who_beta'])
    expect(alpha.tools.map((tool) => tool.name)).toEqual(['who_alpha'])
    expect(betaId).not.toBe(alphaId)
    expect(await getMCPClient(alphaConfig)).toBe(alphaId)
    expect(alphaId).not.toContain('fixture-alpha')
    expect(betaId).not.toContain('fixture-beta')
  } finally {
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
}, 10_000)
