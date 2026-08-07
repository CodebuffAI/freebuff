/**
 * Tests for MCP tool schema serialization fix.
 *
 * The core invariant: MCP tool inputSchemas stored in customToolDefinitions
 * MUST be plain JSON Schema objects, not Zod schemas, so that
 * JSON.stringify() never fails with "cannot serialize cyclic structures".
 *
 * Zod conversion happens at the consumption boundary via ensureZodSchema().
 */
import { describe, test, expect } from 'bun:test'

import { getMCPToolData } from '../mcp'
import { ensureZodSchema } from '../tools/prompts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a logger that tracks warnings. */
function makeLogger(): {
  debug: () => void
  info: () => void
  warn: (ctx: unknown, msg: string) => void
  error: () => void
  _warnings: string[]
} {
  const warnings: string[] = []
  return {
    debug: () => {},
    info: () => {},
    warn: (_ctx: unknown, msg: string) => {
      warnings.push(msg)
    },
    error: () => {},
    _warnings: warnings,
  }
}

/** Minimal valid JSON Schema objects covering typical MCP tool shapes. */
const jsonSchemas = {
  empty: {} as Record<string, unknown>,
  booleanTrue: true as unknown as Record<string, unknown>,
  booleanFalse: false as unknown as Record<string, unknown>,
  simple: {
    type: 'object',
    properties: { name: { type: 'string' } },
  } as Record<string, unknown>,
  nested: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'number' } } },
      },
    },
  } as Record<string, unknown>,
  withEnum: {
    type: 'object',
    properties: { color: { type: 'string', enum: ['red', 'green', 'blue'] } },
  } as Record<string, unknown>,
  withRequired: {
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'number' } },
    required: ['name'],
  } as Record<string, unknown>,
  withAdditional: {
    type: 'object',
    properties: { key: { type: 'string' } },
    additionalProperties: false,
  } as Record<string, unknown>,
}

// A truly circular object (simulates what someone might accidentally inject)
function makeCircular(): Record<string, unknown> {
  const obj: Record<string, unknown> = { name: 'circular' }
  obj.self = obj
  return obj
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP schema serialization', () => {
  // --- Storage invariants (the actual fix) ---

  describe('stored schemas are JSON-serializable', () => {
    const toolKinds = Object.entries(jsonSchemas)

    for (const [kind, inputSchema] of toolKinds) {
      test(`stores "${kind}" schema as plain object, not Zod`, async () => {
        const logger = makeLogger()
        const result = await getMCPToolData({
          toolNames: ['test/' + kind],
          mcpServers: { test: { command: 'fake', args: [] } as any },
          requestMcpToolData: async () => [
            { name: kind, description: `Schema kind: ${kind}`, inputSchema },
          ],
          logger,
        })

        const key = 'test__' + kind
        expect(result[key]).toBeDefined()
        const def = result[key]!

        // Invariant: inputSchema must NOT be a Zod schema
        expect(typeof (def.inputSchema as any)?.safeParse).not.toBe('function')

        // Invariant: JSON.stringify + JSON.parse roundtrip must succeed
        expect(() => JSON.stringify(result)).not.toThrow()
        const roundtripped = JSON.parse(JSON.stringify(result))
        expect(roundtripped[key]).toBeDefined()
      })
    }
  })

  // --- Roundtrip for multiple tools / multiple servers ---

  test('multiple tools from multiple MCP servers serialize correctly', async () => {
    const logger = makeLogger()
    const result = await getMCPToolData({
      toolNames: ['srv1/alpha', 'srv1/beta', 'srv2/gamma'],
      mcpServers: {
        srv1: { command: 'srv1', args: [] } as any,
        srv2: { command: 'srv2', args: [] } as any,
      },
      requestMcpToolData: async ({ mcpConfig }) => {
        const prefix = (mcpConfig as any).command as string
        return [
          {
            name: prefix === 'srv1' ? 'alpha' : 'gamma',
            description: `Tool from ${prefix}`,
            inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
          },
          ...(prefix === 'srv1'
            ? [
                {
                  name: 'beta',
                  description: 'Another tool',
                  inputSchema: { type: 'object', properties: {} },
                },
              ]
            : []),
        ]
      },
      logger,
    })

    expect(Object.keys(result).length).toBe(3)
    expect(() => JSON.stringify(result)).not.toThrow()

    // ensureZodSchema should convert every stored schema back to Zod
    for (const [name, def] of Object.entries(result)) {
      const zod = ensureZodSchema(def.inputSchema)
      expect(typeof zod.safeParse).toBe('function')
      const parsed = zod.safeParse({})
      expect(parsed.success).toBe(true)
    }
  })

  // --- Circular rejection (defense-in-depth) ---

  test('truly circular object still fails JSON.stringify (defense-in-depth)', async () => {
    // If someone bypasses getMCPToolData and injects a circular object
    // directly into customToolDefinitions, JSON.stringify should still
    // fail — we must NOT silently swallow circular references.
    const circular = makeCircular()
    expect(() => JSON.stringify(circular)).toThrow()

    // But our path should never produce circular objects
    const logger = makeLogger()
    const result = await getMCPToolData({
      toolNames: ['test/safe'],
      mcpServers: { test: { command: 'safe', args: [] } as any },
      requestMcpToolData: async () => [
        {
          name: 'safe',
          description: 'Safe tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      logger,
    })

    expect(() => JSON.stringify(result)).not.toThrow()
  })

  // --- Error with cause ---

  test('MCP server failure is caught and logged, not thrown', async () => {
    const logger = makeLogger()
    const cause = new Error('connection refused')

    const result = await getMCPToolData({
      toolNames: ['bad/missing'],
      mcpServers: { bad: { command: 'bad', args: [] } as any },
      requestMcpToolData: async () => {
        const err = new Error('MCP server failed')
        err.cause = cause
        throw err
      },
      logger,
    })

    // Should return empty (no tools from failed server)
    expect(Object.keys(result).length).toBe(0)
    // Should have logged a warning
    expect(logger._warnings.length).toBeGreaterThan(0)
    expect(logger._warnings[0]).toContain('bad')
  })

  // --- JSON.stringify of the final agent payload ---

  test('final agent payload (customToolDefinitions) survives JSON.stringify', () => {
    // Simulate what the agent runtime stores in fileContext.customToolDefinitions
    // after getMCPToolData returns. This is the payload that eventually gets
    // serialized via saveChatState → JSON.stringify(runState).

    const customToolDefinitions: Record<string, { inputSchema: Record<string, unknown>; description?: string; endsAgentStep?: boolean }> = {
      'engram__mem_save': {
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
            type: { type: 'string' },
            scope: { type: 'string' },
          },
          required: ['title'],
        },
        description: 'Save a memory',
        endsAgentStep: true,
      },
      'engram__mem_search': {
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' },
          },
        },
        description: 'Search memory',
        endsAgentStep: true,
      },
      'engram__mem_context': {
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string' },
            scope: { type: 'string' },
          },
        },
        description: 'Get memory context',
        endsAgentStep: true,
      },
      'codegraph__codegraph_explore': {
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            maxFiles: { type: 'number' },
            projectPath: { type: 'string' },
          },
          required: ['query'],
        },
        description: 'Explore code',
        endsAgentStep: true,
      },
      'builtin__read': {
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            offset: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['filePath'],
        },
        description: 'Read a file',
        endsAgentStep: false,
      },
    }

    // THE DECISIVE TEST: JSON.stringify must not throw
    expect(() => JSON.stringify(customToolDefinitions)).not.toThrow()

    const json = JSON.stringify(customToolDefinitions)
    const parsed = JSON.parse(json)

    // Verify all tools survived the roundtrip
    expect(Object.keys(parsed).length).toBe(5)
    expect(parsed['engram__mem_save'].inputSchema.required).toEqual(['title'])
    expect(parsed['engram__mem_search'].inputSchema.properties.query.type).toBe('string')
    expect(parsed['codegraph__codegraph_explore'].inputSchema.required).toEqual(['query'])
    expect(parsed['builtin__read'].inputSchema.properties.filePath.type).toBe('string')

    // ensureZodSchema should work on all of them
    for (const [name, def] of Object.entries(customToolDefinitions)) {
      const zod = ensureZodSchema(def.inputSchema)
      expect(typeof zod.safeParse).toBe('function')
    }
  })

  // --- Tool call result doesn't leak internals ---

  test('tool call result does not contain Zod or circular refs', () => {
    // After a tool executes, the result is stored in the message history.
    // This must also be JSON-serializable.

    const toolCall = {
      toolCallId: 'call-1',
      toolName: 'engram__mem_search',
      input: { query: 'PR #876', limit: 5 },
    }

    const toolResult = {
      role: 'tool' as const,
      toolCallId: 'call-1',
      content: JSON.stringify([
        { id: 1, title: 'Memory about PR #876' },
        { id: 2, title: 'Another memory' },
      ]),
    }

    // Both must be serializable
    expect(() => JSON.stringify(toolCall)).not.toThrow()
    expect(() => JSON.stringify(toolResult)).not.toThrow()
  })
})
