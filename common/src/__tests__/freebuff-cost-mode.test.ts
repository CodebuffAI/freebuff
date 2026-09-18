import { describe, expect, test } from 'bun:test'

import {
  isFreebuffCostModeEscalation,
  isFreebuffOnlyAgentId,
  parseExemptUserIds,
} from '../constants/freebuff-cost-mode'
import { FREEBUFF_ROOT_AGENT_IDS, isFreeMode } from '../constants/free-agents'

describe('isFreebuffOnlyAgentId', () => {
  test('every freebuff root counts', () => {
    for (const id of FREEBUFF_ROOT_AGENT_IDS) {
      expect(isFreebuffOnlyAgentId(id)).toBe(true)
    }
  })

  test('a non-codebuff publisher cannot borrow the id', () => {
    // Same publisher-spoof rule the other gates in free-agents.ts apply.
    expect(isFreebuffOnlyAgentId('base3-free-deepseek-flash')).toBe(true)
    expect(isFreebuffOnlyAgentId('codebuff/base3-free-deepseek-flash')).toBe(
      true,
    )
    expect(isFreebuffOnlyAgentId('someone/base3-free-deepseek-flash')).toBe(
      false,
    )
  })

  test('agents that are not freebuff-only do not count', () => {
    // The bridge ids the reported traffic used, and ordinary paid agents.
    for (const id of ['fb-bridge-z-ai-glm-5-3-flash', 'fb-diag', 'base', '']) {
      expect(isFreebuffOnlyAgentId(id)).toBe(false)
    }
  })
})

describe('isFreebuffCostModeEscalation', () => {
  test('a freebuff agent outside free mode is an escalation', () => {
    expect(
      isFreebuffCostModeEscalation({
        agentId: 'base3-free-glm-5-3-flash',
        isFreeModeRequest: isFreeMode('normal'),
      }),
    ).toBe(true)
  })

  test('the same agent in free mode is ordinary traffic', () => {
    expect(
      isFreebuffCostModeEscalation({
        agentId: 'base3-free-glm-5-3-flash',
        isFreeModeRequest: isFreeMode('free'),
      }),
    ).toBe(false)
  })

  test('a paid agent outside free mode is untouched', () => {
    // 4,711 accounts use both modes and thousands of paying customers send
    // metered requests for these models; this rule must never see them.
    for (const id of ['base', 'fb-bridge-z-ai-glm-5-3-flash']) {
      expect(
        isFreebuffCostModeEscalation({
          agentId: id,
          isFreeModeRequest: false,
        }),
      ).toBe(false)
    }
  })
})

describe('parseExemptUserIds', () => {
  test('parses, trims and tolerates an empty setting', () => {
    expect(parseExemptUserIds(undefined).size).toBe(0)
    expect(parseExemptUserIds('').size).toBe(0)
    const ids = parseExemptUserIds(' a-1 , b-2,, c-3 ')
    expect([...ids].sort()).toEqual(['a-1', 'b-2', 'c-3'])
  })
})
