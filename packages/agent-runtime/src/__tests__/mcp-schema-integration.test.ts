/**
 * End-to-end integration test for the MCP schema serialization fix.
 *
 * Validates the full pipeline:
 *   MCP tools/list → getMCPToolData → getToolSet → JSON.stringify(agentState)
 *
 * Run with: bun test packages/agent-runtime/src/__tests__/mcp-schema-integration.test.ts
 */
import { describe, test, expect } from 'bun:test'

import { getMCPToolData } from '../mcp'
import { ensureZodSchema, getToolSet } from '../tools/prompts'
// @ts-expect-error - tree-sitter-wasm will be resolved at runtime in the test env
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'

import type { AgentTemplate } from '../templates/types'
import type { MCPConfig } from '@codebuff/common/types/mcp'
import type { CustomToolDefinitions } from '@codebuff/common/util/file'

// ---------------------------------------------------------------------------
// Realistic MCP tool schemas (based on actual Engram tool definitions)
// ---------------------------------------------------------------------------

/** A realistic Engram mem_save tool schema (complex nested JSON Schema) */
const engramMemSaveSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short, searchable title' },
    type: {
      type: 'string',
      enum: ['bugfix', 'decision', 'architecture', 'discovery', 'pattern', 'config', 'preference'],
      description: 'Category',
    },
    scope: { type: 'string', enum: ['project', 'personal'] },
    topic_key: { type: 'string', description: 'Optional topic identifier for upserts' },
    capture_prompt: { type: 'boolean', description: 'Capture the current user prompt' },
    content: { type: 'string', description: 'Structured content with What/Why/Where/Learned' },
    project: { type: 'string', description: 'Optional explicit project' },
    session_id: { type: 'string' },
  },
  required: ['title'],
  additionalProperties: false,
} as Record<string, unknown>

/** A realistic Engram mem_search tool schema */
const engramMemSearchSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query — natural language or keywords' },
    limit: { type: 'number', minimum: 1, maximum: 20 },
    type: { type: 'string' },
    scope: { type: 'string' },
    project: { type: 'string' },
    all_projects: { type: 'boolean' },
    match_mode: { type: 'string', enum: ['all', 'any'] },
  },
  required: ['query'],
  additionalProperties: false,
} as Record<string, unknown>

/** A realistic Engram mem_context tool schema */
const engramMemContextSchema = {
  type: 'object',
  properties: {
    project: { type: 'string' },
    scope: { type: 'string' },
  },
} as Record<string, unknown>

/** Codegraph explore schema */
const codegraphExploreSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    maxFiles: { type: 'number' },
    projectPath: { type: 'string' },
  },
  required: ['query'],
} as Record<string, unknown>

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP schema serialization — integration tests', () => {
  describe('getMCPToolData produces serializable CustomToolDefinitions', () => {
    test('multiple MCP servers with complex real-world schemas', async () => {
      const engramTools = [
        { name: 'mem_save', description: 'Save memory', inputSchema: engramMemSaveSchema },
        { name: 'mem_search', description: 'Search memory', inputSchema: engramMemSearchSchema },
        { name: 'mem_context', description: 'Get memory context', inputSchema: engramMemContextSchema },
      ]

      const codegraphTools = [
        { name: 'codegraph_explore', description: 'Explore code', inputSchema: codegraphExploreSchema },
      ]

      const result = await getMCPToolData({
        toolNames: [
          'engram/mem_save',
          'engram/mem_search',
          'engram/mem_context',
          'codegraph/codegraph_explore',
        ],
        mcpServers: {
          engram: { command: 'engram', args: ['stdio'] } as any,
          codegraph: { command: 'codegraph', args: ['stdio'] } as any,
        },
        requestMcpToolData: async ({ mcpConfig }) => {
          const name = (mcpConfig as any).command as string
          return name === 'engram' ? engramTools : codegraphTools
        },
      })

      // All tools should be present
      expect(Object.keys(result).length).toBe(4)

      // EVERY inputSchema must be a plain object, NOT a Zod schema
      for (const [name, def] of Object.entries(result)) {
        expect(typeof (def.inputSchema as any)?.safeParse).not.toBe('function')
      }

      // JSON.stringify must work
      expect(() => JSON.stringify(result)).not.toThrow()

      // Roundtrip preserves data
      const json = JSON.stringify(result)
      const parsed = JSON.parse(json) as CustomToolDefinitions
      expect(Object.keys(parsed).length).toBe(4)
      expect(parsed['engram__mem_save'].endsAgentStep).toBe(true)
      expect(parsed['engram__mem_search'].description).toBe('Search memory')
    })
  })

  describe('full pipeline: getMCPToolData → getToolSet → JSON.stringify', () => {
    test('tool set built from MCP definitions is JSON-serializable', async () => {
      // Step 1: Get MCP tool definitions (simulating real Engram tools)
      const mcpDefs = await getMCPToolData({
        toolNames: ['engram/mem_search', 'engram/mem_context'],
        mcpServers: {
          engram: { command: 'engram', args: ['stdio'] } as any,
        },
        requestMcpToolData: async () => [
          { name: 'mem_search', description: 'Search memory', inputSchema: engramMemSearchSchema },
          { name: 'mem_context', description: 'Get memory context', inputSchema: engramMemContextSchema },
        ],
      })

      // Step 2: Build the full tool set (mimics what run-agent-step.ts does)
      const toolSet = await getToolSet({
        toolNames: ['read_files'],
        additionalToolDefinitions: async () => mcpDefs,
        agentTools: {},
        skills: {},
      })

      // The tool set should contain built-in tools + MCP tools
      expect(toolSet['read_files']).toBeDefined()
      expect(toolSet['engram__mem_search']).toBeDefined()
      expect(toolSet['engram__mem_context']).toBeDefined()

      // Step 3: Convert tool definitions to agent state format (mimics run-agent-step.ts:910-913)
      const toolDefinitions = Object.fromEntries(
        Object.entries(toolSet).map(([name, tool]) => [
          name,
          { description: tool.description, inputSchema: tool.inputSchema },
        ]),
      )

      // Step 4: THE DECISIVE TEST — serialization of the agent state payload
      expect(() => JSON.stringify(toolDefinitions)).not.toThrow()

      const json = JSON.stringify(toolDefinitions)
      const parsed = JSON.parse(json)

      // MCP tools survived roundtrip in the serialized payload
      expect(parsed['engram__mem_search']).toBeDefined()
      expect(parsed['engram__mem_context']).toBeDefined()
      // Built-in tools are Zod schemas — they may or may not survive serialization
      // (that's a different concern; our fix is about MCP schemas)

      // Step 5: ensureZodSchema works on the stored MCP schemas
      for (const [name, def] of Object.entries(mcpDefs)) {
        const zod = ensureZodSchema(def.inputSchema)
        expect(typeof zod.safeParse).toBe('function')

        // Verify schema can parse valid input
        if (name === 'engram__mem_search') {
          const result = zod.safeParse({ query: 'test query' })
          expect(result.success).toBe(true)
        }
      }
    })
  })

  describe('checks: no Zod, no closures, no sockets in definitions', () => {
    test('stored definitions are pure data — no functions or instances', async () => {
      const result = await getMCPToolData({
        toolNames: ['test/safe'],
        mcpServers: { test: { command: 'test', args: [] } as any },
        requestMcpToolData: async () => [
          {
            name: 'safe',
            description: 'Safe tool',
            inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
          },
        ],
      })

      const def = result['test__safe']!

      // No functions
      for (const [key, value] of Object.entries(def)) {
        if (key === 'inputSchema') continue // checked below
        expect(typeof (value as any)).not.toBe('function')
      }

      // No Zod
      expect(typeof (def.inputSchema as any)?.safeParse).not.toBe('function')

      // No internal state references
      expect(def.inputSchema).not.toHaveProperty('_def')
      expect(def.inputSchema).not.toHaveProperty('_type')
      expect(def.inputSchema).not.toHaveProperty('_cached')
    })
  })
})
