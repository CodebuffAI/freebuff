import { describe, expect, test } from 'bun:test'

import { parseRawCustomToolCall } from '../tool-executor'

/**
 * Regression tests for schema-guided repair of string-encoded union
 * members in parseRawCustomToolCall.
 */

const buildWithCustomTool = (inputSchema: unknown) => ({
  customToolDefs: {
    'loose-server__loose_union': {
      description: 'Echoes back exactly the arguments it received.',
      inputSchema: inputSchema as never,
      endsAgentStep: false,
    },
  },
  rawToolCall: {
    toolName: 'loose-server__loose_union',
    toolCallId: 'probe-1',
  },
})

const unionSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    spec: {
      anyOf: [{ type: 'string' }, { type: 'object', properties: { kind: { type: 'string' } }, additionalProperties: true }],
      description: 'A string or an object. Either is accepted.',
    },
  },
  required: ['spec'],
  additionalProperties: true,
}

describe('parseRawCustomToolCall: schema-guided repair of string-encoded union members', () => {
  test('decodes a JSON-encoded string for a union param with an object variant', () => {
    const { customToolDefs, rawToolCall } = buildWithCustomTool(unionSchema)
    const withInput = { ...rawToolCall, input: { spec: '{"kind": "unhinged-union-spec", "extra": 42}' } }

    const result = parseRawCustomToolCall({ customToolDefs, rawToolCall: withInput })

    expect((result as { input: { spec: unknown } }).input.spec).toEqual({
      kind: 'unhinged-union-spec',
      extra: 42,
    })
  })

  test('keeps a real object value for a union param unchanged', () => {
    const { customToolDefs, rawToolCall } = buildWithCustomTool(unionSchema)
    const withInput = { ...rawToolCall, input: { spec: { kind: 'plain-object' } } }

    const result = parseRawCustomToolCall({ customToolDefs, rawToolCall: withInput })

    expect((result as { input: { spec: unknown } }).input.spec).toEqual({ kind: 'plain-object' })
  })

  test('keeps a non-JSON string for a union param as a string', () => {
    const { customToolDefs, rawToolCall } = buildWithCustomTool(unionSchema)
    const withInput = { ...rawToolCall, input: { spec: 'plain-string-variant' } }

    const result = parseRawCustomToolCall({ customToolDefs, rawToolCall: withInput })

    expect((result as { input: { spec: unknown } }).input.spec).toBe('plain-string-variant')
  })

  test('does not decode a JSON-encoded string for a plain string-typed param', () => {
    const stringOnlySchema = {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
      additionalProperties: false,
    }
    const { customToolDefs, rawToolCall } = buildWithCustomTool(stringOnlySchema)
    const withInput = { ...rawToolCall, input: { code: '{"looks": "like json"}' } }

    const result = parseRawCustomToolCall({ customToolDefs, rawToolCall: withInput })

    expect((result as { input: { code: unknown } }).input.code).toBe('{"looks": "like json"}')
  })
})
