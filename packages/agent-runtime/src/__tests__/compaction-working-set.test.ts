import { describe, expect, it } from 'bun:test'

import {
  MECHANICAL_HISTORY_TOKENS,
  compactHistoryNow,
} from '../compact-history'
import {
  COMPACTED_READ_MARKER,
  WORKING_SET_TAG,
  outlineOf,
} from '../compaction-working-set'
import { countTokensMessages } from '../util/token-counter'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const user = (text: string, live = false): Message => ({
  role: 'user',
  ...(live ? { tags: ['USER_PROMPT'] } : {}),
  content: [{ type: 'text', text }],
})
const said = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
})
const read = (id: string, files: Record<string, string>): Message[] => [
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: 'read_files',
        input: { paths: Object.keys(files) },
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
        value: Object.entries(files).map(([path, content]) => ({
          path,
          content,
          referencedBy: {},
        })),
      },
    ],
  },
]
const edit = (id: string, path: string): Message[] => [
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: 'str_replace',
        input: { path, replacements: [] },
      },
    ],
  },
  {
    role: 'tool',
    toolCallId: id,
    toolName: 'str_replace',
    content: [{ type: 'json', value: { file: path, message: 'Updated' } }],
  },
]

const source = (name: string, lines: number) =>
  [
    `export function ${name}() {`,
    ...Array.from({ length: lines }, (_, i) => `  // ${name} body ${i}`),
    '}',
  ].join('\n')

/** The working set's read result, as `[{ path, content }]`. */
const workingSet = (messages: Message[]) => {
  const message = messages.find(
    (m) => m.role === 'tool' && m.tags?.includes(WORKING_SET_TAG),
  )
  if (!message || message.role !== 'tool') return undefined
  const part = message.content[0]
  return part.type === 'json'
    ? (part.value as { path: string; content: string }[])
    : undefined
}

/** A long session, then the live request; filler makes the history worth compacting. */
const session = (...work: Message[][]): Message[] => [
  user('Make the uploader retry on 429s.'),
  ...work.flat(),
  said('FILLER '.repeat(30_000)),
  user('Now add jitter.', true),
]

describe('mechanical compaction working set', () => {
  it('re-provides a read file whole, after the live request, and still logs the read', () => {
    const upload = source('upload', 50)
    const compacted = compactHistoryNow({
      messages: session(read('r1', { 'src/upload.ts': upload })),
      maxContextLength: 400_000,
    })!
    const files = workingSet(compacted.messages)
    expect(files).toEqual([{ path: 'src/upload.ts', content: upload }])
    const order = compacted.messages.map((m) =>
      m.tags?.includes('USER_PROMPT')
        ? 'live'
        : m.tags?.includes(WORKING_SET_TAG)
          ? m.role
          : 'other',
    )
    expect(order.slice(-3)).toEqual(['live', 'assistant', 'tool'])
    expect(compacted.summaryText).toContain('inspected files: src/upload.ts')
  })

  it('never re-provides contents the model edited after reading them', () => {
    const compacted = compactHistoryNow({
      messages: session(
        ...[edit('e0', 'a.ts')],
        read('r1', { 'a.ts': source('a', 10), 'b.ts': source('b', 10) }),
        edit('e1', 'b.ts'),
      ),
      maxContextLength: 400_000,
    })!
    const files = workingSet(compacted.messages)!
    // Edited before its read: the read is current.
    expect(files.find((f) => f.path === 'a.ts')!.content).toBe(source('a', 10))
    const b = files.find((f) => f.path === 'b.ts')!.content
    expect(b.startsWith(COMPACTED_READ_MARKER)).toBe(true)
    expect(b).toContain('You edited it after this read')
    expect(b).toContain('L1 export function b()')
  })

  it('carries the newest reads that fit and stubs the rest with an outline', () => {
    const big = source('older', 30_000)
    const compacted = compactHistoryNow({
      messages: session(
        read('r1', { 'older.ts': big }),
        read('r2', { 'newer.ts': source('newer', 20) }),
      ),
      maxContextLength: 400_000,
    })!
    const files = workingSet(compacted.messages)!
    expect(files.map((f) => f.path)).toEqual(['newer.ts', 'older.ts'])
    expect(files[0].content).toBe(source('newer', 20))
    expect(files[1].content).toStartWith(COMPACTED_READ_MARKER)
    expect(files[1].content).toContain('30002 lines when read')
    expect(files[1].content).toContain('L1 export function older()')
    expect(JSON.stringify(compacted.messages)).not.toContain('older body 100')
  })

  it('keeps one entry per file across repeated compactions', () => {
    const first = compactHistoryNow({
      messages: session(
        read('r1', { 'a.ts': source('a', 10) }),
        read('r2', { 'b.ts': source('b', 30_000) }),
      ),
      maxContextLength: 400_000,
    })!
    const second = compactHistoryNow({
      messages: [
        ...first.messages,
        ...read('r3', { 'a.ts': source('a', 12) }),
        said('FILLER '.repeat(30_000)),
        user('And log the retries.', true),
      ],
      maxContextLength: 400_000,
    })!
    const files = workingSet(second.messages)!
    expect(files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts'])
    // The newest read of a.ts wins; the earlier stub of b.ts carries forward.
    expect(files.find((f) => f.path === 'a.ts')!.content).toBe(source('a', 12))
    expect(files.find((f) => f.path === 'b.ts')!.content).toBe(
      workingSet(first.messages)!.find((f) => f.path === 'b.ts')!.content,
    )
    // The previous working set is reads, not a tool call to log again.
    expect(
      second.summaryText.match(/inspected files: a\.ts, b\.ts/g),
    ).toBeNull()
  })

  it('leaves out status results and files the fresh exchange already holds', () => {
    const compacted = compactHistoryNow({
      messages: [
        ...session(
          read('r1', {
            'gone.ts': '[FILE_DOES_NOT_EXIST]',
            'both.ts': source('old', 5),
          }),
        ),
        ...read('fresh', { 'both.ts': source('both', 5) }),
      ],
      maxContextLength: 400_000,
    })
    expect(workingSet(compacted!.messages)).toBeUndefined()
  })

  it('aims the rewritten part at the target without clipping unread results', () => {
    const fresh = read('fresh', { 'huge.ts': source('huge', 3_000) })
    const compacted = compactHistoryNow({
      messages: [
        ...session(read('r1', { 'a.ts': source('a', 2_000) })),
        ...fresh,
      ],
      maxContextLength: 400_000,
      targetTokens: 10_000,
    })!
    expect(compacted.messages.slice(-2)).toEqual(fresh)
    // Over the target only by the fresh exchange the pass may not touch.
    expect(
      compacted.nextTokens - countTokensMessages(fresh),
    ).toBeLessThanOrEqual(10_000)
    expect(compacted.nextTokens).toBeGreaterThan(10_000)
  })
})

describe('mechanical compaction size', () => {
  // A long session: 40 rounds of a request, two file reads and an edit.
  const longSession = (): Message[] => [
    ...Array.from({ length: 40 }, (_, i) => [
      user(`Request ${i}: ${'details '.repeat(400)}`),
      ...read(`r${i}`, {
        [`src/a${i}.ts`]: source(`a${i}`, 600),
        [`src/b${i}.ts`]: source(`b${i}`, 600),
      }),
      ...edit(`e${i}`, `src/b${i}.ts`),
      said(`Done with request ${i}. ${'notes '.repeat(300)}`),
    ]).flat(),
    user('Now wire it together.', true),
  ]

  it('rewrites history into at most MECHANICAL_HISTORY_TOKENS by default', () => {
    const messages = longSession()
    const compacted = compactHistoryNow({
      messages,
      maxContextLength: 400_000,
      fixedTokenCount: 16_000,
    })!
    expect(compacted.previousTokens).toBeGreaterThan(300_000)
    const live = countTokensMessages(messages.slice(-1))
    expect(compacted.nextTokens - live).toBeLessThanOrEqual(
      MECHANICAL_HISTORY_TOKENS,
    )
    // Still carries the newest unedited file and stubs the rest.
    const files = workingSet(compacted.messages)!
    expect(files[0]).toEqual({
      path: 'src/a39.ts',
      content: source('a39', 600),
    })
    expect(
      files.slice(1).every((f) => f.content.startsWith(COMPACTED_READ_MARKER)),
    ).toBe(true)
    expect(compacted.summaryText).toContain('Request 39')
  })

  it('takes a larger history budget when a caller asks for one', () => {
    const compacted = compactHistoryNow({
      messages: longSession(),
      maxContextLength: 400_000,
      fixedTokenCount: 16_000,
      historyTokens: 60_000,
    })!
    expect(compacted.nextTokens).toBeGreaterThan(MECHANICAL_HISTORY_TOKENS * 2)
    expect(compacted.nextTokens).toBeLessThanOrEqual(61_000)
  })
})

describe('outlineOf', () => {
  it('lists top-level declarations with line numbers', () => {
    const { lines, outline } = outlineOf(
      [
        "import x from 'y'",
        'export const LIMIT = 3',
        'const local = 1',
        'export async function upload() {',
        '  function inner() {}',
        '}',
        'class Retry {',
        'def handler(event):',
        'func (s *Server) Start() error {',
        'pub fn parse() -> Result {',
        '## Usage',
      ].join('\n'),
    )
    expect(lines).toBe(11)
    expect(outline.split('\n')).toEqual([
      'L2 export const LIMIT = 3',
      'L4 export async function upload()',
      'L7 class Retry',
      'L8 def handler(event):',
      'L9 func (s *Server) Start() error',
      'L10 pub fn parse() -> Result',
      'L11 ## Usage',
    ])
  })

  it('numbers a windowed read from the window start', () => {
    const { lines, outline } = outlineOf(
      'export function middle() {\n}\n\n[read_files: showing lines 120-121 of 400. Use code_search …]',
    )
    expect(lines).toBe(400)
    expect(outline).toBe('L120 export function middle()')
  })
})
