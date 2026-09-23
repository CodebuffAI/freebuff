import { expect, test } from 'bun:test'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'

import { assertUserContentSize, boundToolResult } from '../context-size-guard'
import { countTokensMessages } from '../token-counter'

import type { ToolMessage } from '@codebuff/common/types/messages/codebuff-message'

const getMockAgentTemplate = () => createTestAgentRuntimeParams().agentTemplate

test('bounds nested tool output without mutating it or suggesting a mutation be repeated', () => {
  const template = getMockAgentTemplate()
  const original: ToolMessage = {
    role: 'tool',
    toolCallId: 'write',
    toolName: 'run_terminal_command',
    content: [
      { type: 'json', value: { stdout: 'A'.repeat(2_500_000), exitCode: 0 } },
    ],
  }
  const bounded = boundToolResult(original, template)
  expect(countTokensMessages([bounded])).toBeLessThanOrEqual(64_000)
  expect(JSON.stringify(bounded)).toContain(
    'do not repeat state-changing actions',
  )
  expect(JSON.stringify(original).length).toBeGreaterThan(2_500_000)
  expect(bounded.toolCallId).toBe('write')
})

test('refuses a huge new user message instead of silently truncating instructions', () => {
  expect(() =>
    assertUserContentSize(
      [
        {
          role: 'user',
          content: [{ type: 'text', text: ' '.repeat(2_500_000) }],
        },
      ],
      getMockAgentTemplate(),
    ),
  ).toThrow('new message is too large')
})

test('a smaller model bounds tool results by its own window', () => {
  const template = {
    ...getMockAgentTemplate(),
    compactContext: { maxContextLength: 4096 },
  }
  const result: ToolMessage = {
    role: 'tool',
    toolCallId: 'r',
    toolName: 'custom',
    content: [{ type: 'json', value: 'x'.repeat(30_000) }],
  }
  expect(
    countTokensMessages([boundToolResult(result, template)]),
  ).toBeLessThanOrEqual(1024)
})
