import { describe, expect, it } from 'bun:test'

import { compactMessages } from '../compact-history'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const user = (text: string, tags?: string[]): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ...(tags ? { tags } : {}),
  sentAt: 1,
})

const assistant = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  sentAt: 1,
})

const assistantToolCall = (
  toolName: string,
  input: Record<string, unknown>,
): Message => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: 'c1', toolName, input }],
  sentAt: 1,
})

const toolResult = (toolName: string, value: unknown): Message => ({
  role: 'tool',
  toolCallId: 'c1',
  toolName,
  content: [{ type: 'json', value: value as any }],
})

const textOf = (message: Message): string =>
  Array.isArray(message.content)
    ? message.content
        .map((part) => ('text' in part ? part.text : ''))
        .join('\n')
    : String(message.content)

const compact = (messages: Message[]) => compactMessages({ messages }).messages

describe('compactMessages', () => {
  it('replaces history with a mechanical summary and keeps the live user prompt', () => {
    const result = compact([
      user('old question'),
      assistant('old answer'),
      user('the live question', ['USER_PROMPT']),
    ])

    expect(result).toHaveLength(2)
    expect(textOf(result[0])).toContain('<conversation_summary>')
    expect(textOf(result[0])).toContain('old question')
    expect(textOf(result[0])).toContain('old answer')
    expect(result[1].role).toBe('user')
    expect(textOf(result[1])).toContain('the live question')
  })

  it('keeps the concrete details of the work: files, edits, commands', () => {
    const summary = textOf(
      compact([
        user('fix the bug', ['USER_PROMPT']),
        assistantToolCall('read_files', {
          paths: [{ path: 'src/server.ts', offset: 0, limit: 200 }],
        }),
        assistantToolCall('str_replace', { path: 'src/server.ts' }),
        assistantToolCall('run_terminal_command', { command: 'bun test' }),
        toolResult('run_terminal_command', { exitCode: 1 }),
      ])[0],
    )

    expect(summary).toContain('inspected files: src/server.ts')
    expect(summary).toContain('edited file: src/server.ts')
    expect(summary).toContain('ran command: bun test')
    expect(summary).toContain('Command failed with exit code: 1')
  })

  it('keeps subagent results, plain-text answers and structured output alike', () => {
    const summary = textOf(
      compact([
        user('think it through', ['USER_PROMPT']),
        assistantToolCall('spawn_agents', {
          agents: [{ agent_type: 'thinker-gemini' }, { agent_type: 'planner' }],
        }),
        toolResult('spawn_agents', [
          { agentType: 'thinker-gemini', value: 'The ball costs $0.05.' },
          {
            agentType: 'planner',
            value: { type: 'structuredOutput', value: { steps: 2 } },
          },
        ]),
      ])[0],
    )

    expect(summary).toContain('- thinker-gemini: The ball costs $0.05.')
    expect(summary).toContain('- planner: {"steps":2}')
  })

  it('appends a continuation prompt on a mid-turn prune', () => {
    const result = compact([
      user('the live question', ['USER_PROMPT']),
      assistant('working on it'),
    ])

    expect(result).toHaveLength(2)
    expect(textOf(result[1])).toContain('Continue the existing assistant turn')
    // Mid-turn, the live prompt moves into the memory instead of being dropped.
    expect(textOf(result[0])).toContain('the live question')
  })

  it('keeps the live prompt readable mid-turn even when it is enormous', () => {
    // The user budget is what protects the request the agent is working on. It
    // is the newest user entry, so the budget walk reaches it first, and the
    // per-message truncation caps it far below the budget.
    const huge = `IMPORTANT REQUEST ${'x'.repeat(500_000)} FINAL LINE`
    const summary = textOf(
      compact([
        user(huge, ['USER_PROMPT']),
        ...Array.from({ length: 50 }, (_, i) => assistant(`step ${i}`)),
      ])[0],
    )

    expect(summary).toContain('IMPORTANT REQUEST')
    expect(summary).toContain('FINAL LINE')
  })

  it('drops per-step scaffolding and re-appends the instructions prompt', () => {
    const result = compact([
      user('older work'),
      assistant('older answer'),
      user('THE INSTRUCTIONS', ['INSTRUCTIONS_PROMPT']),
      user('THE STEP SCAFFOLD', ['STEP_PROMPT']),
      user('the live question', ['USER_PROMPT']),
    ])

    expect(result).toHaveLength(3)
    expect(textOf(result[0])).not.toContain('THE INSTRUCTIONS')
    expect(textOf(result[0])).not.toContain('THE STEP SCAFFOLD')
    expect(result[1].tags).toContain('INSTRUCTIONS_PROMPT')
    expect(textOf(result[1])).toContain('THE INSTRUCTIONS')
    expect(textOf(result[2])).toContain('the live question')
  })

  it('folds a previous summary back in on a second compaction', () => {
    const first = compact([
      user('the original request', ['USER_PROMPT']),
      assistant('working on it'),
    ])
    const second = compact([...first, assistant('more work')])

    expect(second).toHaveLength(2)
    expect(textOf(second[0])).toContain('the original request')
    expect(textOf(second[0])).toContain('more work')
    // The old summary wrapper is not nested inside the new one.
    expect(textOf(second[0]).match(/<conversation_summary>/g)).toHaveLength(1)
    expect(textOf(second[1])).toContain('Continue the existing assistant turn')
  })

  it('does not mistake a user message that mentions the tag for a summary', () => {
    // A summary is dropped from the history and re-parsed into entries, so a
    // false positive silently eats the user's message. Asking about this very
    // module is an easy way to send the bare tag.
    const asking = user(
      'why does the code emit <conversation_summary> around the memory?',
    )
    const result = compact([
      asking,
      assistant('because the model needs a delimiter'),
      user('got it, now fix the bug', ['USER_PROMPT']),
    ])

    expect(textOf(result[0])).toContain('why does the code emit')
  })

  it('still recognizes a real summary it produced itself', () => {
    const first = compact([
      user('the original request', ['USER_PROMPT']),
      assistant('working on it'),
    ])
    // The genuine artifact carries the header, so it is folded in rather than
    // re-summarized as if it were ordinary user text.
    const second = compactMessages({
      messages: [...first, assistant('more work')],
    })

    expect(second.stats.previous_summary_entry_count).toBeGreaterThan(0)
    expect(
      textOf(second.messages[0]).match(/<conversation_summary>/g),
    ).toHaveLength(1)
  })

  it('spends the two budgets independently: a flood of tool work keeps user prompts', () => {
    const { messages, stats } = compactMessages({
      messages: [
        user('the first request I made'),
        ...Array.from({ length: 200 }, (_, i) =>
          assistant(`step ${i}: ${'x'.repeat(500)}`),
        ),
        user('the live question', ['USER_PROMPT']),
      ],
      assistantToolBudget: 1_000,
      userBudget: 50_000,
    })

    expect(textOf(messages[0])).toContain('the first request I made')
    expect(stats.dropped_assistant_tool_entry_count).toBeGreaterThan(0)
    expect(stats.dropped_user_entry_count).toBe(0)
  })

  it('always keeps the newest entry even when it alone blows its budget', () => {
    const { messages, stats } = compactMessages({
      messages: [
        user('old', ['USER_PROMPT']),
        assistant(`HUGE ${'y'.repeat(50_000)}`),
      ],
      assistantToolBudget: 10,
      userBudget: 10,
    })

    expect(stats.newest_entry_forced).toBe(true)
    expect(textOf(messages[0])).toContain('HUGE')
  })

  it('carries the most recent images forward as real image parts', () => {
    const withImage: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', image: 'data:image/png;base64,AAAA' },
      ],
      sentAt: 1,
    }
    const result = compact([
      withImage,
      assistant('I see it'),
      user('now?', ['USER_PROMPT']),
    ])

    const imageParts = (result[0].content as any[]).filter(
      (part) => part.type === 'image',
    )
    expect(imageParts).toHaveLength(1)
    expect(textOf(result[0])).toContain('[image(s) were attached]')
    expect(textOf(result[0])).toContain('Attached below: the image(s)')
  })

  it('claims no attached image when none was carried', () => {
    expect(
      textOf(compact([user('hello'), user('now?', ['USER_PROMPT'])])[0]),
    ).not.toContain('Attached below')
  })

  it('a later pass keeps the note and stops claiming the image is attached', () => {
    const first = compact([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', image: 'data:image/png;base64,AAAA' },
        ],
        sentAt: 1,
      },
      assistant('I see it'),
      user('now?', ['USER_PROMPT']),
    ])
    const second = compact([
      ...first,
      assistant('working'),
      user('and now?', ['USER_PROMPT']),
    ])
    expect(textOf(second[0])).toContain('[USER] [image(s) were attached]')
    expect(textOf(second[0])).not.toContain('Attached below')
    expect(
      (second[0].content as any[]).filter((part) => part.type === 'image'),
    ).toHaveLength(0)
  })

  it('keeps a note for an image sent with no text, and names a file part', () => {
    const result = compact([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: 'data:image/png;base64,AAAA',
            mediaType: 'image/png',
            filename: 'wireframe.png',
          },
        ],
        sentAt: 1,
      },
      assistant('I see it'),
      user('now?', ['USER_PROMPT']),
    ])
    expect(textOf(result[0])).toContain(
      '[USER] [image(s) were attached: wireframe.png]',
    )
    expect(
      (result[0].content as any[]).filter((part) => part.type === 'file'),
    ).toHaveLength(1)
  })

  it('does not take a PDF for an image', () => {
    const { summaryText } = compactMessages({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'read this' },
            { type: 'file', data: 'AAAA', mediaType: 'application/pdf' },
          ],
          sentAt: 1,
        },
        user('now?', ['USER_PROMPT']),
      ],
    })
    expect(summaryText).not.toContain('image(s)')
  })

  it('labels an image a tool showed as a picture that is gone, with its name', () => {
    const { summaryText } = compactMessages({
      messages: [
        assistantToolCall('read_files', { paths: ['logo.png'] }),
        {
          role: 'tool',
          toolCallId: 'call-0',
          toolName: 'read_files',
          content: [
            {
              type: 'json',
              value: [
                {
                  path: 'logo.png',
                  content:
                    '[IMAGE] image/png, 2 KB. The image is attached after this result.',
                },
              ],
            },
            { type: 'media', mediaType: 'image/png', data: 'AAAA' },
          ],
        },
        assistantToolCall('cloud_read_image', { path: 'shot.png' }),
        {
          role: 'tool',
          toolCallId: 'call-0',
          toolName: 'cloud_read_image',
          content: [{ type: 'media', mediaType: 'image/png', data: 'BBBB' }],
        },
        user('now?', ['USER_PROMPT']),
      ],
    })
    expect(summaryText).toContain(
      'Image(s) shown by read_files: logo.png. These were pictures, not text, and are no longer attached',
    )
    expect(summaryText).toContain('opened image: shot.png')
    expect(summaryText).toContain('Image(s) shown by cloud_read_image.')
    // Neither the base64 nor the sentence that was true only before compaction.
    expect(summaryText).not.toContain('AAAA')
    expect(summaryText).not.toContain('attached after this result')
  })

  it('does not record a refused image read as a look at it', () => {
    const { summaryText } = compactMessages({
      messages: [
        assistantToolCall('read_files', { paths: ['logo.png'] }),
        toolResult('read_files', [
          {
            path: 'logo.png',
            content:
              '[IMAGE] logo.png was not opened: this model cannot view images.',
          },
        ]),
        user('now?', ['USER_PROMPT']),
      ],
    })
    expect(summaryText).toContain('Image(s) not shown: logo.png')
    expect(summaryText).not.toContain('Image(s) shown by')
  })

  it('produces a summary well under the budget it was called for', () => {
    const { summaryText } = compactMessages({
      messages: [
        user('do the thing', ['USER_PROMPT']),
        ...Array.from({ length: 400 }, (_, i) =>
          i % 2 === 0
            ? assistant(`assistant turn ${i} ${'z'.repeat(2_000)}`)
            : toolResult('read_files', { content: 'z'.repeat(20_000) }),
        ),
      ],
    })

    // Default budgets are 20k assistant/tool + 50k user estimated tokens.
    expect(Math.ceil(summaryText.length / 3)).toBeLessThan(75_000)
  })
})
