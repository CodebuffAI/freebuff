import { describe, expect, test } from 'bun:test'

import { getToolSet } from '../prompts'

const makeToolSet = async (inputSchema: unknown) =>
  getToolSet({
    toolNames: [],
    windowedFileReads: false,
    additionalToolDefinitions: async () =>
      ({
        shaped_tool: {
          description: 'A tool defined with a live zod schema',
          inputSchema,
        },
      }) as never,
    agentTools: {} as never,
    skills: {} as never,
  })

describe('getToolSet serves custom tool inputSchemas', () => {
  test('keeps_live_zod_schema_functional_through_clone_and_serving', async () => {
    const { z } = await import('zod/v4')
    const liveSchema = z.object({ path: z.string() })

    const toolSet = await makeToolSet(liveSchema)

    const served = (toolSet['shaped_tool'] as { inputSchema: unknown }).inputSchema
    const parse = (served as { safeParse?: (v: unknown) => { success: boolean } }).safeParse
    expect(typeof parse).toBe('function')
    expect(parse!({ path: 'a.ts' }).success).toBe(true)
    expect(() => z.toJSONSchema(served as never, { io: 'input' })).not.toThrow()
  })
})
