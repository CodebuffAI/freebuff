import { describe, test, expect } from 'bun:test'
import { z } from 'zod/v4'

import { toTokenCountInputSchema } from '../to-json-schema'

/**
 * Regression tests for the persisted-state schema conversion.
 *
 * Tool inputSchemas are persisted into agent state, snapshotted and replayed
 * on every turn, and shipped to Anthropic's count_tokens API. Every stored
 * schema must therefore be plain JSON Schema with a top-level type: zod
 * internals never leak into state, and foreign (already-JSON) schemas pass
 * through unmangled.
 */
describe('toTokenCountInputSchema', () => {
  /**
   * Given: a zod object schema with an optional field.
   * When: it is converted.
   * Then: the result is JSON Schema with type object and the field mapped,
   *   not a serialized zod instance.
   */
  test('converts zod object schema to JSON Schema with top level type object', () => {
    const schema = z.object({
      q: z.string().describe('query'),
      n: z.number().optional(),
    })

    const out = toTokenCountInputSchema(schema) as Record<string, any> | undefined

    expect(out?.type).toBe('object')
    expect(out?.properties.q.type).toBe('string')
  })

  /**
   * Given: a union schema, which JSON Schema represents as anyOf with no
   *   top-level type.
   * When: it is converted.
   * Then: type object is backfilled, because Anthropic's count_tokens
   *   rejects input_schema values without a top-level type.
   */
  test('backfills type object for union schemas represented as anyOf', () => {
    const schema = z.union([z.object({ a: z.string() }), z.object({ b: z.number() })])

    const out = toTokenCountInputSchema(schema) as Record<string, any> | undefined

    expect(out?.type).toBe('object')
    expect(out?.anyOf).toBeDefined()
  })

  /**
   * Given: a schema that is already a plain JSON Schema object (the shape
   *   MCP servers and the SDK send).
   * When: it is converted.
   * Then: it is copied as-is - conversion must not mangle foreign schemas.
   */
  test('copies an already plain JSON Schema object unchanged', () => {
    const jsonSchema = {
      type: 'object',
      properties: { location: { type: 'string', enum: ['NYC', 'LA'] } },
      required: ['location'],
    }

    const out = toTokenCountInputSchema(jsonSchema)

    expect(out).toEqual(jsonSchema)
  })

  /**
   * Given: nullish input and a schema carrying a $schema key.
   * When: they are converted.
   * Then: nullish input yields undefined, and the meaningless $schema key
   *   is dropped to keep the token-count payload lean.
   */
  test('returns undefined for nullish input and strips the schema meta key', () => {
    const withMeta = { $schema: 'https://json-schema.org/x', type: 'object' }

    const nullishOut = toTokenCountInputSchema(undefined)
    const metaOut = toTokenCountInputSchema(withMeta)

    expect(nullishOut).toBeUndefined()
    expect(toTokenCountInputSchema(null)).toBeUndefined()
    expect(metaOut?.$schema).toBeUndefined()
    expect(metaOut?.type).toBe('object')
  })
})
