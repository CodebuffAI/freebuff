import { describe, expect, it } from 'bun:test'

import {
  closeCompactionWindow,
  measureCompactionWindow,
  openCompactionWindow,
} from '../compaction-followup'
import { COMPACTED_READ_MARKER } from '../compaction-working-set'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const read = (id: string, paths: unknown[]): Message[] => [
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: 'read_files',
        input: { paths },
      },
    ],
  },
  {
    role: 'tool',
    toolCallId: id,
    toolName: 'read_files',
    content: [
      {
        type: 'json',
        value: paths.map((entry) => ({
          path:
            typeof entry === 'string'
              ? entry
              : (entry as { path: string }).path,
          content: 'BODY',
        })),
      },
    ],
  },
]

const summary: Message = {
  role: 'user',
  content: [{ type: 'text', text: '<conversation_summary>…' }],
}

describe('compaction follow-up window', () => {
  // a.ts and b.ts were read; the compaction kept the fresh read of b.ts.
  const before = [
    ...read('r1', ['a.ts']),
    ...read('r2', [{ path: 'b.ts', offset: 10 }]),
  ]
  const after = [summary, ...read('r2', [{ path: 'b.ts', offset: 10 }])]

  it('counts only files the compaction dropped as elided', () => {
    const window = openCompactionWindow({
      before,
      after,
      trigger: 'context_limit',
      now: 0,
    })
    expect([...window.elidedPaths]).toEqual(['a.ts'])
  })

  it('a working-set stub names a file without carrying it', () => {
    const stubbed: Message[] = [
      summary,
      {
        role: 'tool',
        toolCallId: 'ws',
        toolName: 'read_files',
        content: [
          {
            type: 'json',
            value: [
              { path: 'b.ts', content: 'BODY' },
              { path: 'a.ts', content: `${COMPACTED_READ_MARKER}. 3 lines.]` },
            ],
          },
        ],
      },
    ]
    const window = openCompactionWindow({
      before,
      after: stubbed,
      trigger: 'context_limit',
      now: 0,
    })
    expect([...window.elidedPaths]).toEqual(['a.ts'])
  })

  it('a re-read of a dropped file is a re-read; a carried one is not new', () => {
    const window = openCompactionWindow({
      before,
      after,
      trigger: 'context_limit',
      now: 0,
    })
    const now = [
      ...after,
      ...read('r3', ['a.ts', 'c.ts']),
      ...read('r4', ['a.ts']),
    ]
    expect(measureCompactionWindow(window, now)).toMatchObject({
      elided_read_paths: 1,
      read_calls_after: 2,
      read_paths_after: 2,
      reread_paths: 1,
      tool_calls_after: 2,
    })
  })

  it('logs counts only, and never throws from a broken logger', () => {
    const window = openCompactionWindow({
      before,
      after,
      trigger: 'cache_expiry',
      now: 1_000,
    })
    const logged: Record<string, unknown>[] = []
    closeCompactionWindow({
      window,
      messages: [...after, ...read('r3', ['a.ts'])],
      endedBy: 'compaction',
      nextTrigger: 'context_limit',
      logger: {
        info: (data: Record<string, unknown>) => logged.push(data),
      } as any,
      runId: 'run-1',
      model: 'm',
      now: 4_000,
    })
    expect(logged).toEqual([
      expect.objectContaining({
        axiomEvent: 'context_compaction.followup',
        trigger_reason: 'cache_expiry',
        ended_by: 'compaction',
        next_trigger_reason: 'context_limit',
        reread_paths: 1,
        window_ms: 3_000,
      }),
    ])
    expect(JSON.stringify(logged)).not.toContain('a.ts')
    expect(() =>
      closeCompactionWindow({
        window,
        messages: after,
        endedBy: 'run_end',
        logger: {
          info: () => {
            throw new Error('sink down')
          },
        } as any,
      }),
    ).not.toThrow()
  })
})
