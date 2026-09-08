import { describe, expect, test } from 'bun:test'

import { getToolSet } from '../prompts'

import type { CustomToolDefinitions } from '@codebuff/common/util/file'

const NO_TOOLS: string[] = []

const zodSchemaTool = (schema: unknown): CustomToolDefinitions =>
  ({
    shaped_tool: {
      description: 'A tool defined with a live zod schema',
      inputSchema: schema,
    },
  }) as never

const jsonSchemaTool = (schema: Record<string, unknown>): CustomToolDefinitions =>
  ({
    shaped_tool: {
      description: 'A tool declared with a JSON Schema',
      inputSchema: schema,
    },
  }) as never

const makeToolSet = async (defs: CustomToolDefinitions) =>
  getToolSet({
    toolNames: NO_TOOLS,
    windowedFileReads: false,
    additionalToolDefinitions: async () => defs,
    agentTools: {} as never,
    skills: {} as never,
  })

const effectiveJsonSchema = async (
  served: unknown,
): Promise<Record<string, unknown>> => {
  const wrapper = served as { jsonSchema?: unknown; safeParse?: unknown }
  const isVerbatimWrapper =
    wrapper &&
    typeof wrapper === 'object' &&
    'jsonSchema' in wrapper &&
    typeof wrapper.safeParse !== 'function'
  if (isVerbatimWrapper) {
    return wrapper.jsonSchema as Record<string, unknown>
  }
  const { z } = await import('zod/v4')
  return z.toJSONSchema(served as never, { io: 'input' }) as Record<string, unknown>
}

describe('getToolSet serves custom tool inputSchemas', () => {
  test('keeps_live_zod_schema_functional_through_clone_and_serving', async () => {
    const { z } = await import('zod/v4')
    const liveSchema = z.object({ path: z.string() })

    const toolSet = await makeToolSet(zodSchemaTool(liveSchema))

    const served = (toolSet['shaped_tool'] as { inputSchema: unknown }).inputSchema
    const parse = (served as { safeParse?: (v: unknown) => { success: boolean } }).safeParse
    expect(typeof parse).toBe('function')
    expect(parse!({ path: 'a.ts' }).success).toBe(true)

    const { z: zod } = await import('zod/v4')
    expect(() => zod.toJSONSchema(served as never, { io: 'input' })).not.toThrow()
  })

  test('serves_json_schema_verbatim_preserving_loose_properties', async () => {
    const looseSchema = {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Enable verbose output' },
      },
    }

    const toolSet = await makeToolSet(jsonSchemaTool(looseSchema))

    const served = (toolSet['shaped_tool'] as { inputSchema: unknown }).inputSchema
    const modelSchema = await effectiveJsonSchema(served)
    expect(modelSchema.properties?.['verbose']).toBeDefined()
  })

  test('serves_bare_object_typed_property_without_amputation', async () => {
    const bareObjectSchema = {
      type: 'object',
      properties: {
        payload: { type: 'object', description: 'Arbitrary payload' },
      },
    }

    const toolSet = await makeToolSet(jsonSchemaTool(bareObjectSchema))

    const served = (toolSet['shaped_tool'] as { inputSchema: unknown }).inputSchema
    const modelSchema = await effectiveJsonSchema(served)
    expect((modelSchema.properties?.['payload'] as { type?: string })?.type).toBe('object')
  })
})
