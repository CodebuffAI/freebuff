import { describe, expect, test } from 'bun:test'

import { findMatchingSpawnAgent, resolveSpawnAgentToReal } from '../spawn-agent-matcher'

import type { SpawnAgentMatch } from '../spawn-agent-matcher'
import type { SpawnAgentInfo } from '../../hooks/stream-state'
import type { AgentContentBlock, ContentBlock } from '../../types/chat'

describe('findMatchingSpawnAgent', () => {
  test('returns null when the map is empty', () => {
    const result = findMatchingSpawnAgent(new Map(), 'file-picker')
    expect(result).toBeNull()
  })

  test('matches an entry with the exact same agent type', () => {
    const map = new Map<string, SpawnAgentInfo>([
      ['temp-1', { index: 0, agentType: 'file-picker' }],
    ])
    const result = findMatchingSpawnAgent(map, 'file-picker')
    expect(result).toEqual({
      tempId: 'temp-1',
      info: { index: 0, agentType: 'file-picker' },
    })
  })

  test('matches by base name, ignoring scope and version on the stored entry', () => {
    const map = new Map<string, SpawnAgentInfo>([
      ['temp-1', { index: 0, agentType: 'codebuff/file-picker@0.0.2' }],
    ])
    const result = findMatchingSpawnAgent(map, 'file-picker')
    expect(result?.tempId).toBe('temp-1')
  })

  test('matches by base name, ignoring scope and version on the event type', () => {
    const map = new Map<string, SpawnAgentInfo>([
      ['temp-1', { index: 0, agentType: 'file-picker' }],
    ])
    const result = findMatchingSpawnAgent(map, 'codebuff/file-picker@1.0.0')
    expect(result?.tempId).toBe('temp-1')
  })

  test('matches when both sides use underscores vs hyphens inconsistently', () => {
    const map = new Map<string, SpawnAgentInfo>([
      ['temp-1', { index: 0, agentType: 'code_reviewer_lite' }],
    ])
    const result = findMatchingSpawnAgent(map, 'code-reviewer-lite')
    expect(result?.tempId).toBe('temp-1')
  })

  test('returns null when no entry has a matching base name', () => {
    const map = new Map<string, SpawnAgentInfo>([
      ['temp-1', { index: 0, agentType: 'file-picker' }],
    ])
    const result = findMatchingSpawnAgent(map, 'code-searcher')
    expect(result).toBeNull()
  })

  test('treats an empty event agent type as its own base name', () => {
    const map = new Map<string, SpawnAgentInfo>([
      ['temp-1', { index: 0, agentType: '' }],
    ])
    const result = findMatchingSpawnAgent(map, '')
    expect(result?.tempId).toBe('temp-1')
  })

  test('returns the first matching entry in map iteration order', () => {
    // Two placeholders were spawned for the same agent type (e.g. two
    // parallel file-picker calls); the first one inserted should resolve
    // first.
    const map = new Map<string, SpawnAgentInfo>([
      ['temp-1', { index: 0, agentType: 'file-picker' }],
      ['temp-2', { index: 1, agentType: 'file-picker' }],
    ])
    const result = findMatchingSpawnAgent(map, 'file-picker')
    expect(result?.tempId).toBe('temp-1')
  })

  test('does not match an unrelated entry that appears earlier in the map', () => {
    const map = new Map<string, SpawnAgentInfo>([
      ['temp-1', { index: 0, agentType: 'code-searcher' }],
      ['temp-2', { index: 1, agentType: 'file-picker' }],
    ])
    const result = findMatchingSpawnAgent(map, 'file-picker')
    expect(result?.tempId).toBe('temp-2')
  })
})

describe('resolveSpawnAgentToReal', () => {
  const baseBlock: AgentContentBlock = {
    type: 'agent',
    agentId: 'temp-1',
    agentName: 'Temp',
    agentType: 'file-picker',
    content: '',
    status: 'running',
    blocks: [],
    initialPrompt: '',
  }

  const match: SpawnAgentMatch = {
    tempId: 'temp-1',
    info: { index: 0, agentType: 'file-picker' },
  }

  test('replaces the placeholder agent id with the real agent id', () => {
    const blocks: ContentBlock[] = [baseBlock]
    const result = resolveSpawnAgentToReal({
      blocks,
      match,
      realAgentId: 'real-1',
    })
    expect((result[0] as AgentContentBlock).agentId).toBe('real-1')
  })

  test('carries realAgentType, params and prompt through to the resolved block', () => {
    const blocks: ContentBlock[] = [baseBlock]
    const result = resolveSpawnAgentToReal({
      blocks,
      match,
      realAgentId: 'real-1',
      realAgentType: 'codebuff/file-picker@1.0.0',
      params: { query: 'hello' },
      prompt: 'find the config file',
    })
    const resolved = result[0] as AgentContentBlock
    expect(resolved.agentId).toBe('real-1')
    expect(resolved.agentType).toBe('codebuff/file-picker@1.0.0')
    expect(resolved.params).toEqual({ query: 'hello' })
    expect(resolved.initialPrompt).toBe('find the config file')
  })

  test('moves the resolved block under parentAgentId when provided', () => {
    // The placeholder starts at the top level, alongside its future parent,
    // so this actually exercises the extract-and-nest branch rather than the
    // already-nested update-in-place branch.
    const parentBlock: AgentContentBlock = {
      type: 'agent',
      agentId: 'parent-1',
      agentName: 'Parent',
      agentType: 'orchestrator',
      content: '',
      status: 'running',
      blocks: [],
      initialPrompt: '',
    }
    const result = resolveSpawnAgentToReal({
      blocks: [parentBlock, baseBlock],
      match,
      realAgentId: 'real-1',
      parentAgentId: 'parent-1',
    })
    // The placeholder is removed from the top level...
    expect(result).toHaveLength(1)
    const parent = result[0] as AgentContentBlock
    expect(parent.agentId).toBe('parent-1')
    // ...and inserted under the parent instead.
    expect(parent.blocks).toHaveLength(1)
    expect((parent.blocks![0] as AgentContentBlock).agentId).toBe('real-1')
  })

  test('updates the resolved block in place when already under parentAgentId', () => {
    const parentBlock: AgentContentBlock = {
      type: 'agent',
      agentId: 'parent-1',
      agentName: 'Parent',
      agentType: 'orchestrator',
      content: '',
      status: 'running',
      blocks: [baseBlock],
      initialPrompt: '',
    }
    const result = resolveSpawnAgentToReal({
      blocks: [parentBlock],
      match,
      realAgentId: 'real-1',
      parentAgentId: 'parent-1',
    })
    const parent = result[0] as AgentContentBlock
    expect(parent.blocks).toHaveLength(1)
    expect((parent.blocks![0] as AgentContentBlock).agentId).toBe('real-1')
  })

  test('leaves other blocks untouched', () => {
    const otherBlock: ContentBlock = { type: 'text', content: 'unrelated' }
    const blocks: ContentBlock[] = [baseBlock, otherBlock]
    const result = resolveSpawnAgentToReal({
      blocks,
      match,
      realAgentId: 'real-1',
    })
    expect(result[1]).toEqual(otherBlock)
  })
})
