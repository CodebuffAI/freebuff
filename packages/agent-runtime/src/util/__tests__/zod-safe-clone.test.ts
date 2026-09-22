import { describe, test, expect } from 'bun:test'
import { cloneDeep } from 'lodash'
import { z } from 'zod/v4'

import { cloneDeepKeepingZod } from '../zod-safe-clone'

/**
 * Regression tests for tool-schema cloning.
 *
 * Tool definitions carry live zod v4 schemas, and state boundaries
 * deep-clone the surrounding data. lodash cloneDeep strips zod's
 * non-enumerable _zod engine: the stripped clone still looks like a schema
 * (safeParse, def, shape all present) but throws the first time zod
 * internals touch it - which is how MCP and custom tool schemas silently
 * became empty {} at the model. cloneDeepKeepingZod is the fix pinned here.
 */
describe('lodash cloneDeep zod amputation (the bug)', () => {
  /**
   * Given: a zod v4 schema.
   * When: it is cloned with lodash cloneDeep.
   * Then: the clone still looks like a schema (safeParse present) but its
   *   engine is gone: z.toJSONSchema throws on it - the production failure
   *   behind the empty-schema bug, and the reason the helper below exists.
   */
  test('cloneDeep strips the zod engine so toJSONSchema throws on the clone', () => {
    const schema = z.object({ q: z.string() })

    const cloned = cloneDeep(schema)

    // Asserted behaviorally: the clone still parses, but conversion fails.
    expect(typeof cloned.safeParse).toBe('function')
    expect(() => z.toJSONSchema(cloned as never)).toThrow()
  })
})

describe('cloneDeepKeepingZod', () => {
  /**
   * Given: a plain (schema-free) nested structure.
   * When: it is cloned with cloneDeepKeepingZod.
   * Then: the result matches cloneDeep exactly, including fresh nested
   *   references - the clone helper must not change plain-data semantics.
   */
  test('cloneDeepKeepingZod deep-clones plain structures exactly like cloneDeep', () => {
    const input = { a: { b: [1, { c: 'd' }] }, e: null }

    const out = cloneDeepKeepingZod(input)

    expect(out).toEqual(input)
    expect(out.a).not.toBe(input.a)
    expect(out.a.b[1]).not.toBe(input.a.b[1])
  })

  /**
   * Given: a zod schema nested inside a collection, the shape custom tool   * definitions actually arrive in.
   * When: the containing structure is cloned.
   * Then: the schema survives as a live instance usable by zod internals.
   */
  test('cloneDeepKeepingZod preserves schemas nested inside collections', () => {
    const schema = z.object({ id: z.number() })
    const input = { tools: [{ name: 'x', inputSchema: schema }] }

    const out = cloneDeepKeepingZod(input)

    expect(out.tools[0].inputSchema).toBe(schema)
    expect(() => z.toJSONSchema(out.tools[0].inputSchema)).not.toThrow()
  })
})
