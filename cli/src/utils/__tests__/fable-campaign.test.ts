import { describe, expect, test } from 'bun:test'
import {
  FREEBUFF_FABLE_5_1_MODEL_ID,
  isFreebuffSessionModelId,
} from '@codebuff/common/constants/freebuff-models'
import { isFreeModeAllowedAgentModel } from '@codebuff/common/constants/free-agents'

import { bundledAgents } from '../../agents/bundled-agents.generated'
import { getFreebuffCliAgentIdForModel } from '../freebuff-agent-selection'

describe('bundled Fable training campaign', () => {
  test('selects base2 and ships every recursively spawnable helper on an allowed model', () => {
    const rootId = getFreebuffCliAgentIdForModel(FREEBUFF_FABLE_5_1_MODEL_ID)
    expect(rootId).toBe('base2-free-fable')
    expect(
      isFreeModeAllowedAgentModel(
        'base3-free-fable',
        FREEBUFF_FABLE_5_1_MODEL_ID,
      ),
    ).toBe(false)
    const root = bundledAgents[rootId]
    expect(root.model).toBe(FREEBUFF_FABLE_5_1_MODEL_ID)
    expect(root.toolNames).toContain('spawn_agents')
    // Fable repeatedly ended on cards without a written answer in live probes.
    expect(root.toolNames).not.toContain('suggest_followups')
    expect(root.toolNames).toContain('ask_user')
    expect(root.stepPrompt).toBeTruthy()
    expect(root.spawnableAgents).toEqual(
      expect.arrayContaining([
        'file-picker',
        'researcher-web',
        'code-reviewer-fable',
      ]),
    )
    const visited = new Set<string>()
    const pending = [rootId]
    while (pending.length) {
      const id = pending.pop()!
      if (visited.has(id)) continue
      visited.add(id)
      const agent = bundledAgents[id]
      expect(agent, `missing bundled agent: ${id}`).toBeDefined()
      // Pure programmatic compaction never invokes its nominal model.
      if (id === 'context-pruner' || id === 'code-searcher') {
        expect(agent.handleSteps).not.toContain("yield 'STEP'")
        continue
      }
      expect(
        isFreeModeAllowedAgentModel(id, agent.model),
        `${id}: ${agent.model}`,
      ).toBe(true)
      if (isFreebuffSessionModelId(agent.model)) {
        expect(agent.model, `${id} would fail the session-model gate`).toBe(
          root.model,
        )
      }
      pending.push(...(agent.spawnableAgents ?? []))
    }
    expect(visited.has('file-lister')).toBe(true)
    expect(visited.has('tmux-cli-fable')).toBe(true)
    expect(bundledAgents['tmux-cli-fable'].model).toBe(root.model)
    expect(bundledAgents['code-reviewer-fable'].model).toBe(root.model)
    expect(bundledAgents['code-reviewer-fable'].providerOptions).toEqual(
      root.providerOptions,
    )
    expect(bundledAgents['researcher-web'].toolNames).toEqual([
      'web_search',
      'read_url',
    ])
    expect(bundledAgents['researcher-web'].stepPrompt).toBeTruthy()
  })
})
