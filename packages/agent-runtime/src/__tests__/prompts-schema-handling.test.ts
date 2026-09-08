import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { describe, test, expect, mock } from 'bun:test'
import { convertJsonSchemaToZod } from 'zod-from-json-schema'
import { z } from 'zod/v4'

import {
  buildAgentToolInputSchema,
  buildAgentToolSet,
} from '../templates/prompts'
import { parseRawCustomToolCall, tryTransformAgentToolCall } from '../tools/tool-executor'
import { handleLookupAgentInfo } from '../tools/handlers/tool/lookup-agent-info'
import {
  ensureZodSchema,
  buildToolDescription,
  getToolSet,
} from '../tools/prompts'

import type { AgentTemplate } from '../templates/types'

/** Create a mock logger using bun:test mock() for better test consistency */
const createMockLogger = () => ({
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
})

describe('Schema handling error recovery', () => {
  describe('ensureJsonSchemaCompatible in templates/prompts.ts', () => {
    test('handles schema that cannot be converted to JSON Schema', async () => {
      // Create a schema that will fail JSON Schema conversion
      // z.function() cannot be converted to JSON Schema
      const problematicSchema = z.function()

      const agentTemplate: AgentTemplate = {
        id: 'test-agent',
        displayName: 'Test Agent',
        spawnerPrompt: 'Test spawner prompt',
        model: 'gpt-4o-mini',
        inputSchema: {
          prompt: z.string().describe('A test prompt'),
          params: problematicSchema as unknown as z.ZodType<
            Record<string, unknown> | undefined
          >,
        },
        outputMode: 'last_message',
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      }

      // buildAgentToolSet uses ensureJsonSchemaCompatible internally
      // It should not throw even with problematic schema
      const toolSet = await buildAgentToolSet({
        spawnableAgents: ['test-agent'],
        agentTemplates: { 'test-agent': agentTemplate },
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      // Should have created a tool without throwing
      expect(toolSet['test_agent']).toBeDefined()
      expect(toolSet['test-agent']).toBeUndefined()
    })

    test('buildAgentToolInputSchema handles valid schemas', () => {
      const agentTemplate: AgentTemplate = {
        id: 'valid-agent',
        displayName: 'Valid Agent',
        spawnerPrompt: 'Valid spawner prompt',
        model: 'gpt-4o-mini',
        inputSchema: {
          prompt: z.string().describe('A valid prompt'),
          params: z.object({ foo: z.string() }),
        },
        outputMode: 'last_message',
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      }

      const inputSchema = buildAgentToolInputSchema(agentTemplate)

      // Should return a valid schema that can be converted to JSON Schema
      expect(() => z.toJSONSchema(inputSchema, { io: 'input' })).not.toThrow()
    })

    test('buildAgentToolInputSchema handles empty inputSchema', () => {
      const agentTemplate: AgentTemplate = {
        id: 'empty-schema-agent',
        displayName: 'Empty Schema Agent',
        spawnerPrompt: 'Empty schema spawner prompt',
        model: 'gpt-4o-mini',
        inputSchema: {},
        outputMode: 'last_message',
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      }

      const inputSchema = buildAgentToolInputSchema(agentTemplate)

      // Should return a valid schema
      expect(() => z.toJSONSchema(inputSchema, { io: 'input' })).not.toThrow()
    })
  })

  describe('direct subagent tool names', () => {
    test('uses underscored tool aliases while preserving hyphenated agent IDs', () => {
      const transformed = tryTransformAgentToolCall({
        toolName: 'file_picker',
        input: { prompt: 'Find relevant files' },
        spawnableAgents: ['codebuff/file-picker@1.0.0'],
      })

      expect(transformed).toEqual({
        toolName: 'spawn_agents',
        input: {
          agents: [
            {
              agent_type: 'codebuff/file-picker@1.0.0',
              prompt: 'Find relevant files',
            },
          ],
        },
      })
    })
  })

  describe('ensureJsonSchemaCompatible in tools/prompts.ts', () => {
    test('buildToolDescription handles problematic schemas gracefully', () => {
      // z.promise() cannot be converted to JSON Schema
      const problematicSchema = z.promise(z.string())

      // Should not throw when building tool description
      const description = buildToolDescription({
        toolName: 'test_tool',
        schema: problematicSchema as unknown as z.ZodType,
        description: 'A test tool',
        endsAgentStep: false,
      })

      expect(description).toContain('test_tool')
      expect(description).toContain('A test tool')
      // Should have Params section with fallback (either 'None' or empty object)
      expect(description).toContain('Params:')
    })

    test('buildToolDescription uses fallback for schemas that fail toJSONSchema', () => {
      // z.function() cannot be converted to JSON Schema
      const problematicSchema = z.function()

      const description = buildToolDescription({
        toolName: 'fallback_test',
        schema: problematicSchema as unknown as z.ZodType,
        description: 'Testing fallback behavior',
        endsAgentStep: false,
      })

      // Should use fallback - verify the Params section exists and doesn't crash
      expect(description).toContain('### fallback_test')
      expect(description).toContain('Testing fallback behavior')
      // The fallback schema is z.object({}).passthrough() which has no properties
      // So it should show 'Params: None'
      expect(description).toContain('Params: None')
    })

    test('buildToolDescription handles valid schemas', () => {
      const validSchema = z.object({
        path: z.string().describe('File path'),
        content: z.string().describe('File content'),
      })

      const description = buildToolDescription({
        toolName: 'write_file',
        schema: validSchema,
        description: 'Write a file',
        endsAgentStep: false, // endsAgentStep=false to avoid schema combination issues
      })

      expect(description).toContain('write_file')
      expect(description).toContain('Write a file')
      // The schema properties should be in the JSON output
      expect(description).toContain('path')
      expect(description).toContain('content')
    })

    test('buildToolDescription preserves MCP params when schema is represented as allOf', () => {
      const mcpSchema = convertJsonSchemaToZod({
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      })

      const description = buildToolDescription({
        toolName: 'greet__greet',
        schema: mcpSchema,
        description: 'Call greet',
        endsAgentStep: true,
      })

      expect(description).toContain('greet__greet')
      expect(description).toContain('Params: {')
      // The business contract: the MCP-declared params survive into the
      // description the model reads. (Do NOT assert the serializer's token
      // choice — zod may render this shape as allOf or as flattened
      // properties depending on version; coupling to that caused a
      // permanently-flaky test.)
      expect(description).toContain('"name"')
      expect(description).toContain('cb_easp')
      expect(description).not.toContain('Params: None')
    })

    test('getToolSet handles custom tools with problematic schemas', async () => {
      // Create a custom tool definition with a schema that can't be converted
      const customToolDefs = {
        problematic_tool: {
          description: 'A problematic tool',
          inputSchema: z.function() as unknown as z.ZodType,
          endsAgentStep: true,
        },
      }

      const toolSet = await getToolSet({
        toolNames: [],
        windowedFileReads: false,
        additionalToolDefinitions: async () => customToolDefs,
        agentTools: {},
        skills: {},
      })

      // Should have the tool defined without throwing
      expect(toolSet['problematic_tool']).toBeDefined()
    })

    test('ensureZodSchema converts JSON Schema to Zod schema', () => {
      const jsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      }

      const zodSchema = ensureZodSchema(jsonSchema)

      // Should be able to parse valid data
      const result = zodSchema.safeParse({ name: 'test', age: 25 })
      expect(result.success).toBe(true)
    })

    test('ensureZodSchema returns Zod schema unchanged', () => {
      const zodSchema = z.object({
        name: z.string(),
      })

      const result = ensureZodSchema(zodSchema)

      // Should return the same schema
      expect(result).toBe(zodSchema)
    })
  })

  describe('toJSONSchema error handling in lookup-agent-info.ts', () => {
    test('handles schemas that cannot be converted to JSON Schema', async () => {
      // Create an agent template with a problematic output schema
      const agentTemplate: AgentTemplate = {
        id: 'problematic-output-agent',
        displayName: 'Problematic Output Agent',
        spawnerPrompt: 'Test',
        model: 'gpt-4o-mini',
        inputSchema: {
          prompt: z.string(),
        },
        outputMode: 'structured_output',
        outputSchema: z.function() as unknown as z.ZodType, // This cannot be converted
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      }

      const localAgentTemplates = {
        'problematic-output-agent': agentTemplate,
      }

      const result = await handleLookupAgentInfo({
        toolCall: {
          toolCallId: 'test-call',
          toolName: 'lookup_agent_info',
          input: { agentId: 'problematic-output-agent' },
        },
        previousToolCallFinished: Promise.resolve(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        localAgentTemplates,
        logger: createMockLogger(),
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      // Should return a result without throwing
      expect(result.output).toBeDefined()

      // Parse the output to check the fallback
      const outputValue = result.output[0]
      expect(outputValue.type).toBe('json')
      if (outputValue.type === 'json') {
        const parsed = outputValue.value as {
          found: boolean
          agent?: { outputSchema?: unknown }
        }
        expect(parsed.found).toBe(true)
        // The outputSchema should be the fallback
        expect(parsed.agent?.outputSchema).toEqual({
          type: 'object',
          description: 'Schema unavailable',
        })
      }
    })

    test('handles valid schemas correctly', async () => {
      const agentTemplate: AgentTemplate = {
        id: 'valid-output-agent',
        displayName: 'Valid Output Agent',
        spawnerPrompt: 'Test',
        model: 'gpt-4o-mini',
        inputSchema: {
          prompt: z.string().describe('User prompt'),
          params: z.object({
            verbose: z.boolean().optional(),
          }),
        },
        outputMode: 'structured_output',
        outputSchema: z.object({
          result: z.string(),
          success: z.boolean(),
        }),
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: ['read_files'],
        spawnableAgents: [],
        systemPrompt: '',
        instructionsPrompt: '',
        stepPrompt: '',
      }

      const localAgentTemplates = {
        'valid-output-agent': agentTemplate,
      }

      const result = await handleLookupAgentInfo({
        toolCall: {
          toolCallId: 'test-call',
          toolName: 'lookup_agent_info',
          input: { agentId: 'valid-output-agent' },
        },
        previousToolCallFinished: Promise.resolve(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        localAgentTemplates,
        logger: createMockLogger(),
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      const outputValue = result.output[0]
      expect(outputValue.type).toBe('json')
      if (outputValue.type === 'json') {
        const parsed = outputValue.value as {
          found: boolean
          agent?: {
            outputSchema?: {
              type?: string
              properties?: Record<string, unknown>
            }
            inputSchema?: { prompt?: unknown; params?: unknown }
          }
        }
        expect(parsed.found).toBe(true)
        // Should have proper JSON Schema output
        expect(parsed.agent?.outputSchema?.type).toBe('object')
        expect(parsed.agent?.outputSchema?.properties).toHaveProperty('result')
        expect(parsed.agent?.outputSchema?.properties).toHaveProperty('success')
        // Input schema should also be converted
        expect(parsed.agent?.inputSchema?.prompt).toBeDefined()
        expect(parsed.agent?.inputSchema?.params).toBeDefined()
      }
    })

    test('returns not found for non-existent agent', async () => {
      const result = await handleLookupAgentInfo({
        toolCall: {
          toolCallId: 'test-call',
          toolName: 'lookup_agent_info',
          input: { agentId: 'non-existent-agent' },
        },
        previousToolCallFinished: Promise.resolve(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        localAgentTemplates: {},
        logger: createMockLogger(),
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      const outputValue = result.output[0]
      expect(outputValue.type).toBe('json')
      if (outputValue.type === 'json') {
        const parsed = outputValue.value as { found: boolean; error?: string }
        expect(parsed.found).toBe(false)
        expect(parsed.error).toContain('not found')
      }
    })
  })

  describe('Schema with endsAgentStep parameter', () => {
    test('toJsonSchemaSafe handles problematic schema with endsAgentStep', () => {
      // When endsAgentStep is true, the schema is combined with another schema
      // This tests that the combined schema also handles errors gracefully
      const problematicSchema = z.promise(z.string())

      const description = buildToolDescription({
        toolName: 'async_tool',
        schema: problematicSchema as unknown as z.ZodType,
        description: 'An async tool',
        endsAgentStep: true,
      })

      // Should produce valid output without throwing
      expect(description).toContain('async_tool')
      expect(description).toContain('An async tool')
    })
  })
})

describe('getToolSet: commit-attribution suppression', () => {
  const build = async (suppressCommitAttribution?: boolean) =>
    getToolSet({
      toolNames: ['run_terminal_command'],
      windowedFileReads: false,
      ...(suppressCommitAttribution === undefined
        ? {}
        : { suppressCommitAttribution }),
      additionalToolDefinitions: async () => ({}),
      agentTools: {},
      skills: {},
    })

  test('the default serves the trailer; the flag serves the variant that does not', async () => {
    // This is the layer that decides what the MODEL reads, so it is the layer
    // the suppression has to hold at. A gate that only changes the prompt would
    // still leave a worked `git commit` example with a trailer in it, which is
    // the concrete demonstration that beats the prose.
    const ordinary = await build()
    const ordinaryDescription = ordinary.run_terminal_command
      ?.description as string
    expect(ordinaryDescription).toContain('Co-Authored-By: Codebuff')
    expect(ordinaryDescription).toContain('noreply@codebuff.com')

    const suppressed = await build(true)
    const suppressedDescription = suppressed.run_terminal_command
      ?.description as string
    expect(suppressedDescription).not.toContain('noreply@codebuff.com')
    expect(suppressedDescription).toContain('Do NOT add any trailer')

    // Explicit false is the default, not a third state.
    const explicitlyOff = await build(false)
    expect(explicitlyOff.run_terminal_command?.description).toBe(
      ordinaryDescription,
    )
  })

  test('suppression touches no other tool', async () => {
    const suppressed = await getToolSet({
      toolNames: ['run_terminal_command', 'read_files'],
      windowedFileReads: false,
      suppressCommitAttribution: true,
      additionalToolDefinitions: async () => ({}),
      agentTools: {},
      skills: {},
    })
    const ordinary = await getToolSet({
      toolNames: ['run_terminal_command', 'read_files'],
      windowedFileReads: false,
      additionalToolDefinitions: async () => ({}),
      agentTools: {},
      skills: {},
    })
    expect(suppressed.read_files?.description).toBe(
      ordinary.read_files?.description,
    )
  })
})

// An MCP server declares a tool's arguments as a JSON Schema, and that schema
// is forwarded to the LLM — the model reads it to decide what arguments to
// emit. MCP allows these schemas to be vague: SEP-2106 requires only
// `type: "object"`
// (https://modelcontextprotocol.io/seps/2106-json-schema-2020-12), so a
// property may be a bare `{ "type": "object" }` with no named fields.
// The conversion to zod and back used to strip such schemas down to an empty
// object schema, and a model that reads an empty argument schema calls the
// tool with `{}` — no arguments at all. These tests pin the contract: what
// the server declared is what the model must see.
describe('getToolSet: loose MCP schemas survive the point-of-use round-trip', () => {
  // quwin's minimal repro from the issue #912 follow-up, verbatim:
  // one tight field, one loose field, both required.
  const LOOSE_MCP_SCHEMA = {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      payload: { type: 'object' },
    },
    required: ['project_id', 'payload'],
  }

  // The AI SDK Schema contract getToolSet serves for JSON-Schema inputs:
  // the raw schema passes to providers verbatim; args validate via callback.
  type ServedSchema = {
    jsonSchema: Record<string, unknown>
    validate: (value: unknown) => { success: boolean; value?: unknown }
  }

  const buildWithCustomTool = async (inputSchema: unknown) =>
    getToolSet({
      toolNames: [],
      windowedFileReads: false,
      additionalToolDefinitions: async () => ({
        loose_schema_tool: {
          description: 'Tool with a loose schema',
          inputSchema: inputSchema as z.ZodType,
          endsAgentStep: false,
        },
      }),
      agentTools: {},
      skills: {},
    })

  test('a loose MCP schema reaches the model with its named properties intact', async () => {
    // Given a custom tool whose JSON Schema contains a bare
    // `{ type: 'object' }` property (unconvertible to a named zod shape),
    // when getToolSet serves the tool's inputSchema,
    // then the model-facing JSON Schema round-trip succeeds and still names
    // both properties and both required fields - the served schema must not
    // be the empty passthrough fallback.

    // Arrange
    const toolSet = await buildWithCustomTool(LOOSE_MCP_SCHEMA)
    const servedSchema = toolSet['loose_schema_tool']?.inputSchema as unknown as ServedSchema

    // Act
    const modelFacing = servedSchema.jsonSchema

    // Assert: the raw JSON Schema must reach the model intact -
    // both named properties and the required list, no passthrough fallback.
    const properties = modelFacing.properties as
      | Record<string, unknown>
      | undefined
    expect(properties).toBeDefined()
    expect(properties).toHaveProperty('project_id')
    expect(properties).toHaveProperty('payload')
    expect(modelFacing.required).toEqual(
      expect.arrayContaining(['project_id', 'payload']),
    )
  })

  test('the served loose schema accepts arbitrary payloads but still rejects missing required fields', async () => {
    // Given the same loose-schema tool served by getToolSet,
    // when arguments are validated against the served inputSchema,
    // then both sides of the validation contract hold:
    // (a) the loose payload accepts arbitrary nested data - the served schema
    //     must not become stricter than what the MCP server declared, and
    // (b) calls with missing required fields fail - the served schema must not
    //     become the old empty passthrough fallback, which accepted anything,
    //     including calls the MCP server declared invalid.

    // Arrange
    const toolSet = await buildWithCustomTool(LOOSE_MCP_SCHEMA)
    const servedSchema = toolSet['loose_schema_tool']?.inputSchema as unknown as ServedSchema

    // Act (a): both required fields present; payload is arbitrary nested data,
    // which the server deliberately left unconstrained.
    const validArgs = servedSchema.validate({
      project_id: 'p1',
      payload: { anything: { deep: true } },
    })

    // Act (b): no arguments at all, so both required fields are missing.
    const missingRequired = servedSchema.validate({})

    // Assert: (a) accepted, (b) rejected.
    expect(validArgs.success).toBe(true)
    expect(missingRequired.success).toBe(false)
  })

  test('a tight MCP schema is unaffected by the loose-schema path', async () => {
    // Given a fully named (tight) MCP schema - every property a concrete
    // scalar type, the pattern served by e.g. the MCP reference "everything"
    // server (@modelcontextprotocol/server-everything) -
    // when getToolSet serves it,
    // then its properties round-trip intact. Control test: the loose-schema
    // fix must not degrade the tight path that already worked.

    // Arrange
    const tightSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    }
    const toolSet = await buildWithCustomTool(tightSchema)
    const servedSchema = toolSet['loose_schema_tool']?.inputSchema as unknown as ServedSchema

    // Act
    const modelFacing = servedSchema.jsonSchema

    // Assert
    expect(modelFacing.properties).toHaveProperty('name')
    expect(modelFacing.required).toEqual(['name'])
  })
})

