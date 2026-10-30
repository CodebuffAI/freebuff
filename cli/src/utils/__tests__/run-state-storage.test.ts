import { describe, test, expect, afterAll, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import {
  saveChatState,
  loadMostRecentChatState,
  setChatDirOverrideForTesting,
  setLiveChatStateProvider,
  clearLiveChatStateProvider,
  flushLiveChatState,
  scheduleCheckpointSave,
  settleCheckpointSave,
} from '../run-state-storage'
import { setAtomicWriteFsForTesting } from '../write-file-atomic'
import type { AtomicWriteFs } from '../write-file-atomic'
import type { ChatMessage } from '../../types/chat'
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

  const runState = { output: { type: 'error', message: 'x' } } as RunState
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

  test.skipIf(process.platform === 'win32')(
    'saveChatState creates the chat dir and its files owner-only',
    () => {
      const freshDir = path.join(chatDir, 'fresh-chat')

      saveChatState(runState, messages, freshDir)

      expect(fs.statSync(freshDir).mode & 0o777).toBe(0o700)
      for (const name of fs.readdirSync(freshDir)) {
        expect(fs.statSync(path.join(freshDir, name)).mode & 0o777).toBe(
          0o600,
        )
      }
      expect(fs.readdirSync(freshDir)).toContain('run-state.json')
      expect(fs.readdirSync(freshDir)).toContain('chat-messages.json')
    },
  )

  test('torn run-state.json still restores the transcript', () => {
    saveChatState(runState, messages)
    fs.writeFileSync(
      path.join(chatDir, 'run-state.json'),
      '{"sessionState": {"trunc',
    )

    const loaded = loadMostRecentChatState()

    expect(loaded).not.toBeNull()
    expect(loaded!.messages[0].content).toBe('the prompt')
    expect(loaded!.runState.output.type).toBe('error')
  })

  test('torn chat-messages.json still restores the run state', () => {
    saveChatState(runState, messages)
    fs.writeFileSync(path.join(chatDir, 'chat-messages.json'), '[{"id":')

    const loaded = loadMostRecentChatState()

    expect(loaded).not.toBeNull()
    expect(loaded!.messages).toHaveLength(0)
    expect((loaded!.runState.output as any).message).toBe('x')
  })

  test('returns null when both files are unreadable', () => {
    saveChatState(runState, messages)
    fs.writeFileSync(path.join(chatDir, 'run-state.json'), '{')
    fs.writeFileSync(path.join(chatDir, 'chat-messages.json'), '[')

    expect(loadMostRecentChatState()).toBeNull()
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

describe('checkpoint drains skip what the disk already holds', () => {
  const chatDir = path.join(TEST_ROOT, 'codebuff-test-skip-chatdir')

  // A recording delegate (same seam as write-file-atomic's own durability
  // tests) so "the drain wrote nothing" is asserted at the syscall layer,
  // not inferred from file contents — an unchanged checkpoint leaves the old
  // bytes readable either way.
  const recordingFs = () => {
    const calls: string[] = []
    const recording: AtomicWriteFs = {
      openSync: ((...args: any[]) => {
        calls.push('openSync')
        return (fs.openSync as any)(...args)
      }) as typeof fs.openSync,
      writeFileSync: ((...args: any[]) => {
        calls.push('writeFileSync')
        return (fs.writeFileSync as any)(...args)
      }) as typeof fs.writeFileSync,
      fsyncSync: (fd: number) => {
        calls.push('fsyncSync')
        return fs.fsyncSync(fd)
      },
      closeSync: (fd: number) => {
        calls.push('closeSync')
        return fs.closeSync(fd)
      },
      renameSync: ((...args: any[]) => {
        calls.push('renameSync')
        return (fs.renameSync as any)(...args)
      }) as typeof fs.renameSync,
      unlinkSync: ((...args: any[]) => {
        calls.push('unlinkSync')
        return (fs.unlinkSync as any)(...args)
      }) as typeof fs.unlinkSync,
      promises: {
        open: async (...args: Parameters<typeof fs.promises.open>) => {
          calls.push('open')
          const handle = await fs.promises.open(...args)
          return {
            writeFile: (data: any) => {
              calls.push('writeFile')
              return handle.writeFile(data)
            },
            sync: () => {
              calls.push('sync')
              return handle.sync()
            },
            close: () => {
              calls.push('close')
              return handle.close()
            },
          } as any
        },
        rename: (from: fs.PathLike, to: fs.PathLike) => {
          calls.push('rename')
          return fs.promises.rename(from, to)
        },
        unlink: (target: fs.PathLike) => {
          calls.push('unlink')
          return fs.promises.unlink(target)
        },
      },
    }
    return { fs: recording, calls }
  }

  const runState = () =>
    ({
      traceSessionId: 'trace-skip',
      sessionState: {
        mainAgentState: {
          messageHistory: [],
          contextTokenCount: 0,
          creditsUsed: 0,
          stepsRemaining: 300,
          agentType: 'base',
        },
      },
      output: { type: 'error', message: 'x' },
    }) as unknown as RunState

  const messages = (content: string): ChatMessage[] => [
    {
      id: 'msg-1',
      variant: 'user',
      content,
      timestamp: new Date().toISOString(),
    },
  ]

  let recorder: ReturnType<typeof recordingFs>

  beforeEach(() => {
    fs.rmSync(chatDir, { recursive: true, force: true })
    recorder = recordingFs()
    setAtomicWriteFsForTesting(recorder.fs)
    setChatDirOverrideForTesting(chatDir)
  })

  afterEach(async () => {
    await settleCheckpointSave()
    setAtomicWriteFsForTesting(undefined)
    setChatDirOverrideForTesting(undefined)
    fs.rmSync(chatDir, { recursive: true, force: true })
  })

  const flushCalls = () => recorder.calls.splice(0, recorder.calls.length)

  test('a second drain with the same state performs no writes at all', async () => {
    const state = runState()
    const transcript = messages('unchanged')

    scheduleCheckpointSave(state, transcript)
    await settleCheckpointSave()
    flushCalls()

    // The SDK's snapshot timer reschedules at the interval even when the run
    // made no progress; persisting the settled state again would rewrite
    // byte-identical files.
    scheduleCheckpointSave(state, transcript)
    await settleCheckpointSave()

    expect(recorder.calls).toEqual([])
  })

  test('a drain after an authoritative save with unchanged state is free', async () => {
    const state = runState()
    const transcript = messages('finished')

    // Use snapshots the periodic path actually sees: the run-side containers
    // are shared between the checkpoint state and the completion state.
    saveChatState(state, transcript)
    flushCalls()

    scheduleCheckpointSave(state, transcript)
    await settleCheckpointSave()

    expect(recorder.calls).toEqual([])
    expect(
      fs.existsSync(path.join(chatDir, 'chat-messages.json')),
    ).toBe(true)
  })

  test('a change anywhere triggers exactly one write pass', async () => {
    const state = runState()

    scheduleCheckpointSave(state, messages('one'))
    await settleCheckpointSave()
    flushCalls()

    // New array + new tail message: what a finished turn's adoption looks
    // like. One pass = tmp+fsync for both files, both renames, one dir fsync.
    scheduleCheckpointSave(state, messages('two'))
    await settleCheckpointSave()

    expect(recorder.calls).toEqual([
      // run-state.json: prepare, then chat-messages.json: prepare
      'open', 'writeFile', 'sync', 'close',
      'open', 'writeFile', 'sync', 'close',
      // both renames, then the single directory flush
      'rename', 'rename',
      'open', 'sync', 'close',
    ])

    flushCalls()
    // Streaming grows the tail in place but always through a new array in the
    // store: same tail object identity inside a new container still writes.
    const transcript = messages('three')
    const next = [...transcript]
    scheduleCheckpointSave(state, next)
    await settleCheckpointSave()
    expect(recorder.calls).not.toEqual([])
  })

  test('appending one character to the tail message writes again', async () => {
    const state = runState()
    const transcript = messages('the transcript so far')

    scheduleCheckpointSave(state, transcript)
    await settleCheckpointSave()
    flushCalls()

    // The store rebuilds the streaming tail on each batch: new tail object,
    // same everything else. Even a single appended character must not hash
    // equal to the persisted state.
    const grown = [{ ...transcript[0], content: 'the transcript so far.' }]
    scheduleCheckpointSave(state, grown)
    await settleCheckpointSave()

    expect(recorder.calls).toContain('rename')
    const saved = JSON.parse(
      fs.readFileSync(path.join(chatDir, 'chat-messages.json'), 'utf8'),
    ) as ChatMessage[]
    expect(saved[0].content).toBe('the transcript so far.')
  })

  test('a run-state scalar change (credits used) writes again', async () => {
    const transcript = messages('same transcript')
    scheduleCheckpointSave(runState(), transcript)
    await settleCheckpointSave()
    flushCalls()

    const moreSpent = runState()
    moreSpent.sessionState!.mainAgentState.creditsUsed = 42
    scheduleCheckpointSave(moreSpent, transcript)
    await settleCheckpointSave()

    expect(recorder.calls).toContain('rename')
  })

  test('the meta sidecar is not rewritten by checkpoints', async () => {
    const state = runState()
    const transcript = messages('checkpointed chat')

    scheduleCheckpointSave(state, transcript)
    await settleCheckpointSave()

    // The sidecar belongs to turn end now: mid-checkpoint it simply doesn't
    // exist yet, and /history falls back to parsing the transcript.
    expect(
      fs.existsSync(path.join(chatDir, 'chat-meta.json')),
    ).toBe(false)

    // An authoritative save writes it (turn completion goes through
    // saveChatState), and a later unchanged checkpoint leaves it alone.
    saveChatState(state, transcript)
    expect(fs.existsSync(path.join(chatDir, 'chat-meta.json'))).toBe(true)
    flushCalls()

    scheduleCheckpointSave(state, transcript)
    await settleCheckpointSave()
    expect(recorder.calls).toEqual([])
  })

  test('checkpoint drains share one directory fsync across both files', async () => {
    const transcript = messages('probe')
    scheduleCheckpointSave(runState(), transcript)
    await settleCheckpointSave()

    // Two files published (two renames), but the directory they live in is
    // flushed once: 2 file opens/fsyncs + 1 dir open/fsync (opened with 'r',
    // no writeFile in between).
    expect(recorder.calls.filter((c) => c === 'rename')).toHaveLength(2)
    expect(recorder.calls.filter((c) => c === 'writeFile')).toHaveLength(2)
    // Every fsync pairs with an open: 2 file fsyncs + 1 directory fsync.
    expect(recorder.calls.filter((c) => c === 'sync')).toHaveLength(3)
    // Last group is the single directory flush: open, sync, close.
    expect(recorder.calls.slice(-3)).toEqual(['open', 'sync', 'close'])
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

/**
 * Support ticket #180: a user's session files were present but held the four
 * bytes `null` — the whole transcript gone. Two independent paths produced
 * that, and both of them are one-way doors unless the bytes are kept.
 */
describe('a transcript is never destroyed', () => {
  const chatDir = path.join(TEST_ROOT, 'codebuff-test-nulled-chatdir')

  const runState = { output: { type: 'error', message: 'x' } } as RunState
  const messages: ChatMessage[] = [
    {
      id: 'msg-1',
      variant: 'user',
      content: 'the prompt',
      timestamp: new Date().toISOString(),
    },
  ]

  const messagesPath = () => path.join(chatDir, 'chat-messages.json')
  const runStatePath = () => path.join(chatDir, 'run-state.json')
  const quarantined = (file: string) =>
    fs
      .readdirSync(chatDir)
      .filter((name) => name.startsWith(`${file}.corrupt-`))

  beforeEach(() => {
    fs.rmSync(chatDir, { recursive: true, force: true })
    setChatDirOverrideForTesting(chatDir)
  })

  afterEach(() => {
    setChatDirOverrideForTesting(undefined)
    fs.rmSync(chatDir, { recursive: true, force: true })
  })

  test('saveChatState never writes the literal text null over a transcript', () => {
    saveChatState(runState, messages)

    // `JSON.stringify(null)` is the string 'null', which is truthy — so this
    // used to sail through the save's own guard and replace the transcript
    // with four bytes, no crash required.
    saveChatState(runState, null as unknown as ChatMessage[], chatDir)

    expect(fs.readFileSync(messagesPath(), 'utf8')).not.toBe('null')
    expect(JSON.parse(fs.readFileSync(messagesPath(), 'utf8'))).toHaveLength(1)
  })

  test('saveChatState never writes the literal text null over a run state', () => {
    saveChatState(runState, messages)

    saveChatState(null as unknown as RunState, messages, chatDir)

    expect(fs.readFileSync(runStatePath(), 'utf8')).not.toBe('null')
    expect(
      JSON.parse(fs.readFileSync(runStatePath(), 'utf8')).output.type,
    ).toBe('error')
  })

  test('a null-content transcript survives the load instead of being replaced', () => {
    saveChatState(runState, messages)
    // Exactly what the user's machine was left holding.
    fs.writeFileSync(messagesPath(), 'null')

    const loaded = loadMostRecentChatState()

    // Four bytes are not much, but they are the user's bytes: the load must
    // not nod `null` through as "no messages" and let the next turn's save
    // write an empty array over whatever is there.
    expect(quarantined('chat-messages.json')).toHaveLength(1)
    expect(
      fs.readFileSync(
        path.join(chatDir, quarantined('chat-messages.json')[0]),
        'utf8',
      ),
    ).toBe('null')
    expect(loaded!.messages).toHaveLength(0)
  })

  test('an unparseable transcript is kept, not replaced with an empty array', () => {
    saveChatState(runState, messages)
    // A half-flushed multi-MB write: the tail is missing, the head is the
    // user's conversation and a human can still read it out.
    const partial = '[{"id":"msg-1","variant":"user","content":"the prompt"'
    fs.writeFileSync(messagesPath(), partial)

    const loaded = loadMostRecentChatState()
    // The next turn's save, which is what used to destroy it.
    saveChatState(loaded!.runState, loaded!.messages, chatDir)

    const aside = quarantined('chat-messages.json')
    expect(aside).toHaveLength(1)
    expect(fs.readFileSync(path.join(chatDir, aside[0]), 'utf8')).toBe(partial)
  })

  test('an unparseable run state is kept too', () => {
    saveChatState(runState, messages)
    fs.writeFileSync(runStatePath(), '{"sessionState": {"trunc')

    const loaded = loadMostRecentChatState()

    expect(quarantined('run-state.json')).toHaveLength(1)
    expect(loaded!.messages[0].content).toBe('the prompt')
  })

  test('a transcript that is readable is never moved aside', () => {
    saveChatState(runState, messages)

    expect(loadMostRecentChatState()!.messages).toHaveLength(1)
    expect(quarantined('chat-messages.json')).toHaveLength(0)
    expect(quarantined('run-state.json')).toHaveLength(0)
  })

  test('a first load with no files on disk quarantines nothing', () => {
    fs.mkdirSync(chatDir, { recursive: true })

    expect(loadMostRecentChatState()).toBeNull()
    expect(
      fs.readdirSync(chatDir).filter((name) => name.includes('.corrupt-')),
    ).toHaveLength(0)
  })

  test('refuses to resume rather than hand back a state that would overwrite unreadable bytes', () => {
    saveChatState(runState, messages)
    // A file we can neither parse nor move aside (its directory is read-only,
    // so the quarantine rename fails). A rename would still have *replaced*
    // it, so resuming here is what destroys the transcript.
    fs.writeFileSync(messagesPath(), '[{"id":')
    fs.chmodSync(chatDir, 0o500)
    try {
      expect(loadMostRecentChatState()).toBeNull()
    } finally {
      fs.chmodSync(chatDir, 0o700)
    }

    expect(fs.readFileSync(messagesPath(), 'utf8')).toBe('[{"id":')
  })
})
