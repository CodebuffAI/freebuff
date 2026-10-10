import { describe, expect, test } from 'bun:test'

import {
  THREAD_GROUPS,
  arrangeThreadPanel,
  moveThreadGroup,
  threadDigestSchema,
  threadGroup,
  threadPanel,
  threadStatusLine,
  threadStepCount,
  type ThreadDigest,
} from './threads'

const digest = (patch: Partial<ThreadDigest> = {}): ThreadDigest => ({
  id: 'thread-1',
  kind: 'cloud',
  title: 'Fix login',
  runState: 'idle',
  outcome: 'completed',
  steps: [],
  statusLine: null,
  lastMessage: null,
  pendingQuestion: null,
  pullRequest: null,
  resolvedAt: null,
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  ...patch,
})

const question = { id: 'q1', question: 'Ship it?', options: ['Yes', 'No'] }
const pr = { url: 'https://github.com/o/r/pull/1', number: 1, state: 'open' as const, conflict: false }

describe('threadGroup', () => {
  test('resolved wins, then waiting, then working', () => {
    expect(threadGroup(digest({ resolvedAt: '2026-10-10T01:00:00.000Z', pendingQuestion: question }))).toBe('resolved')
    expect(threadGroup(digest({ runState: 'running', pendingQuestion: question }))).toBe('waiting')
    expect(threadGroup(digest({ outcome: 'failed' }))).toBe('waiting')
    expect(threadGroup(digest({ pullRequest: { ...pr, conflict: true } }))).toBe('waiting')
    expect(threadGroup(digest({ pullRequest: { ...pr, state: 'merged', conflict: true } }))).toBe('idle')
    expect(threadGroup(digest({ runState: 'queued' }))).toBe('working')
    expect(threadGroup(digest({ runState: 'running', outcome: 'failed' }))).toBe('working')
    expect(threadGroup(digest())).toBe('idle')
  })

  test('kind never changes the group or the status line', () => {
    const cases: Partial<ThreadDigest>[] = [
      {},
      { runState: 'running', steps: [{ text: 'Write tests', state: 'active' }] },
      { pendingQuestion: question },
      { outcome: 'failed' },
      { lastMessage: 'Done, PR is up' },
    ]
    for (const patch of cases) {
      const cloud = digest({ ...patch, kind: 'cloud' })
      const local = digest({ ...patch, kind: 'local' })
      expect(threadGroup(local)).toBe(threadGroup(cloud))
      expect(threadStatusLine(local)).toBe(threadStatusLine(cloud))
    }
  })
})

test('status line falls back through the shared fields', () => {
  expect(threadStatusLine(digest({ statusLine: 'Running tests', pendingQuestion: question }))).toBe('Ship it?')
  expect(threadStatusLine(digest({ statusLine: 'Running tests' }))).toBe('Running tests')
  expect(threadStatusLine(digest({ runState: 'queued' }))).toBe('Queued')
  expect(threadStatusLine(digest({ runState: 'running', steps: [{ text: 'Write tests', state: 'active' }] }))).toBe('Write tests')
  expect(threadStatusLine(digest({ runState: 'running' }))).toBe('Working')
  expect(threadStatusLine(digest({ outcome: 'failed' }))).toBe('Turn failed')
  expect(threadStatusLine(digest({ lastMessage: 'All done' }))).toBe('All done')
  expect(threadStatusLine(digest({ outcome: null }))).toBe('Not started')
})

test('step count', () => {
  expect(threadStepCount(digest())).toBeNull()
  expect(
    threadStepCount(digest({ steps: [
      { text: 'a', state: 'done' },
      { text: 'b', state: 'done' },
      { text: 'c', state: 'active' },
      { text: 'd', state: 'pending' },
    ] })),
  ).toEqual({ done: 2, total: 4 })
})

test('panel mixes kinds in one model, newest first, with a headline', () => {
  const panel = threadPanel([
    digest({ id: 'a', kind: 'local', pendingQuestion: question, updatedAt: '2026-10-10T00:01:00.000Z' }),
    digest({ id: 'b', kind: 'cloud', outcome: 'failed', updatedAt: '2026-10-10T00:02:00.000Z' }),
    digest({ id: 'c', kind: 'local', runState: 'running' }),
    digest({ id: 'd', kind: 'cloud', resolvedAt: '2026-10-10T00:03:00.000Z' }),
  ])
  expect(panel.headline).toBe('2 threads need you')
  expect(panel.groups.map((g) => [g.label, g.threads.map((t) => t.id)])).toEqual([
    ['Waiting on you', ['b', 'a']],
    ['Working', ['c']],
    ['Idle', []],
    ['Resolved', ['d']],
  ])
  expect(threadPanel([digest({ runState: 'running' })]).headline).toBe('1 thread working')
  expect(threadPanel([digest()]).headline).toBe('All clear')
  expect(threadPanel([]).headline).toBe('No threads yet')
})

test('schema is strict and accepts both kinds', () => {
  expect(threadDigestSchema.parse(digest({ kind: 'local' }))).toEqual(digest({ kind: 'local' }))
  expect(threadDigestSchema.safeParse({ ...digest(), extra: 1 }).success).toBe(false)
  expect(threadDigestSchema.safeParse(digest({ kind: 'remote' as never })).success).toBe(false)
})

test('the viewer arranges groups and pins threads to the top of their group', () => {
  const { groups } = threadPanel([
    digest({ id: 'old', updatedAt: '2026-10-10T01:00:00Z' }),
    digest({ id: 'new', updatedAt: '2026-10-10T02:00:00Z' }),
    digest({ id: 'pinned', updatedAt: '2026-10-10T00:00:00Z' }),
  ])
  const arranged = arrangeThreadPanel(groups, {
    order: ['resolved', 'idle', 'bogus'],
    pinned: new Set(['pinned']),
  })
  expect(arranged.map((entry) => entry.group)).toEqual(['resolved', 'idle', 'waiting', 'working'])
  expect(arranged[1].threads.map((entry) => entry.id)).toEqual(['pinned', 'new', 'old'])
  expect(arrangeThreadPanel(groups).map((entry) => entry.group)).toEqual([...THREAD_GROUPS])
})

test('moving a group puts it where the target was', () => {
  expect(moveThreadGroup(THREAD_GROUPS, 'resolved', 'waiting')).toEqual(['resolved', 'waiting', 'working', 'idle'])
  expect(moveThreadGroup(THREAD_GROUPS, 'waiting', 'idle')).toEqual(['working', 'idle', 'waiting', 'resolved'])
  expect(moveThreadGroup(['idle'], 'idle', 'resolved')).toEqual(['waiting', 'working', 'resolved', 'idle'])
})
