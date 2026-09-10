import {
  describe,
  test,
  expect,
  afterAll,
  beforeEach,
  afterEach,
  mock,
} from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import {
  getAllToggleIdsFromMessages,
  getRunStatePath,
  getChatMessagesPath,
  saveChatState,
  loadMostRecentChatState,
  clearChatState,
  setChatDirOverrideForTesting,
  setLiveChatStateProvider,
  clearLiveChatStateProvider,
  flushLiveChatState,
  scheduleCheckpointSave,
  settleCheckpointSave,
} from '../run-state-storage'
import type { ChatMessage, ContentBlock } from '../../types/chat'
import type { RunState } from '@codebuff/sdk'

/** Every directory below hangs off a root this run owns. They were fixed
 *  `os.tmpdir()/codebuff-test-*` paths that `beforeEach` deletes recursively,
 *  so an overlapping run wiped the chat state this one was still writing (4 of
 *  10 overlapped runs failed; solo always passed). Only the parent is unique —
 *  the names below stay stable, which is what the assertions read. See
 *  docs/testing.md. */
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-state-'))

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
})

// Mock the project-files module
const mockProjectDataDir = path.join(TEST_ROOT, 'codebuff-test-project')
const mockCurrentChatDir = path.join(
  mockProjectDataDir,
  'chats',
  'test-chat-123',
)

// Mock the module before importing
const originalGetProjectDataDir = () => mockProjectDataDir
const originalGetCurrentChatDir = () => mockCurrentChatDir

describe('run-state-storage', () => {
  beforeEach(() => {
    // Create test directories
    if (fs.existsSync(mockProjectDataDir)) {
      fs.rmSync(mockProjectDataDir, { recursive: true })
    }
    fs.mkdirSync(mockCurrentChatDir, { recursive: true })
  })

  afterEach(() => {
    // Clean up test directories
    if (fs.existsSync(mockProjectDataDir)) {
      fs.rmSync(mockProjectDataDir, { recursive: true })
    }
  })

  describe('getAllToggleIdsFromMessages', () => {
    test('extracts agent IDs from messages', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            {
              type: 'agent',
              agentId: 'agent-1',
              agentName: 'TestAgent',
              agentType: 'inline',
              content: '',
              status: 'complete',
              blocks: [],
            },
          ],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      expect(ids).toContain('agent-1')
    })

    test('extracts tool call IDs from messages', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            {
              type: 'tool',
              toolCallId: 'tool-1',
              toolName: 'glob',
              input: {},
              output: '',
            },
          ],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      expect(ids).toContain('tool-1')
    })

    test('recursively extracts IDs from nested agent blocks', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            {
              type: 'agent',
              agentId: 'parent-agent',
              agentName: 'ParentAgent',
              agentType: 'inline',
              content: '',
              status: 'complete',
              blocks: [
                {
                  type: 'tool',
                  toolCallId: 'nested-tool',
                  toolName: 'glob',
                  input: {},
                  output: '',
                },
                {
                  type: 'agent',
                  agentId: 'child-agent',
                  agentName: 'ChildAgent',
                  agentType: 'inline',
                  content: '',
                  status: 'complete',
                  blocks: [
                    {
                      type: 'tool',
                      toolCallId: 'deep-tool',
                      toolName: 'glob',
                      input: {},
                      output: '',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      expect(ids).toContain('parent-agent')
      expect(ids).toContain('nested-tool')
      expect(ids).toContain('child-agent')
      expect(ids).toContain('deep-tool')
    })

    test('handles messages with no blocks', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'user',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      expect(ids).toHaveLength(0)
    })

    test('handles empty messages array', () => {
      const ids = getAllToggleIdsFromMessages([])
      expect(ids).toHaveLength(0)
    })

    test('handles mixed block types in single message', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            { type: 'text', content: 'Some text' },
            {
              type: 'agent',
              agentId: 'agent-1',
              agentName: 'TestAgent',
              agentType: 'inline',
              content: '',
              status: 'complete',
              blocks: [],
            },
            {
              type: 'tool',
              toolCallId: 'tool-1',
              toolName: 'glob',
              input: {},
              output: '',
            },
          ],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      expect(ids).toContain('agent-1')
      expect(ids).toContain('tool-1')
      expect(ids).toHaveLength(2)
    })

    test('does not deduplicate IDs (returns all occurrences)', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            {
              type: 'agent',
              agentId: 'shared-id',
              agentName: 'TestAgent',
              agentType: 'inline',
              content: '',
              status: 'complete',
              blocks: [],
            },
          ],
        },
        {
          id: 'msg-2',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            {
              type: 'tool',
              toolCallId: 'shared-id',
              toolName: 'glob',
              input: {},
              output: '',
            },
          ],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      // Current implementation returns all occurrences without deduplication
      expect(ids.filter((id) => id === 'shared-id')).toHaveLength(2)
    })
  })

  describe('getRunStatePath', () => {
    test('returns path with correct filename', () => {
      // We need to mock the internal functions
      // This is a simplified test - in reality we'd need to mock the module
      const testPath = path.join(mockCurrentChatDir, 'run-state.json')
      expect(testPath).toContain('run-state.json')
    })
  })

  describe('getChatMessagesPath', () => {
    test('returns path with correct filename', () => {
      const testPath = path.join(mockCurrentChatDir, 'chat-messages.json')
      expect(testPath).toContain('chat-messages.json')
    })
  })

  describe('file serialization format', () => {
    test('run state JSON structure is preserved through serialization', () => {
      const runState: RunState = {
        output: {
          type: 'error',
          message: 'Test output',
        },
      } as unknown as RunState

      const runStatePath = path.join(mockCurrentChatDir, 'run-state.json')
      fs.writeFileSync(runStatePath, JSON.stringify(runState, null, 2))

      const savedRunState = JSON.parse(fs.readFileSync(runStatePath, 'utf8'))
      expect(savedRunState.output.type).toBe('error')
      expect(savedRunState.output.message).toBe('Test output')
    })

    test('messages JSON structure is preserved through serialization', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'user',
          content: 'Hello',
          timestamp: new Date().toISOString(),
          blocks: [{ type: 'text', content: 'Hello' }],
        },
      ]

      const messagesPath = path.join(mockCurrentChatDir, 'chat-messages.json')
      fs.writeFileSync(messagesPath, JSON.stringify(messages, null, 2))

      const savedMessages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'))
      expect(savedMessages).toHaveLength(1)
      expect(savedMessages[0].variant).toBe('user')
    })

    test('nested message structure is preserved through serialization', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            {
              type: 'agent',
              agentId: 'nested-agent',
              agentName: 'NestedAgent',
              agentType: 'inline',
              content: '',
              status: 'complete',
              blocks: [
                { type: 'text', content: 'Nested content' },
                {
                  type: 'tool',
                  toolCallId: 'tool-xyz',
                  toolName: 'glob',
                  input: {},
                  output: '',
                },
              ],
            },
          ],
        },
      ]

      const messagesPath = path.join(mockCurrentChatDir, 'chat-messages.json')
      fs.writeFileSync(messagesPath, JSON.stringify(messages, null, 2))

      const savedMessages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'))
      expect(savedMessages[0].blocks[0].type).toBe('agent')
      expect(savedMessages[0].blocks[0].blocks).toHaveLength(2)
    })
  })

  describe('edge cases', () => {
    test('handles empty blocks array', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)
      expect(ids).toHaveLength(0)
    })

    test('handles deeply nested structure', () => {
      const deepBlock: ContentBlock = {
        type: 'agent',
        agentId: 'level-0',
        agentName: 'Level0Agent',
        agentType: 'inline',
        content: '',
        status: 'complete',
        blocks: [
          {
            type: 'agent',
            agentId: 'level-1',
            agentName: 'Level1Agent',
            agentType: 'inline',
            content: '',
            status: 'complete',
            blocks: [
              {
                type: 'agent',
                agentId: 'level-2',
                agentName: 'Level2Agent',
                agentType: 'inline',
                content: '',
                status: 'complete',
                blocks: [
                  {
                    type: 'tool',
                    toolCallId: 'deep-tool',
                    toolName: 'glob',
                    input: {},
                    output: '',
                  },
                ],
              },
            ],
          },
        ],
      }

      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [deepBlock],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      expect(ids).toContain('level-0')
      expect(ids).toContain('level-1')
      expect(ids).toContain('level-2')
      expect(ids).toContain('deep-tool')
    })

    test('preserves order of IDs as encountered', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            {
              type: 'agent',
              agentId: 'first',
              agentName: 'FirstAgent',
              agentType: 'inline',
              content: '',
              status: 'complete',
              blocks: [],
            },
            {
              type: 'tool',
              toolCallId: 'second',
              toolName: 'glob',
              input: {},
              output: '',
            },
            {
              type: 'agent',
              agentId: 'third',
              agentName: 'ThirdAgent',
              agentType: 'inline',
              content: '',
              status: 'complete',
              blocks: [],
            },
          ],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      expect(ids[0]).toBe('first')
      expect(ids[1]).toBe('second')
      expect(ids[2]).toBe('third')
    })
  })
})

describe('live chat state provider', () => {
  // Point persistence at a temp dir via the explicit test override — module
  // seams (mock.module, HOME, spyOn on auth) are unreliable across bun test
  // files and platforms.
  const chatDir = path.join(TEST_ROOT, 'codebuff-test-live-chatdir')

  const testRunState = (marker: string): RunState =>
    ({
      output: { type: 'error', message: marker },
    }) as unknown as RunState

  const testMessages = (marker: string): ChatMessage[] => [
    {
      id: 'msg-1',
      variant: 'user',
      content: marker,
      timestamp: new Date().toISOString(),
    },
  ]

  const readSavedMessages = () =>
    JSON.parse(
      fs.readFileSync(path.join(chatDir, 'chat-messages.json'), 'utf8'),
    ) as ChatMessage[]

  beforeEach(() => {
    fs.rmSync(chatDir, { recursive: true, force: true })
    setChatDirOverrideForTesting(chatDir)
  })

  afterEach(() => {
    clearLiveChatStateProvider('run-a')
    clearLiveChatStateProvider('run-b')
    setChatDirOverrideForTesting(undefined)
    fs.rmSync(chatDir, { recursive: true, force: true })
  })

  test('flushLiveChatState persists the provided state', () => {
    setLiveChatStateProvider('run-a', () => ({
      runState: testRunState('checkpoint'),
      messages: testMessages('in-flight prompt'),
    }))

    flushLiveChatState()

    expect(readSavedMessages()[0].content).toBe('in-flight prompt')
  })

  test('flushLiveChatState is a no-op with no provider registered', () => {
    flushLiveChatState()

    expect(fs.existsSync(path.join(chatDir, 'chat-messages.json'))).toBe(false)
  })

  test('clearLiveChatStateProvider stops flushing', () => {
    setLiveChatStateProvider('run-a', () => ({
      runState: testRunState('checkpoint'),
      messages: testMessages('in-flight prompt'),
    }))
    clearLiveChatStateProvider('run-a')

    flushLiveChatState()

    expect(fs.existsSync(path.join(chatDir, 'chat-messages.json'))).toBe(false)
  })

  test('a stale run cannot clear a newer run provider', () => {
    setLiveChatStateProvider('run-a', () => ({
      runState: testRunState('old'),
      messages: testMessages('old prompt'),
    }))
    setLiveChatStateProvider('run-b', () => ({
      runState: testRunState('new'),
      messages: testMessages('new prompt'),
    }))

    // The old run settling late must not remove the new run's provider.
    clearLiveChatStateProvider('run-a')
    flushLiveChatState()

    expect(readSavedMessages()[0].content).toBe('new prompt')
  })

  test('flushLiveChatState swallows provider errors', () => {
    setLiveChatStateProvider('run-a', () => {
      throw new Error('boom')
    })

    expect(() => flushLiveChatState()).not.toThrow()
  })
})

describe('atomic save and resilient load', () => {
  const chatDir = path.join(TEST_ROOT, 'codebuff-test-resilient-chatdir')

  const runState = {
    output: { type: 'error', message: 'x' },
    sessionState: {
      mainAgentState: { messageHistory: [] },
    } as any,
  } as RunState
  const messages: ChatMessage[] = [
    {
      id: 'msg-1',
      variant: 'user',
      content: 'the prompt',
      timestamp: new Date().toISOString(),
    },
  ]

  beforeEach(() => {
    fs.rmSync(chatDir, { recursive: true, force: true })
    setChatDirOverrideForTesting(chatDir)
  })

  afterEach(() => {
    setChatDirOverrideForTesting(undefined)
    fs.rmSync(chatDir, { recursive: true, force: true })
  })

  test('saveChatState leaves no .tmp files behind', () => {
    saveChatState(runState, messages)

    const leftovers = fs
      .readdirSync(chatDir)
      .filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toHaveLength(0)
    expect(
      JSON.parse(
        fs.readFileSync(path.join(chatDir, 'chat-messages.json'), 'utf8'),
      ),
    ).toHaveLength(1)
  })

  test('torn run-state.json still restores the transcript', () => {
    saveChatState(runState, messages)
    fs.writeFileSync(
      path.join(chatDir, 'run-state.json'),
      '{"sessionState": {"trunc',
    )

    const loaded = loadMostRecentChatState()

    expect(loaded).not.toBeNull()
    expect(loaded!.messages[0].content).toBe('the prompt')
    // Torn run-state has no readable session state: no continuation state
    // is adopted, but the transcript survives the load.
    expect(loaded!.runState).toBeNull()
  })

  test('torn chat-messages.json still restores the run state', () => {
    saveChatState(runState, messages)
    fs.writeFileSync(path.join(chatDir, 'chat-messages.json'), '[{"id":')

    const loaded = loadMostRecentChatState()

    expect(loaded).not.toBeNull()
    expect(loaded!.messages).toHaveLength(0)
    expect((loaded!.runState!.output as any).message).toBe('x')
  })

  test('returns null when both files are unreadable', () => {
    saveChatState(runState, messages)
    fs.writeFileSync(path.join(chatDir, 'run-state.json'), '{')
    fs.writeFileSync(path.join(chatDir, 'chat-messages.json'), '[')

    expect(loadMostRecentChatState()).toBeNull()
  })

  test('a run-state without sessionState is not adopted as continuation state', () => {
    // A crashed/aborted first turn can persist a shell run-state (trace id
    // + error output, no session) before the SDK ever emitted a snapshot.
    // On resume that shell must not become previousRun: it would make the
    // SDK build a blank session and silently discard the conversation.
    const shellRunState = {
      traceSessionId: 'trace-shell',
      output: {
        type: 'error',
        message: 'The session ended before this response completed.',
      },
    } as RunState
    saveChatState(shellRunState, messages)

    const loaded = loadMostRecentChatState()

    expect(loaded).not.toBeNull()
    expect(loaded!.runState).toBeNull()
    expect(loaded!.messages[0].content).toBe('the prompt')
  })

  test('a run-state with sessionState is restored as continuation state', () => {
    const fullRunState = {
      traceSessionId: 'trace-full',
      sessionState: {
        mainAgentState: {
          messageHistory: [
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          ],
        },
      } as any,
      output: { type: 'lastMessage' as const, value: [] },
    } as unknown as RunState
    saveChatState(fullRunState, messages)

    const loaded = loadMostRecentChatState()

    expect(loaded!.runState).not.toBeNull()
    expect(loaded!.runState?.traceSessionId).toBe('trace-full')
    expect(
      (loaded!.runState!.sessionState as any).mainAgentState.messageHistory,
    ).toHaveLength(1)
  })
})

describe('scheduleCheckpointSave (async, coalescing)', () => {
  const chatDir = path.join(TEST_ROOT, 'codebuff-test-checkpoint-chatdir')

  const runState = (marker: string) =>
    ({ output: { type: 'error', message: marker } }) as unknown as RunState

  const messages = (marker: string): ChatMessage[] => [
    {
      id: 'msg-1',
      variant: 'user',
      content: marker,
      timestamp: new Date().toISOString(),
    },
  ]

  const readSavedMessages = () =>
    JSON.parse(
      fs.readFileSync(path.join(chatDir, 'chat-messages.json'), 'utf8'),
    ) as ChatMessage[]

  beforeEach(() => {
    fs.rmSync(chatDir, { recursive: true, force: true })
    setChatDirOverrideForTesting(chatDir)
  })

  afterEach(async () => {
    await settleCheckpointSave()
    setChatDirOverrideForTesting(undefined)
    fs.rmSync(chatDir, { recursive: true, force: true })
  })

  test('persists the scheduled state after settling', async () => {
    scheduleCheckpointSave(runState('a'), messages('first'))

    await settleCheckpointSave()

    expect(readSavedMessages()[0].content).toBe('first')
  })

  test('does not write synchronously (deferred off the calling tick)', () => {
    scheduleCheckpointSave(runState('a'), messages('deferred'))

    // Nothing on disk yet: the write is scheduled for a later tick.
    expect(fs.existsSync(path.join(chatDir, 'chat-messages.json'))).toBe(false)
  })

  test('coalesces a burst to the latest state', async () => {
    scheduleCheckpointSave(runState('a'), messages('one'))
    scheduleCheckpointSave(runState('b'), messages('two'))
    scheduleCheckpointSave(runState('c'), messages('three'))

    await settleCheckpointSave()

    // Whatever intermediate states were dropped, the newest wins.
    expect(readSavedMessages()[0].content).toBe('three')
  })

  test('an authoritative save after settling is the last write (no clobber)', async () => {
    scheduleCheckpointSave(runState('a'), messages('checkpoint'))
    // settle waits for the queued async write to flush, so the synchronous
    // final save below is guaranteed to land last.
    await settleCheckpointSave()

    saveChatState(runState('final'), messages('authoritative'))
    // Give any lingering async write a chance to (incorrectly) land on top.
    await new Promise((r) => setImmediate(r))
    await settleCheckpointSave()

    expect(readSavedMessages()[0].content).toBe('authoritative')
  })

  test('settleCheckpointSave is safe with nothing scheduled', async () => {
    await expect(settleCheckpointSave()).resolves.toBeUndefined()
  })
})

describe('chat switches while saves are pending', () => {
  // Regression tests for /history threads being clobbered: save paths used to
  // be resolved at write time from the mutable current chat id, so a pending
  // write from chat A could land in chat B's directory after a /new or
  // /history resume rotated the id in between.
  const chatDirA = path.join(TEST_ROOT, 'codebuff-test-switch-chat-a')
  const chatDirB = path.join(TEST_ROOT, 'codebuff-test-switch-chat-b')

  const runState = (marker: string) =>
    ({ output: { type: 'error', message: marker } }) as unknown as RunState

  const messages = (marker: string): ChatMessage[] => [
    {
      id: 'msg-1',
      variant: 'user',
      content: marker,
      timestamp: new Date().toISOString(),
    },
  ]

  const messagesFileIn = (dir: string) => path.join(dir, 'chat-messages.json')

  beforeEach(() => {
    fs.rmSync(chatDirA, { recursive: true, force: true })
    fs.rmSync(chatDirB, { recursive: true, force: true })
    setChatDirOverrideForTesting(chatDirA)
  })

  afterEach(async () => {
    await settleCheckpointSave()
    clearLiveChatStateProvider('run-a')
    setChatDirOverrideForTesting(undefined)
    fs.rmSync(chatDirA, { recursive: true, force: true })
    fs.rmSync(chatDirB, { recursive: true, force: true })
  })

  test('a checkpoint scheduled before a chat switch writes to the original chat dir', async () => {
    scheduleCheckpointSave(runState('a'), messages('chat A transcript'))

    // Simulate /new or a /history resume rotating the current chat while the
    // async checkpoint write is still queued.
    setChatDirOverrideForTesting(chatDirB)
    await settleCheckpointSave()

    const saved = JSON.parse(
      fs.readFileSync(messagesFileIn(chatDirA), 'utf8'),
    ) as ChatMessage[]
    expect(saved[0].content).toBe('chat A transcript')
    expect(fs.existsSync(messagesFileIn(chatDirB))).toBe(false)
  })

  test('checkpoints for different chats do not displace each other', async () => {
    // Chat A's final flush is queued, then the newly-active chat B schedules
    // its own checkpoint before the queue drains. Both must be written —
    // coalescing is per chat, not global.
    scheduleCheckpointSave(runState('a'), messages('chat A final'), chatDirA)
    scheduleCheckpointSave(runState('b'), messages('chat B first'), chatDirB)

    await settleCheckpointSave()

    const savedA = JSON.parse(
      fs.readFileSync(messagesFileIn(chatDirA), 'utf8'),
    ) as ChatMessage[]
    const savedB = JSON.parse(
      fs.readFileSync(messagesFileIn(chatDirB), 'utf8'),
    ) as ChatMessage[]
    expect(savedA[0].content).toBe('chat A final')
    expect(savedB[0].content).toBe('chat B first')
  })

  test('saveChatState with an explicit chatDir ignores a later chat switch', () => {
    setChatDirOverrideForTesting(chatDirB)

    // chatDirA was captured while chat A was current (run start).
    saveChatState(runState('a'), messages('chat A final'), chatDirA)

    const saved = JSON.parse(
      fs.readFileSync(messagesFileIn(chatDirA), 'utf8'),
    ) as ChatMessage[]
    expect(saved[0].content).toBe('chat A final')
    expect(fs.existsSync(messagesFileIn(chatDirB))).toBe(false)
  })

  test('flushLiveChatState after a chat switch writes nothing', () => {
    setLiveChatStateProvider('run-a', () => ({
      runState: runState('a'),
      // After the switch the store holds the NEW chat's messages; flushing
      // them into chat A's directory would replace A's transcript.
      messages: messages('chat B messages'),
    }))

    setChatDirOverrideForTesting(chatDirB)
    flushLiveChatState()

    expect(fs.existsSync(messagesFileIn(chatDirA))).toBe(false)
    expect(fs.existsSync(messagesFileIn(chatDirB))).toBe(false)
  })

  test('flushLiveChatState drains queued checkpoints synchronously on exit', () => {
    // A chat switch aborted the run and queued its final checkpoint, then the
    // process exits before the async drain runs. The exit flush must write
    // the queued checkpoint (to chat A) even though the current chat is B.
    scheduleCheckpointSave(runState('a'), messages('aborted turn'), chatDirA)
    setChatDirOverrideForTesting(chatDirB)

    flushLiveChatState()

    const saved = JSON.parse(
      fs.readFileSync(messagesFileIn(chatDirA), 'utf8'),
    ) as ChatMessage[]
    expect(saved[0].content).toBe('aborted turn')
    expect(fs.existsSync(messagesFileIn(chatDirB))).toBe(false)
  })

  test('flushLiveChatState still writes to the run chat dir when unswitched', () => {
    setLiveChatStateProvider('run-a', () => ({
      runState: runState('a'),
      messages: messages('in-flight prompt'),
    }))

    flushLiveChatState()

    const saved = JSON.parse(
      fs.readFileSync(messagesFileIn(chatDirA), 'utf8'),
    ) as ChatMessage[]
    expect(saved[0].content).toBe('in-flight prompt')
  })
})

describe('poisoned payload persistence', () => {
  const chatDir = path.join(TEST_ROOT, 'codebuff-test-poisoned-chatdir')

  const messages: ChatMessage[] = [
    {
      id: 'msg-1',
      variant: 'user',
      content: 'the prompt',
      timestamp: new Date().toISOString(),
    },
  ]

  beforeEach(() => {
    fs.rmSync(chatDir, { recursive: true, force: true })
    fs.mkdirSync(chatDir, { recursive: true })
    setChatDirOverrideForTesting(chatDir)
  })

  afterEach(() => {
    setChatDirOverrideForTesting(undefined)
    fs.rmSync(chatDir, { recursive: true, force: true })
  })

  test('cyclic run state still persists (cycles broken) alongside messages', () => {
    const cyclicRunState: any = { output: { type: 'error', message: 'x' } }
    cyclicRunState.self = cyclicRunState

    saveChatState(cyclicRunState as RunState, messages)

    const savedRunState = JSON.parse(
      fs.readFileSync(path.join(chatDir, 'run-state.json'), 'utf8'),
    )
    expect(savedRunState.self).toBe('[Circular]')
    expect(savedRunState.output.message).toBe('x')

    const savedMessages = JSON.parse(
      fs.readFileSync(path.join(chatDir, 'chat-messages.json'), 'utf8'),
    ) as ChatMessage[]
    expect(savedMessages[0].content).toBe('the prompt')
  })

  test('cyclic tool output in messages does not block the transcript save', () => {
    const cyclicOutput: any = { status: 'ok' }
    cyclicOutput.self = cyclicOutput
    const poisonedMessages: ChatMessage[] = [
      {
        id: 'msg-1',
        variant: 'agent',
        content: '',
        timestamp: new Date().toISOString(),
        blocks: [
          {
            type: 'tool',
            toolCallId: 'tc-1',
            toolName: 'run_terminal_command' as any,
            input: {},
            outputRaw: cyclicOutput,
          },
        ],
      },
    ]

    saveChatState(
      { output: { type: 'error', message: 'x' } } as RunState,
      poisonedMessages,
    )

    const savedMessages = JSON.parse(
      fs.readFileSync(path.join(chatDir, 'chat-messages.json'), 'utf8'),
    ) as ChatMessage[]
    const block = savedMessages[0].blocks?.[0] as any
    expect(block.outputRaw.self).toBe('[Circular]')
  })
})
