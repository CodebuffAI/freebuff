/**
 * `compact-history.ts` and `agents/context-pruner.ts` implement the same
 * compaction algorithm and must stay identical, but they cannot share code:
 * the pruner's `handleSteps` is serialized with `toString()` and re-evaluated
 * standalone, so every helper has to live inside its function body (see the
 * comment at the top of that file). Worse, `agents/` is bundled at build time
 * into three separate artifacts, so an old CLI binary keeps its frozen copy —
 * a shared import or a runtime-injected helper would break there.
 *
 * So this test is the link instead: it runs both implementations over the same
 * histories and asserts byte-identical output. If you change one, change the
 * other.
 *
 * Only the summarization algorithm is compared. The pruner's wrapper — its
 * STEP 0 spawn-artifact cleanup, the prompt-cache-expiry trigger, and the
 * pass-through path when the context still fits — has no counterpart in the
 * runtime, which decides when to compact on its own.
 */

import { describe, expect, it } from 'bun:test'

import contextPruner from '../../../../agents/context-pruner'
import { compactMessages } from '../compact-history'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any

/**
 * Runs the pruner in summarization mode over `history`.
 *
 * In production the pruner sees the parent's history plus two artifacts of its
 * own spawn: a USER_PROMPT holding the JSON params and an INSTRUCTIONS_PROMPT.
 * Its STEP 0 strips exactly those, so appending them here leaves it with
 * `history` — the same input the runtime hands `compactMessages`.
 */
function runPruner(history: Message[]): Message[] {
  const messages: Message[] = [
    ...history,
    {
      role: 'user',
      content: [{ type: 'text', text: '<user_message>{"a":1}</user_message>' }],
      tags: ['USER_PROMPT'],
      sentAt: 1,
    },
    {
      role: 'user',
      content: [{ type: 'text', text: 'PRUNER INSTRUCTIONS' }],
      tags: ['INSTRUCTIONS_PROMPT'],
      sentAt: 1,
    },
  ]

  const generator = contextPruner.handleSteps!({
    agentState: {
      agentId: 'context-pruner',
      runId: 'test-run',
      parentId: 'parent-run',
      messageHistory: messages as any,
      output: undefined,
      systemPrompt: '',
      toolDefinitions: {},
      // Far over the budget below, so the pruner summarizes rather than
      // passing the history through untouched.
      contextTokenCount: 1_000_000,
    },
    params: { maxContextLength: 1_000 },
    logger: noopLogger,
  } as any)

  let setMessages: Message[] | undefined
  let result = generator.next()
  while (!result.done) {
    const value: any = result.value
    if (value?.toolName === 'set_messages') {
      setMessages = value.input.messages
    }
    result = generator.next() as any
  }
  if (!setMessages) throw new Error('pruner did not yield set_messages')
  return setMessages
}

/** sentAt is stamped with Date.now() by both sides and is not part of the algorithm. */
const normalize = (messages: Message[]) =>
  messages.map(({ sentAt, ...rest }) => rest)

/** The historical memory blob, which is always the first message out. */
const textOfFirst = (messages: Message[]): string =>
  (messages[0].content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? '')
    .join('\n')

const user = (text: string, tags?: string[]): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ...(tags ? { tags } : {}),
  sentAt: 1,
})

const assistant = (
  text: string,
  toolCalls: Array<{ toolName: string; input: Record<string, unknown> }> = [],
): Message => ({
  role: 'assistant',
  content: [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...toolCalls.map((call, i) => ({
      type: 'tool-call' as const,
      toolCallId: `call-${i}`,
      toolName: call.toolName,
      input: call.input,
    })),
  ],
  sentAt: 1,
})

const toolMessage = (toolName: string, value: unknown): Message => ({
  role: 'tool',
  toolCallId: 'call-0',
  toolName,
  content: [{ type: 'json', value: value as any }],
})

/**
 * One call per `case` in summarizeToolCall, with inputs chosen to reach the
 * interesting sub-branches (both arms of each ternary, the array and the
 * single-agent spawn shapes, todos with and without leftovers).
 */
const EVERY_TOOL_CALL: Array<{
  toolName: string
  input: Record<string, unknown>
}> = [
  { toolName: 'read_files', input: { paths: ['a.ts', { path: 'b.ts' }] } },
  { toolName: 'write_file', input: { path: 'new.ts' } },
  { toolName: 'str_replace', input: { path: 'edit.ts' } },
  { toolName: 'propose_write_file', input: { path: 'proposed.ts' } },
  { toolName: 'propose_str_replace', input: { path: 'proposed-edit.ts' } },
  { toolName: 'read_subtree', input: { paths: ['src', 'test'] } },
  { toolName: 'code_search', input: { pattern: 'needle', flags: '-i' } },
  { toolName: 'code_search', input: { pattern: 'no flags' } },
  { toolName: 'glob', input: { pattern: '**/*.ts' } },
  { toolName: 'list_directory', input: { path: 'src' } },
  { toolName: 'find_files', input: { prompt: 'where is the parser' } },
  { toolName: 'run_terminal_command', input: { command: 'bun test' } },
  {
    toolName: 'run_terminal_command',
    input: { command: `echo ${'long '.repeat(40)}` },
  },
  {
    toolName: 'spawn_agents',
    input: {
      agents: [
        { agent_type: 'file-picker', prompt: 'x'.repeat(2_000) },
        { agent_type: 'thinker', params: { depth: 3 } },
        { agent_type: 'bare' },
      ],
    },
  },
  {
    toolName: 'spawn_agent_inline',
    input: { agent_type: 'context-pruner', params: { maxContextLength: 1 } },
  },
  { toolName: 'spawn_agent_inline', input: { agent_type: 'solo' } },
  {
    toolName: 'write_todos',
    input: {
      todos: [
        { task: 'done one', completed: true },
        { task: 'still open', completed: false },
      ],
    },
  },
  {
    toolName: 'write_todos',
    input: { todos: [{ task: 'all finished', completed: true }] },
  },
  {
    toolName: 'ask_user',
    input: { questions: [{ question: 'q'.repeat(400) }] },
  },
  { toolName: 'suggest_followups', input: {} },
  { toolName: 'web_search', input: { query: 'how to parse' } },
  { toolName: 'read_url', input: { url: 'https://example.com' } },
  { toolName: 'gravity_index', input: { query: 'ads', action: 'search' } },
  { toolName: 'gravity_index', input: { action: 'report' } },
  { toolName: 'read_docs', input: { libraryTitle: 'zod', topic: 'unions' } },
  { toolName: 'read_docs', input: { libraryTitle: 'bun' } },
  { toolName: 'set_output', input: { value: 1 } },
  { toolName: 'set_messages', input: { messages: [] } },
]

const FIXTURES: Record<string, Message[]> = {
  'a fresh prompt with prior work': [
    user('the original request'),
    assistant('here is my plan'),
    user('the live question', ['USER_PROMPT']),
  ],

  'a mid-turn prune': [
    user('build the feature', ['USER_PROMPT']),
    assistant('reading first', [
      { toolName: 'read_files', input: { paths: ['a.ts', { path: 'b.ts' }] } },
    ]),
    toolMessage('read_files', { content: 'file body' }),
    assistant('', [{ toolName: 'str_replace', input: { path: 'a.ts' } }]),
    toolMessage('str_replace', { message: 'replaced 1 occurrence' }),
  ],

  'failures, commands and todos': [
    user('make the tests pass', ['USER_PROMPT']),
    assistant('running them', [
      { toolName: 'run_terminal_command', input: { command: 'bun test' } },
    ]),
    toolMessage('run_terminal_command', { exitCode: 1, stdout: 'boom' }),
    assistant('', [
      {
        toolName: 'write_todos',
        input: {
          todos: [
            { task: 'fix the failing test', completed: false },
            { task: 'read the suite', completed: true },
          ],
        },
      },
    ]),
    toolMessage('glob', { errorMessage: 'no such directory' }),
  ],

  'delegated agents and searches': [
    user('research the codebase'),
    assistant('delegating', [
      {
        toolName: 'spawn_agents',
        input: {
          agents: [
            { agent_type: 'file-picker', prompt: 'find the entrypoints' },
            { agent_type: 'thinker', params: { depth: 3 } },
          ],
        },
      },
    ]),
    toolMessage('spawn_agents', [
      { agentType: 'file-picker', value: { value: 'src/index.ts' } },
      { agentType: 'thinker', value: { value: '<think>hmm</think>do X' } },
    ]),
    assistant('', [
      { toolName: 'code_search', input: { pattern: 'foo', flags: '-i' } },
      { toolName: 'glob', input: { pattern: '**/*.ts' } },
    ]),
    user('now do it', ['USER_PROMPT']),
  ],

  'scaffolding and an instructions prompt': [
    user('older work'),
    assistant('older answer'),
    user('THE PARENT INSTRUCTIONS', ['INSTRUCTIONS_PROMPT']),
    user('THE STEP SCAFFOLD', ['STEP_PROMPT']),
    user('the live question', ['USER_PROMPT']),
  ],

  'long text that gets truncated': [
    user(`a very long request ${'x'.repeat(60_000)}`),
    assistant(`a very long answer ${'y'.repeat(20_000)}`),
    user('the live question', ['USER_PROMPT']),
  ],

  'an image attachment': [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', image: 'data:image/png;base64,AAAA' },
      ],
      sentAt: 1,
    },
    assistant('I see it'),
    user('and now?', ['USER_PROMPT']),
  ],

  // Every branch of summarizeToolCall, which is the bulk of the duplicated
  // code and where a one-sided edit is most likely. Both the populated and the
  // empty-input form of each case, so the fallback strings are compared too.
  'every tool the summarizer knows about': [
    user('exercise everything', ['USER_PROMPT']),
    assistant(
      'doing lots',
      EVERY_TOOL_CALL.map(({ toolName, input }) => ({ toolName, input })),
    ),
    assistant(
      'and again with nothing filled in',
      EVERY_TOOL_CALL.map(({ toolName }) => ({ toolName, input: {} })),
    ),
    assistant('one the switch has never heard of', [
      { toolName: 'some_future_tool', input: { whatever: true } },
    ]),
  ],
}

/**
 * Deliberate divergence #1. With no USER_PROMPT left to restore, the pruner
 * ends the history on the memory blob (base2 always has an INSTRUCTIONS_PROMPT
 * after it, so it never ends on the condensed format). base3 has no
 * instructions prompt, and a second compaction of the runtime's own output has
 * no USER_PROMPT either — so the runtime appends the continuation prompt
 * instead of ending on the memory.
 */
const HISTORIES_WITHOUT_A_LIVE_PROMPT: Record<string, Message[]> = {
  'orphaned assistant work': [assistant('orphaned work')],
  'a second compaction of the runtime output': [
    ...compactMessages({
      messages: [
        user('build the feature', ['USER_PROMPT']),
        assistant('reading first', [
          { toolName: 'read_files', input: { paths: ['a.ts'] } },
        ]),
      ],
    }).messages,
    assistant('more work afterwards'),
  ],
}

describe('context-pruner parity', () => {
  for (const [name, history] of Object.entries(FIXTURES)) {
    it(`matches the pruner on ${name}`, () => {
      const fromRuntime = compactMessages({ messages: history }).messages
      expect(normalize(fromRuntime)).toEqual(normalize(runPruner(history)))
    })
  }

  for (const [name, history] of Object.entries(
    HISTORIES_WITHOUT_A_LIVE_PROMPT,
  )) {
    it(`builds the same memory as the pruner on ${name}, then adds a continuation`, () => {
      const fromRuntime = compactMessages({ messages: history }).messages
      const fromPruner = runPruner(history)

      // Identical memory blob...
      expect(normalize([fromRuntime[0]])).toEqual(normalize([fromPruner[0]]))
      // ...but the runtime refuses to end the history on it.
      expect(fromRuntime).toHaveLength(fromPruner.length + 1)
      expect(
        (fromRuntime[fromRuntime.length - 1].content as any[])[0].text,
      ).toContain('Continue the existing assistant turn')
    })
  }

  it('actually renders every tool branch, so the comparison is not vacuous', () => {
    // Agreeing that everything was dropped would also pass the parity check.
    const memory = textOfFirst(
      compactMessages({
        messages: FIXTURES['every tool the summarizer knows about'],
      }).messages,
    )

    for (const expected of [
      'inspected files: a.ts, b.ts',
      'wrote file: new.ts',
      'edited file: edit.ts',
      'proposed writing: proposed.ts',
      'proposed editing: proposed-edit.ts',
      'inspected subtrees: src, test',
      'code search for "needle" (-i)',
      'glob search for **/*.ts',
      'listed directory: src',
      'file-finding request: "where is the parser"',
      'ran command: bun test',
      'delegated agents:',
      'delegated agent context-pruner',
      'Todos: 1/2 complete',
      'Asked user:',
      'Suggested followups',
      'web search for "how to parse"',
      'read URL: https://example.com',
      'Gravity Index search for "ads"',
      'consulted docs: zod - unions',
      'set structured output',
      'updated message history',
      // The default branch, and the empty-input fallbacks.
      'used tool some_future_tool',
      'inspected files\n',
      'wrote a file',
      'ran a terminal command',
    ]) {
      expect(memory).toContain(expected)
    }
  })

  /**
   * Former divergence #2, closed. The pruner used to treat any user message
   * containing `<conversation_summary>` as a memory artifact — dropping it
   * from the history and re-parsing it as entries, which silently ate a user
   * message that merely mentions the tag, and (as findLast picks the LAST
   * match) let a quoting message steal the real summary's identity and erase
   * the older memory. Both implementations now recognize summaries by the
   * CONVERSATION_SUMMARY tag they stamp, with a legacy full-envelope fallback
   * that a bare tag mention does not satisfy.
   */
  it('keeps a user message that only mentions the tag, in both implementations', () => {
    const history: Message[] = [
      user('why does it emit <conversation_summary> around the memory?'),
      assistant('because the model needs a delimiter'),
      user('got it', ['USER_PROMPT']),
    ]

    const runtimeMemory = textOfFirst(
      compactMessages({ messages: history }).messages,
    )
    const prunerMemory = textOfFirst(runPruner(history))

    expect(runtimeMemory).toContain('why does it emit')
    expect(prunerMemory).toContain('why does it emit')
  })

  it('matches the pruner when a budget evicts old entries', () => {
    const history: Message[] = [
      user('the first request'),
      ...Array.from({ length: 60 }, (_, i) =>
        assistant(`step ${i} ${'z'.repeat(400)}`),
      ),
      user('the live question', ['USER_PROMPT']),
    ]

    const fromRuntime = compactMessages({
      messages: history,
      assistantToolBudget: 2_000,
      userBudget: 3_000,
    }).messages

    const messages: Message[] = [
      ...history,
      {
        role: 'user',
        content: [{ type: 'text', text: '<user_message>{}</user_message>' }],
        tags: ['USER_PROMPT'],
        sentAt: 1,
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'PRUNER INSTRUCTIONS' }],
        tags: ['INSTRUCTIONS_PROMPT'],
        sentAt: 1,
      },
    ]
    const generator = contextPruner.handleSteps!({
      agentState: {
        agentId: 'context-pruner',
        runId: 'test-run',
        messageHistory: messages as any,
        systemPrompt: '',
        toolDefinitions: {},
        contextTokenCount: 1_000_000,
      },
      params: {
        maxContextLength: 1_000,
        assistantToolBudget: 2_000,
        userBudget: 3_000,
      },
      logger: noopLogger,
    } as any)
    let fromPruner: Message[] | undefined
    let result = generator.next()
    while (!result.done) {
      const value: any = result.value
      if (value?.toolName === 'set_messages') fromPruner = value.input.messages
      result = generator.next() as any
    }

    expect(normalize(fromRuntime)).toEqual(normalize(fromPruner!))
  })
})
