import { describe, test, expect } from 'bun:test'

import { getMCPToolData } from '../mcp'
import { MCP_TOOL_SEPARATOR } from '../mcp-constants'

/**
 * Regression tests for MCP tool-schema storage.
 *
 * Tool definitions returned by getMCPToolData are persisted in run/session
 * state, which is snapshotted and JSON-serialized on every turn. Schemas
 * must be stored verbatim: storing converted live zod instances instead
 * round-trips to def/shape internals and can carry cycles that detonate
 * JSON.stringify over the whole run state ("cannot serialize cyclic
 * structures", session death from turn 2 onward).
 */
describe('getMCPToolData schema storage', () => {
  /**
   * Given: one MCP server reporting one tool with a JSON Schema.
   * When: getMCPToolData stores it.
   * Then: the stored schema round-trips through JSON as the exact schema
   *   the server sent - the persisted-state contract.
   */
  test('stores the server JSON Schema verbatim and JSON round-trips it', async () => {
    const serverSchema = {
      type: 'object',
      properties: {
        location: { type: 'string', enum: ['NYC', 'LA'] },
        units: { type: 'string', description: 'metric or imperial' },
      },
      required: ['location'],
    }
    const writeTo: Record<string, any> = {}

    await getMCPToolData({
      toolNames: ['weather/get_forecast'],
      mcpServers: {
        weather: { command: 'echo', args: [] },
      } as never,
      writeTo: writeTo as never,
      requestMcpToolData: async () => [
        {
          name: 'get_forecast',
          description: 'Get the forecast',
          inputSchema: serverSchema,
        },
      ],
    })

    const stored = writeTo[`weather${MCP_TOOL_SEPARATOR}get_forecast`]
    const roundTripped = JSON.parse(JSON.stringify(stored.inputSchema))
    expect(roundTripped).toEqual(serverSchema)
  })

  /**
   * Given: two servers each reporting one tool with a distinct schema.
   * When: getMCPToolData stores both.
   * Then: each server's tool carries its own schema, namespaced with the
   *   internal separator, verbatim and JSON-serializable.
   */
  test('stores distinct schemas per server without conversion', async () => {
    const schemaA = { type: 'object', properties: { a: { type: 'number' } } }
    const schemaB = { type: 'string' }
    const writeTo: Record<string, any> = {}

    await getMCPToolData({
      toolNames: [],
      mcpServers: {
        alpha: { command: 'echo', args: [] },
        beta: { command: 'echo', args: [] },
      } as never,
      writeTo: writeTo as never,
      requestMcpToolData: async ({ toolNames }: { toolNames: unknown }) => {
        void toolNames
        return [
          { name: 't1', description: 'A', inputSchema: schemaA },
          { name: 't2', description: 'B', inputSchema: schemaB },
        ]
      },
    })

    const alphaStored = writeTo[`alpha${MCP_TOOL_SEPARATOR}t1`]
    const betaStored = writeTo[`beta${MCP_TOOL_SEPARATOR}t2`]
    expect(JSON.parse(JSON.stringify(alphaStored.inputSchema))).toEqual(schemaA)
    expect(JSON.parse(JSON.stringify(betaStored.inputSchema))).toEqual(schemaB)
    expect(betaStored.description).toBe('B')
  })
})
