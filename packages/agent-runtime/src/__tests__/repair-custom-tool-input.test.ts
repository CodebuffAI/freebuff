import { describe, expect, test } from 'bun:test'

import { repairCustomToolInput } from '../util/repair-custom-tool-input'

const schema = {
  type: 'object',
  properties: {
    calls: { type: 'array', items: { type: 'object' } },
    timeoutMs: { type: 'number', maximum: 60000 },
    target: { anyOf: [{ type: 'string' }, { type: 'object' }] },
    script: { type: 'string' },
  },
}

describe('repairCustomToolInput', () => {
  test('decodes an array sent as a JSON string, repairing it if needed', () => {
    const input: Record<string, unknown> = { calls: '[{"tool": "NOTION_CREATE_PAGE", "arguments": {"title": "say "hi""}}]' }
    repairCustomToolInput(input, schema)
    expect(input.calls).toEqual([
      { tool: 'NOTION_CREATE_PAGE', arguments: { title: 'say "hi"' } },
    ])
  })

  test('clamps a number above the maximum', () => {
    const input: Record<string, unknown> = { timeoutMs: 90000 }
    repairCustomToolInput(input, schema)
    expect(input.timeoutMs).toBe(60000)
  })

  test('decodes a union object but keeps its plain strings and string parameters', () => {
    const input: Record<string, unknown> = { target: '{"x": 1}', script: '{"a": 1}' }
    repairCustomToolInput(input, schema)
    expect(input).toEqual({ target: { x: 1 }, script: '{"a": 1}' })
    const plain: Record<string, unknown> = { target: 'the button' }
    repairCustomToolInput(plain, schema)
    expect(plain.target).toBe('the button')
  })
})
