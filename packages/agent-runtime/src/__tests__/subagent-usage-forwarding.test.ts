import { describe, expect, test } from 'bun:test'

import { extractSubagentContextParams } from '../tools/handlers/tool/spawn-agent-utils'

import type { SubagentContextParams } from '../tools/handlers/tool/spawn-agent-utils'

describe('extractSubagentContextParams', () => {
  test("passes the parent's usage callbacks to the subagent", () => {
    const onAgentUsageReceived = () => {}
    const onAgentUsageIncomplete = () => {}
    const extracted = extractSubagentContextParams({
      onAgentUsageReceived,
      onAgentUsageIncomplete,
    } as unknown as SubagentContextParams)
    expect(extracted.onAgentUsageReceived).toBe(onAgentUsageReceived)
    expect(extracted.onAgentUsageIncomplete).toBe(onAgentUsageIncomplete)
  })
})
