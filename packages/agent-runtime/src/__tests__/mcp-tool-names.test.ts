import { describe, expect, it } from 'bun:test'

import { getMCPToolData, mcpExposedToolName } from '../mcp'

const PROVIDER_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

const schema = { type: 'object', properties: {} }

async function exposedFor(
  servers: Record<string, string[]>,
): Promise<Record<string, { mcpOrigin?: { server: string; tool: string } }>> {
  const mcpServers = Object.fromEntries(
    Object.keys(servers).map((name) => [name, { command: name } as any]),
  )
  return (await getMCPToolData({
    toolNames: [],
    mcpServers,
    requestMcpToolData: async ({ mcpConfig }) =>
      servers[(mcpConfig as { command: string }).command].map((name) => ({
        name,
        description: name,
        inputSchema: schema,
      })),
  })) as any
}

describe('MCP tool names reaching the provider', () => {
  it('leaves an already-valid name byte-identical, with no origin', async () => {
    const defs = await exposedFor({ supabase: ['list_tables'] })
    expect(Object.keys(defs)).toEqual(['supabase__list_tables'])
    expect(defs['supabase__list_tables'].mcpOrigin).toBeUndefined()
  })

  // The real failure: "Invalid 'tools[89].name': string does not match
  // pattern ... '^[a-zA-Z0-9_-]+$'" failed every turn for that user.
  it.each([
    ['a dotted server key', 'github.com', 'create_issue'],
    ['a spaced server key', 'my server', 'search'],
    ['a dotted tool name', 'files', 'fs.read_file'],
    ['a slash in the tool name', 'docs', 'pages/get'],
    ['a colon in the tool name', 'db', 'query:run'],
  ])(
    'sanitizes %s and keeps the original for execution',
    async (_l, server, tool) => {
      const defs = await exposedFor({ [server]: [tool] })
      const [exposed] = Object.keys(defs)
      expect(exposed).toMatch(PROVIDER_PATTERN)
      expect(defs[exposed].mcpOrigin).toEqual({ server, tool })
    },
  )

  it('keeps an over-long invalid name within 64 characters, stably', () => {
    const tool = `very.long.${'x'.repeat(120)}`
    const a = mcpExposedToolName('srv', tool)
    expect(a).toMatch(PROVIDER_PATTERN)
    expect(mcpExposedToolName('srv', tool)).toBe(a)
  })

  it('keeps two originals that sanitize alike both callable', async () => {
    const defs = await exposedFor({ files: ['a.b', 'a b'] })
    const names = Object.keys(defs)
    expect(new Set(names).size).toBe(2)
    for (const name of names) expect(name).toMatch(PROVIDER_PATTERN)
    expect(names.map((n) => defs[n].mcpOrigin?.tool).sort()).toEqual([
      'a b',
      'a.b',
    ])
  })
})
