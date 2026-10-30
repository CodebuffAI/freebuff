import { describe, expect, it } from 'bun:test'

import { simplifyOldToolResults } from '../simplify-tool-results'

import type {
  CodebuffToolMessage,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

type ReadFilesValue = Extract<
  CodebuffToolOutput<'read_files'>[number],
  { type: 'json' }
>['value']

function readFilesResult(id: string, files: ReadFilesValue): Message {
  return {
    role: 'tool',
    toolName: 'read_files',
    toolCallId: id,
    content: [{ type: 'json', value: files }],
  } as ToolMessage
}

// The pass holds until past-window savings clear 20k chars, so fixtures that
// expect stubbing put several 8k results beyond the window.
const BULK = 'x'.repeat(8_000)

function fullRead(id: string, ...paths: string[]): Message {
  return readFilesResult(
    id,
    paths.map((path) => ({ path, content: `contents of ${path} ${BULK}` })),
  )
}

function stubbedRead(id: string, ...paths: string[]): Message {
  return readFilesResult(
    id,
    paths.map((path) => ({ path, contentOmittedForLength: true as const })),
  )
}

function terminalResult(
  id: string,
  command: string,
  overrides?: Record<string, unknown>,
): Message {
  return {
    role: 'tool',
    toolName: 'run_terminal_command',
    toolCallId: id,
    content: [
      {
        type: 'json',
        value: {
          command,
          stdout: `output of ${command} ${BULK}`,
          exitCode: 0,
          ...overrides,
        },
      },
    ],
  } as ToolMessage
}

function toolContent(message: Message) {
  return (message as CodebuffToolMessage).content[0] as {
    type: string
    value: any
  }
}

describe('simplifyOldToolResults', () => {
  it('stubs terminal results older than the newest keep window', () => {
    const messages = [
      ...Array.from({ length: 9 }, (_, i) =>
        terminalResult(`t${i}`, `cmd${i}`),
      ),
    ]

    const result = simplifyOldToolResults({ messages, logger })

    expect(result).not.toBe(messages)
    for (let i = 0; i < 9; i++) {
      const value = toolContent(result[i]).value
      if (i < 4) {
        // Oldest four fall outside the newest-5 window.
        expect(value).toEqual({
          command: `cmd${i}`,
          stdoutOmittedForLength: true,
          exitCode: 0,
        })
      } else {
        expect((value as { stdout: string }).stdout).toContain(
          `output of cmd${i}`,
        )
        expect(result[i]).toBe(messages[i])
      }
    }
  })

  it('stubs read_files results older than the newest keep window', () => {
    const messages = [
      ...Array.from({ length: 7 }, (_, i) => fullRead(`r${i}`, `src/f${i}.ts`)),
    ]

    const result = simplifyOldToolResults({ messages, logger })

    expect(result).not.toBe(messages)
    for (let i = 0; i < 7; i++) {
      const value = toolContent(result[i]).value
      if (i < 4) {
        // Oldest four fall outside the newest-3 window.
        expect(value).toEqual([
          { path: `src/f${i}.ts`, contentOmittedForLength: true },
        ])
      } else {
        expect(value[0].content).toContain(`contents of src/f${i}.ts`)
        expect(result[i]).toBe(messages[i])
      }
    }
  })

  it('keeps each tool type independently of the other', () => {
    const messages = [
      // 7 reads + 6 terminals interleaved; both windows are exceeded, but
      // each tool's window never counts the other tool's results.
      ...Array.from({ length: 6 }, (_, i) => [
        fullRead(`r${i}`, `src/f${i}.ts`),
        terminalResult(`t${i}`, `cmd${i}`),
      ]).flat(),
      fullRead('r6', 'src/f6.ts'),
    ]

    const result = simplifyOldToolResults({ messages, logger })

    expect(result).not.toBe(messages)
    for (let i = 0; i < 6; i++) {
      const read = result[i * 2]
      const terminal = result[i * 2 + 1]
      if (i >= 4) {
        expect(read).toBe(messages[i * 2])
      } else {
        expect(toolContent(read).value).toEqual([
          { path: `src/f${i}.ts`, contentOmittedForLength: true },
        ])
      }
      if (i >= 1) {
        expect(terminal).toBe(messages[i * 2 + 1])
      } else {
        expect(toolContent(terminal).value).toEqual({
          command: `cmd${i}`,
          stdoutOmittedForLength: true,
          exitCode: 0,
        })
      }
    }
    // The trailing read is the newest of seven: verbatim.
    expect(result[12]).toBe(messages[12])
  })

  it('passes already-stubbed results through with reference identity and without consuming window slots', () => {
    const messages = [
      stubbedRead('already-stubbed', 'src/stubbed.ts'),
      fullRead('r1', 'src/f1.ts'),
      fullRead('r2', 'src/f2.ts'),
      fullRead('r3', 'src/f3.ts'),
    ]

    const result = simplifyOldToolResults({ messages, logger })

    // Nothing to do: same array reference back.
    expect(result).toBe(messages)
    expect(result[0]).toBe(messages[0])
    expect(result[0]).toEqual(stubbedRead('already-stubbed', 'src/stubbed.ts'))
  })

  it('leaves terminal background-process and error results verbatim', () => {
    const messages = [
      terminalResult('bg', 'npm start', {
        processId: 12345,
        backgroundProcessStatus: 'running',
      }),
      terminalResult('err', 'invalid-command', {
        errorMessage: 'Command not found',
      }),
      ...Array.from({ length: 8 }, (_, i) =>
        terminalResult(`t${i}`, `cmd${i}`),
      ),
    ]

    const result = simplifyOldToolResults({ messages, logger })

    expect(result[0]).toBe(messages[0])
    expect(result[1]).toBe(messages[1])
    // The three oldest regular results exceed the newest-5 window; the
    // background and error entries never consume window slots.
    for (let i = 2; i < 5; i++) {
      expect(toolContent(result[i]).value).toEqual({
        command: `cmd${i - 2}`,
        stdoutOmittedForLength: true,
        exitCode: 0,
      })
    }
    for (let i = 5; i < 10; i++) {
      expect(result[i]).toBe(messages[i])
    }
  })

  it('preserves reference identity for every unreplaced message', () => {
    const user = {
      role: 'user',
      content: [{ type: 'text', text: 'do the thing' }],
    } as Message
    const otherTool = {
      role: 'tool',
      toolName: 'code_search',
      toolCallId: 'cs1',
      content: [{ type: 'json', value: { results: ['huge'] } }],
    } as Message
    const messages = [
      otherTool,
      user,
      fullRead('old-read', 'src/old.ts'),
      ...Array.from({ length: 3 }, (_, i) => fullRead(`r${i}`, `src/f${i}.ts`)),
      ...Array.from({ length: 9 }, (_, i) =>
        terminalResult(`t${i}`, `cmd${i}`),
      ),
    ]
    const snapshot = [...messages]

    const result = simplifyOldToolResults({ messages, logger })

    expect(result.length).toBe(messages.length)
    for (let i = 0; i < result.length; i++) {
      if (i === 2) {
        // 4th-newest read of 4: stubbed.
        expect(result[i]).not.toBe(messages[i])
        expect(toolContent(result[i]).value).toEqual([
          { path: 'src/old.ts', contentOmittedForLength: true },
        ])
      } else if (i >= 6 && i <= 9) {
        // 6th-through-9th-newest terminals: stubbed.
        expect(result[i]).not.toBe(messages[i])
        expect(toolContent(result[i]).value).toEqual({
          command: `cmd${i - 6}`,
          stdoutOmittedForLength: true,
          exitCode: 0,
        })
      } else {
        // Everything else — user, other tools, kept window — same reference.
        expect(result[i]).toBe(messages[i])
      }
    }
    // Input array and shared messages are untouched (history snapshots safe).
    expect(messages).toEqual(snapshot)
    expect(messages[2]).toBe(snapshot[2])
    expect(toolContent(messages[2]).value[0].content).toContain(
      'contents of src/old.ts',
    )
  })

  it('leaves the history alone until past-window savings clear the floor', () => {
    // A handful of bulky results might clear the per-result keep window, but
    // stubbing one modest result trades content the model may still read for
    // negligible re-send savings — and forfeits fitToolResults' graded
    // prefix-clip in a tight window.
    const messages = [
      ...Array.from({ length: 7 }, (_, i) =>
        terminalResult(`t${i}`, `cmd${i}`),
      ),
      fullRead('r0', 'src/f0.ts'),
      ...Array.from({ length: 3 }, (_, i) =>
        fullRead(`r${i + 1}`, `src/f${i + 1}.ts`),
      ),
    ]
    // past-window: 2 terminals + 1 read ≈ 24k > 20k floor — clipped version
    // would differ; below shows the floor by removing one bulky terminal.
    const belowFloor = messages.slice(1)

    expect(simplifyOldToolResults({ messages, logger })).not.toBe(messages)
    expect(simplifyOldToolResults({ messages: belowFloor, logger })).toBe(
      belowFloor,
    )
  })

  it('honours explicit keep-window sizes', () => {
    const messages = [
      ...Array.from({ length: 5 }, (_, i) =>
        terminalResult(`t${i}`, `cmd${i}`),
      ),
      ...Array.from({ length: 5 }, (_, i) => fullRead(`r${i}`, `src/f${i}.ts`)),
    ]

    const result = simplifyOldToolResults({
      messages,
      numTerminalCommands: 1,
      numReadFileResults: 2,
      logger,
    })

    for (let i = 0; i < 5; i++) {
      const value = toolContent(result[i]).value
      if (i < 4) expect(value.stdoutOmittedForLength).toBe(true)
      else expect(value.stdout).toContain('output of cmd4')
    }
    for (let i = 5; i < 10; i++) {
      const value = toolContent(result[i]).value
      if (i < 8) {
        expect(value).toEqual([
          { path: `src/f${i - 5}.ts`, contentOmittedForLength: true },
        ])
      } else {
        expect(result[i]).toBe(messages[i])
      }
    }
  })
})
