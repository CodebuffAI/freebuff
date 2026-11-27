import { expect, test } from 'bun:test'

import {
  DESTRUCTIVE_TOOLS,
  areDestructiveToolsBlocked,
  isDestructiveTool,
  isDestructiveToolBlocked,
} from '../destructive-tool-gate'

test('destructive tool classification', () => {
  expect(isDestructiveTool('write_file')).toBe(true)
  expect(isDestructiveTool('str_replace')).toBe(true)
  expect(isDestructiveTool('apply_patch')).toBe(true)
  expect(isDestructiveTool('run_terminal_command')).toBe(true)
  expect(isDestructiveTool('read_files')).toBe(false)
  expect(isDestructiveTool('glob')).toBe(false)
  expect(isDestructiveTool(123 as any)).toBe(false)
  expect(isDestructiveTool('')).toBe(false)
})

test('DESTRUCTIVE_TOOLS contains expected tools', () => {
  expect(DESTRUCTIVE_TOOLS.has('write_file')).toBe(true)
  expect(DESTRUCTIVE_TOOLS.size).toBe(4)
})

test('read-only mode is off by default', () => {
  expect(areDestructiveToolsBlocked(undefined)).toBe(false)
  expect(areDestructiveToolsBlocked({})).toBe(false)
  expect(areDestructiveToolsBlocked({ blockDestructiveTools: false })).toBe(false)
})

test('read-only mode switches on when the agent opts in', () => {
  expect(areDestructiveToolsBlocked({ blockDestructiveTools: true })).toBe(true)
})

const readOnly = { blockDestructiveTools: true }

test('a read-only agent blocks every destructive tool', () => {
  for (const toolName of DESTRUCTIVE_TOOLS) {
    expect(isDestructiveToolBlocked(readOnly, toolName)).toBe(true)
  }
})

test('a read-only agent still runs non-destructive tools', () => {
  expect(isDestructiveToolBlocked(readOnly, 'read_files')).toBe(false)
  expect(isDestructiveToolBlocked(readOnly, 'code_search')).toBe(false)
})

test('no agent is blocked unless it opts in', () => {
  expect(isDestructiveToolBlocked(undefined, 'write_file')).toBe(false)
  expect(isDestructiveToolBlocked({}, 'run_terminal_command')).toBe(false)
  expect(
    isDestructiveToolBlocked({ blockDestructiveTools: false }, 'apply_patch'),
  ).toBe(false)
})

test('a tool call cannot talk its way past read-only mode', () => {
  // The decision reads the agent template, never the tool-call input, so a call
  // carrying `confirmed: true` changes nothing.
  const selfConfirmed = { confirmed: true } as unknown as {
    blockDestructiveTools?: boolean
  }
  expect(isDestructiveToolBlocked(selfConfirmed, 'write_file')).toBe(false)
  expect(isDestructiveToolBlocked(readOnly, 'write_file')).toBe(true)
})
