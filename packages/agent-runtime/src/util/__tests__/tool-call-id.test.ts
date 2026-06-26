import { getInitialAgentState } from '@codebuff/common/types/session-state'
import { assistantMessage } from '@codebuff/common/util/messages'
import { describe, expect, it } from 'bun:test'

import {
  createToolCallIdGenerator,
  ensureToolCallState,
  formatToolCallId,
  getMaxSeenToolCallIndex,
} from '../tool-call-id'

describe('tool call ids', () => {
  const createAgentState = () => getInitialAgentState()

  it('formats ids with the tool name and global invocation index', () => {
    expect(formatToolCallId('glob', 0)).toBe('functions.glob.0')
  })

  it('seeds the global counter from existing message history', () => {
    const messages = [
      assistantMessage({
        type: 'tool-call',
        toolName: 'glob',
        toolCallId: 'functions.glob.0',
        input: { pattern: '**/*.ts' },
      }),
      assistantMessage({
        type: 'tool-call',
        toolName: 'read_files',
        toolCallId: 'functions.read_files.1',
        input: { paths: ['src/index.ts'] },
      }),
      assistantMessage({
        type: 'tool-call',
        toolName: 'glob',
        toolCallId: 'functions.glob.2',
        input: { pattern: '**/*.tsx' },
      }),
    ]

    expect(getMaxSeenToolCallIndex(messages)).toBe(2)

    const agentState = createAgentState()
    agentState.messageHistory = messages
    const getToolCallId = createToolCallIdGenerator(agentState)

    expect(getToolCallId('glob')).toBe('functions.glob.3')
    expect(getToolCallId('glob')).toBe('functions.glob.4')
    expect(getToolCallId('read_files')).toBe('functions.read_files.5')
  })

  it('increments the global counter for hidden calls missing from history', () => {
    const getToolCallId = createToolCallIdGenerator(createAgentState())

    expect(getToolCallId('read_files')).toBe('functions.read_files.0')
    expect(getToolCallId('end_turn')).toBe('functions.end_turn.1')
    expect(getToolCallId('read_files')).toBe('functions.read_files.2')
  })

  it('can seed the global counter from pending tool calls', () => {
    const getToolCallId = createToolCallIdGenerator(createAgentState(), [
      {
        toolName: 'glob',
      },
      {
        toolName: 'glob',
      },
    ])

    expect(getToolCallId('glob')).toBe('functions.glob.2')
  })

  it('can seed from the legacy colon deterministic id shape', () => {
    const messages = [
      assistantMessage({
        type: 'tool-call',
        toolName: 'glob',
        toolCallId: 'functions.glob:4',
        input: { pattern: '**/*.ts' },
      }),
    ]

    const agentState = createAgentState()
    agentState.messageHistory = messages

    expect(createToolCallIdGenerator(agentState)('glob')).toBe(
      'functions.glob.5',
    )
  })

  it('stores the counter in agent state across generator instances', () => {
    const agentState = createAgentState()

    expect(createToolCallIdGenerator(agentState)('glob')).toBe(
      'functions.glob.0',
    )
    expect(createToolCallIdGenerator(agentState)('read_files')).toBe(
      'functions.read_files.1',
    )
    expect(agentState.toolCallState).toEqual({ nextIndex: 2 })
  })

  it('shares a state object across agent states', () => {
    const parentState = createAgentState()
    const childState = createAgentState()
    childState.toolCallState = ensureToolCallState(parentState)

    expect(createToolCallIdGenerator(parentState)('glob')).toBe(
      'functions.glob.0',
    )
    expect(createToolCallIdGenerator(childState)('read_files')).toBe(
      'functions.read_files.1',
    )
    expect(parentState.toolCallState).toEqual({ nextIndex: 2 })
  })
})
