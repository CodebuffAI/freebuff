import { describe, expect, test } from 'bun:test'

import {
  MAX_SPAWN_AGENTS_PER_CALL,
  spawnAgentsParams,
} from '../params/tool/spawn-agents'

describe('the spawn_agents batch limit', () => {
  const batch = (n: number) => ({
    agents: Array.from({ length: n }, () => ({
      agent_type: 'file-picker',
      prompt: 'find files',
    })),
  })

  test(`${MAX_SPAWN_AGENTS_PER_CALL} agents pass the schema`, () => {
    expect(
      spawnAgentsParams.inputSchema.safeParse(batch(MAX_SPAWN_AGENTS_PER_CALL))
        .success,
    ).toBe(true)
  })

  test(`${MAX_SPAWN_AGENTS_PER_CALL + 1} agents are refused by the schema`, () => {
    const result = spawnAgentsParams.inputSchema.safeParse(
      batch(MAX_SPAWN_AGENTS_PER_CALL + 1),
    )
    expect(result.success).toBe(false)
  })

  test('the 21-agent swarm that ran on 2026-10-10 no longer validates', () => {
    expect(spawnAgentsParams.inputSchema.safeParse(batch(21)).success).toBe(
      false,
    )
  })
})
