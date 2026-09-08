import { describe, expect, test } from 'bun:test'

import { parseRawCustomToolCall } from '../../tools/tool-executor'
import { MCP_TOOL_SEPARATOR } from '../../mcp-constants'

import type { CustomToolDefinitions } from '@codebuff/common/util/file'

const TOOL_NAME = `demo${MCP_TOOL_SEPARATOR}record_target`

const UNION_TARGET_SCHEMA = {
  type: 'object',
  properties: {
    target: {
      anyOf: [
        { type: 'string' },
        { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      ],
    },
  },
  required: ['target'],
}

const PLAIN_STRING_SCHEMA = {
  type: 'object',
  properties: { target: { type: 'string' } },
  required: ['target'],
}

type RawInput = Record<string, unknown>

const makeUnionToolDefs = (): CustomToolDefinitions =>
  ({
    [TOOL_NAME]: {
      description: 'Records a file target',
      inputSchema: UNION_TARGET_SCHEMA,
    },
  }) as never

const makeStringToolDefs = (): CustomToolDefinitions =>
  ({
    [TOOL_NAME]: {
      description: 'Records a file target',
      inputSchema: PLAIN_STRING_SCHEMA,
    },
  }) as never

const parseTarget = (
  defs: CustomToolDefinitions,
  rawInput: RawInput,
): { target?: unknown; error?: string } => {
  const result = parseRawCustomToolCall({
    customToolDefs: defs,
    rawToolCall: {
      toolName: TOOL_NAME,
      toolCallId: 'call-target-1',
      input: JSON.stringify(rawInput),
    },
  }) as { input?: RawInput; error?: string }
  return { target: result.input?.target, error: result.error }
}

describe('parseRawCustomToolCall string-encoded union members', () => {
  test('decodes_json_encoded_object_string_for_union_param', () => {
    const defs = makeUnionToolDefs()

    const { target, error } = parseTarget(defs, {
      target: JSON.stringify({ path: 'src/index.ts' }),
    })

    expect(error).toBeUndefined()
    expect(target).toEqual({ path: 'src/index.ts' })
  })

  test('keeps_plain_string_value_for_union_param', () => {
    const defs = makeUnionToolDefs()

    const { target, error } = parseTarget(defs, { target: 'src/plain.txt' })

    expect(error).toBeUndefined()
    expect(target).toBe('src/plain.txt')
  })

  test('keeps_real_object_value_for_union_param', () => {
    const defs = makeUnionToolDefs()

    const { target, error } = parseTarget(defs, {
      target: { path: 'src/obj.ts' },
    })

    expect(error).toBeUndefined()
    expect(target).toEqual({ path: 'src/obj.ts' })
  })

  test('keeps_json_text_for_plain_string_param', () => {
    const defs = makeStringToolDefs()
    const jsonText = '{"path": "src/not-decoded.ts"}'

    const { target, error } = parseTarget(defs, { target: jsonText })

    expect(error).toBeUndefined()
    expect(target).toBe(jsonText)
  })
})
