import { describe, expect, test } from 'bun:test'
import { detectForeignFreebuffClient } from '@codebuff/common/constants/foreign-client-signals'
import z from 'zod/v4'

import { compactionTools } from '../model-compaction'

/**
 * Runtime toolsets are invisible to the source scan in
 * common/src/__tests__/foreign-client-shipped-agents.test.ts, which only reads
 * `toolNames: [...]` literals. During compaction the runtime offers ONLY
 * `compactionTools`; on 2026-09-23 a detector that did not know it flagged
 * every compaction request and 62 real accounts were banned.
 */
describe('compaction requests are not flagged as a foreign client', () => {
  test('the compaction toolset clears on its own', () => {
    const tools = Object.entries(compactionTools).map(([name, t]) => ({
      type: 'function' as const,
      function: {
        name,
        description: t.description,
        parameters: z.toJSONSchema(t.inputSchema as z.ZodType, { io: 'input' }),
      },
    }))
    expect(tools.length).toBeGreaterThan(0)
    expect(detectForeignFreebuffClient({ tools }).signal).toBeNull()
  })
})
