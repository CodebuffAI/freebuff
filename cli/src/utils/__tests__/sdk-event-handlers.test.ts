import { describe, expect, test } from 'bun:test'

import { createAgentBlock } from '../message-block-helpers'
import { createMessageUpdater } from '../message-updater'
import {
  createEventHandler,
  createStreamChunkHandler,
} from '../sdk-event-handlers'

import type { StreamStatus } from '../../hooks/use-message-queue'
import type { AgentContentBlock, ChatMessage } from '../../types/chat'
import type { AgentMode } from '../constants'
import type { EventHandlerState } from '../sdk-event-handlers'
import type { Logger } from '@codebuff/common/types/contracts/logger'

// Type for spawn agent info stored in the map
interface SpawnAgentInfo {
  index: number
  agentType: string
}

// SDK event types for testing
interface SubagentStartEvent {
  type: 'subagent_start'
  agentId: string
  agentType: string
  displayName: string
  onlyChild: boolean
  parentAgentId: string | undefined
  params: Record<string, unknown> | undefined
  prompt: string | undefined
}

interface ToolResultEvent {
  type: 'tool_result'
  toolCallId: string
  toolName: string
  output: Array<{
    type: 'json'
    value: Array<{
      agentName: string
      value: any
    }>
  }>
}

const createStreamRefs = (): {
  controller: EventHandlerState['streaming']['streamRefs']
  state: {
    rootStreamBuffer: string
    agentStreamAccumulators: Map<string, string>
    rootStreamSeen: boolean
    planExtracted: boolean
    wasAbortedByUser: boolean
    spawnAgentsMap: Map<string, SpawnAgentInfo>
  }
} => {
  const state = {
    rootStreamBuffer: '',
    agentStreamAccumulators: new Map<string, string>(),
    rootStreamSeen: false,
    planExtracted: false,
    wasAbortedByUser: false,
    spawnAgentsMap: new Map<string, SpawnAgentInfo>(),
  }

  const controller = {
    state,
    reset: () => {},
    setters: {
      setRootStreamBuffer: (value: string) => {
        state.rootStreamBuffer = value
      },
      appendRootStreamBuffer: (value: string) => {
        state.rootStreamBuffer += value
      },
      setAgentAccumulator: (agentId: string, value: string) => {
        state.agentStreamAccumulators.set(agentId, value)
      },
      removeAgentAccumulator: (agentId: string) => {
        state.agentStreamAccumulators.delete(agentId)
      },
      setRootStreamSeen: (value: boolean) => {
        state.rootStreamSeen = value
      },
      setPlanExtracted: (value: boolean) => {
        state.planExtracted = value
      },
      setWasAbortedByUser: (value: boolean) => {
        state.wasAbortedByUser = value
      },
      setSpawnAgentInfo: (agentId: string, info: SpawnAgentInfo) => {
        state.spawnAgentsMap.set(agentId, info)
      },
      removeSpawnAgentInfo: (agentId: string) => {
        state.spawnAgentsMap.delete(agentId)
      },
    },
  }

  return { controller, state }
}

const createTestContext = (agentMode: AgentMode = 'DEFAULT') => {
  let messages: ChatMessage[] = [
    {
      id: 'ai-1',
      variant: 'ai',
      content: '',
      blocks: [],
      timestamp: 'now',
    },
  ]
  let streamingAgents = new Set<string>()
  let streamStatus: StreamStatus | null = null
  let hasPlanResponse = false
  const streamRefs = createStreamRefs()

  const updater = createMessageUpdater(
    'ai-1',
    (fn: (msgs: ChatMessage[]) => ChatMessage[]) => {
      messages = fn(messages)
    },
  )

  const ctx: EventHandlerState = {
    streaming: {
      streamRefs: streamRefs.controller,
      setStreamingAgents: (fn: (prev: Set<string>) => Set<string>) => {
        streamingAgents = fn(streamingAgents)
      },
      setStreamStatus: (status: StreamStatus) => {
        streamStatus = status
      },
    },
    message: {
      aiMessageId: 'ai-1',
      updater,
      hasReceivedContentRef: { current: false },
    },
    subagents: {
      addActiveSubagent: () => {},
      removeActiveSubagent: () => {},
    },
    mode: {
      agentMode,
      setHasReceivedPlanResponse: (value: boolean) => {
        hasPlanResponse = value
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as Logger,
    setIsRetrying: () => {},
  }

  return {
    ctx,
    getMessages: () => messages,
    getStreamingAgents: () => streamingAgents,
    getStreamStatus: () => streamStatus,
    getHasPlanResponse: () => hasPlanResponse,
    streamRefs,
  }
}

describe('sdk-event-handlers', () => {
  test('ignores callbacks after the run loses ownership', () => {
    const { ctx, getMessages, getStreamStatus, streamRefs } =
      createTestContext()
    let totalCost: number | undefined
    ctx.isActive = () => false
    ctx.onTotalCost = (cost) => {
      totalCost = cost
    }

    createStreamChunkHandler(ctx)('late text')
    createEventHandler(ctx)({
      type: 'tool_call',
      toolCallId: 'late-tool',
      toolName: 'read_files',
      input: {},
      agentId: 'main-agent',
      parentAgentId: undefined,
    } as any)
    createEventHandler(ctx)({ type: 'finish', totalCost: 7 } as any)

    expect(getMessages()[0].blocks).toEqual([])
    expect(getStreamStatus()).toBeNull()
    expect(streamRefs.state.rootStreamBuffer).toBe('')
    expect(totalCost).toBe(7)
  })

  test('a failing UI update is logged and never escapes into the SDK run', () => {
    // The Arch crash: React's "Maximum update depth exceeded" (#185) thrown
    // by the store notification inside setStreamingAgents on a tool_call. It
    // escaped the SDK's stream callback as an unhandled rejection and the
    // process-level handler exited the CLI, ending the run and the session.
    const { ctx, getMessages } = createTestContext()
    const errors: Array<{ data: any; msg: string }> = []
    ctx.logger = {
      ...ctx.logger,
      error: (data: any, msg: string) => {
        errors.push({ data, msg })
      },
    } as Logger
    ctx.streaming.setStreamingAgents = () => {
      throw new Error(
        'Minified React error #185; visit https://react.dev/errors/185',
      )
    }
    const handleEvent = createEventHandler(ctx)
    const toolCall = (id: string) =>
      handleEvent({
        type: 'tool_call',
        toolCallId: id,
        toolName: 'read_files',
        input: { paths: ['a.ts'] },
        agentId: 'main-agent',
        parentAgentId: undefined,
      } as any)

    for (let i = 0; i < 5; i++) {
      expect(() => toolCall(`tool-${i}`)).not.toThrow()
    }

    // The chat still shows the tool calls and later events keep flowing.
    expect(
      (getMessages()[0].blocks ?? []).filter((b) => b.type === 'tool'),
    ).toHaveLength(5)
    createStreamChunkHandler(ctx)('still streaming')
    expect(
      (getMessages()[0].blocks ?? []).some(
        (b) => b.type === 'text' && b.content === 'still streaming',
      ),
    ).toBe(true)

    // Reported with the stack, but bounded per run.
    expect(errors).toHaveLength(3)
    expect(errors[0]!.msg).toBe('SDK event handler failed; the run continues')
    expect(errors[0]!.data).toMatchObject({
      handler: 'event',
      sdkEvent: 'tool_call',
      error: { name: 'Error', message: expect.stringContaining('#185') },
    })
    expect(errors[0]!.data.error.stack).toContain('sdk-event-handlers')
  })

  test('extracts plan content from root stream', () => {
    const { ctx, getMessages, getHasPlanResponse } = createTestContext('PLAN')
    const handleChunk = createStreamChunkHandler(ctx)

    handleChunk('<PLAN>Build plan</PLAN>')

    const blocks = getMessages()[0].blocks ?? []
    expect(blocks.find((b) => b.type === 'plan')).toMatchObject({
      content: 'Build plan',
    })
    expect(getHasPlanResponse()).toBe(true)
  })

  test('keeps orphan-close reasoning out of root text', () => {
    const { ctx, getMessages } = createTestContext()
    const handleChunk = createStreamChunkHandler(ctx)

    handleChunk('Private reasoning</thi')
    handleChunk('nk>Answer')

    expect(getMessages()[0].blocks).toMatchObject([
      {
        type: 'text',
        content: 'Private reasoning',
        textType: 'reasoning',
        thinkingOpen: false,
      },
      {
        type: 'text',
        content: 'Answer',
        textType: 'text',
      },
    ])
  })

  test('maps spawn agent placeholder to real agent', () => {
    const { ctx, getMessages, getStreamingAgents, streamRefs } =
      createTestContext()
    ctx.streaming.setStreamingAgents(() => new Set(['tool-1-0']))
    ctx.message.updater.addBlock(
      createAgentBlock({ agentId: 'tool-1-0', agentType: 'temp' }),
    )
    streamRefs.controller.setters.setSpawnAgentInfo('tool-1-0', {
      index: 0,
      agentType: 'file-picker',
    })

    const handleEvent = createEventHandler(ctx)
    const startEvent: SubagentStartEvent = {
      type: 'subagent_start',
      agentId: 'agent-real',
      agentType: 'codebuff/file-picker@1.0.0',
      displayName: 'Agent',
      onlyChild: false,
      parentAgentId: undefined,
      params: undefined,
      prompt: undefined,
    }
    handleEvent(startEvent)

    const agentBlock = (getMessages()[0].blocks ?? [])[0] as AgentContentBlock
    expect(agentBlock.agentId).toBe('agent-real')
    expect(getStreamingAgents().has('agent-real')).toBe(true)
    expect(getStreamingAgents().has('tool-1-0')).toBe(false)
  })

  test('never renders hidden agents (context-pruner)', () => {
    const { ctx, getMessages, getStreamingAgents } = createTestContext()
    const handleEvent = createEventHandler(ctx)

    // Spawned via a visible spawn_agents call: no block, no streaming id
    handleEvent({
      type: 'tool_call',
      toolCallId: 'tool-1',
      toolName: 'spawn_agents',
      input: {
        agents: [
          { agent_type: 'context-pruner' },
          { agent_type: 'file-picker', prompt: 'Find files' },
        ],
      },
      agentId: 'main-agent',
      parentAgentId: undefined,
    } as any)

    const blocks = getMessages()[0].blocks ?? []
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as AgentContentBlock).agentType).toBe('file-picker')
    expect(getStreamingAgents().has('tool-1-0')).toBe(false)
    expect(getStreamingAgents().has('tool-1-1')).toBe(true)

    // Lifecycle events for the pruner itself: ignored end to end
    handleEvent({
      type: 'subagent_start',
      agentId: 'pruner-1',
      agentType: 'context-pruner',
      displayName: 'Context Pruner',
      onlyChild: false,
      parentAgentId: undefined,
      params: undefined,
      prompt: undefined,
    })
    handleEvent({
      type: 'subagent_finish',
      agentId: 'pruner-1',
      agentType: 'context-pruner',
      displayName: 'Context Pruner',
      onlyChild: false,
      parentAgentId: undefined,
      params: undefined,
      prompt: undefined,
    })

    const blocksAfter = getMessages()[0].blocks ?? []
    expect(blocksAfter).toHaveLength(1)
    expect(getStreamingAgents().has('pruner-1')).toBe(false)
  })

  test('matches underscore direct-tool aliases to hyphenated agent ids', () => {
    const { ctx, getMessages, getStreamingAgents } = createTestContext()
    const handleEvent = createEventHandler(ctx)
    const handleChunk = createStreamChunkHandler(ctx)

    handleEvent({
      type: 'tool_call',
      toolCallId: 'tool-1',
      toolName: 'spawn_agents',
      input: {
        agents: [
          {
            agent_type: 'code_reviewer_lite',
            prompt: 'Review this change',
          },
        ],
      },
      agentId: 'main-agent',
      parentAgentId: undefined,
    } as any)

    handleEvent({
      type: 'subagent_start',
      agentId: 'agent-real',
      agentType: 'code-reviewer-lite',
      displayName: 'Code Reviewer Lite',
      onlyChild: true,
      parentAgentId: undefined,
      params: undefined,
      prompt: 'Review this change',
    })

    handleChunk({
      type: 'subagent_chunk',
      agentId: 'agent-real',
      agentType: 'code-reviewer-lite',
      chunk: 'streamed review',
    })

    handleEvent({
      type: 'subagent_finish',
      agentId: 'agent-real',
      agentType: 'code-reviewer-lite',
      displayName: 'Code Reviewer Lite',
      onlyChild: true,
      parentAgentId: undefined,
      params: undefined,
      prompt: 'Review this change',
    })

    handleEvent({
      type: 'tool_result',
      toolCallId: 'tool-1',
      toolName: 'spawn_agents',
      output: [
        {
          type: 'json',
          value: [
            {
              agentName: 'code-reviewer-lite',
              agentType: 'code-reviewer-lite',
              value: 'streamed review',
            },
          ],
        },
      ],
    } as any)

    const blocks = getMessages()[0].blocks ?? []
    expect(blocks).toHaveLength(1)
    const agentBlock = blocks[0] as AgentContentBlock
    expect(agentBlock.agentId).toBe('agent-real')
    expect(agentBlock.agentName).toBe('code-reviewer-lite')
    expect(agentBlock.agentType).toBe('code-reviewer-lite')
    expect(agentBlock.status).toBe('complete')
    expect(agentBlock.blocks).toHaveLength(1)
    expect(agentBlock.blocks?.[0]).toMatchObject({
      type: 'text',
      content: 'streamed review',
    })
    expect(getStreamingAgents().size).toBe(0)
  })

  test('preserves spawn_agents params on placeholder agent blocks', () => {
    const { ctx, getMessages, getStreamingAgents } = createTestContext()
    const handleEvent = createEventHandler(ctx)

    handleEvent({
      type: 'tool_call',
      toolCallId: 'tool-1',
      toolName: 'spawn_agents',
      input: {
        agents: [
          {
            agent_type: 'basher',
            params: {
              command: 'git status --short',
              what_to_summarize: 'Report whether the worktree is clean',
            },
          },
        ],
      },
      agentId: 'main-agent',
      parentAgentId: undefined,
    } as any)

    const agentBlock = (getMessages()[0].blocks ?? [])[0] as AgentContentBlock
    expect(agentBlock.agentId).toBe('tool-1-0')
    expect(agentBlock.agentType).toBe('basher')
    expect(agentBlock.initialPrompt).toBe('')
    expect(agentBlock.params).toEqual({
      command: 'git status --short',
      what_to_summarize: 'Report whether the worktree is clean',
    })
    expect(getStreamingAgents().has('tool-1-0')).toBe(true)
  })

  test('handles spawn_agents tool results and clears streaming agents', () => {
    const { ctx, getMessages, getStreamingAgents } = createTestContext()
    ctx.message.updater.addBlock(
      createAgentBlock({
        agentId: 'tool-1-0',
        agentType: 'temp',
        spawnToolCallId: 'tool-1',
        spawnIndex: 0,
      }),
    )
    ctx.streaming.setStreamingAgents(() => new Set(['tool-1-0']))

    const handleEvent = createEventHandler(ctx)
    const toolResultEvent: ToolResultEvent = {
      type: 'tool_result',
      toolCallId: 'tool-1',
      toolName: 'spawn_agents',
      output: [
        {
          type: 'json',
          value: [
            {
              agentName: 'child',
              value: 'child result',
            },
          ],
        },
      ],
    }
    handleEvent(toolResultEvent)

    const agentBlock = (getMessages()[0].blocks ?? [])[0] as AgentContentBlock
    expect(agentBlock.status).toBe('complete')
    expect(agentBlock.blocks?.[0]).toMatchObject({
      type: 'text',
      content: 'child result',
    })
    expect(getStreamingAgents().size).toBe(0)
  })

  test('hides spawn_agents error placeholders with no user-facing output', () => {
    const { ctx, getMessages, getStreamingAgents } = createTestContext()
    ctx.message.updater.addBlock(
      createAgentBlock({
        agentId: 'tool-1-0',
        agentType: 'basher',
        spawnToolCallId: 'tool-1',
        spawnIndex: 0,
      }),
    )
    ctx.streaming.setStreamingAgents(() => new Set(['tool-1-0']))

    const handleEvent = createEventHandler(ctx)
    const toolResultEvent: ToolResultEvent = {
      type: 'tool_result',
      toolCallId: 'tool-1',
      toolName: 'spawn_agents',
      output: [
        {
          type: 'json',
          value: [
            {
              agentName: 'basher',
              value: {
                errorMessage:
                  'Error spawning agent: Invalid params for agent basher',
              },
            },
          ],
        },
      ],
    }
    handleEvent(toolResultEvent)

    expect(getMessages()[0].blocks).toEqual([])
    expect(getStreamingAgents().size).toBe(0)
  })

  test('renders spawn_agents error content when agent already streamed output', () => {
    const { ctx, getMessages, getStreamingAgents } = createTestContext()
    ctx.message.updater.updateAiMessageBlocks(() => [
      {
        type: 'agent',
        agentId: 'tool-1-0',
        agentName: 'Basher',
        agentType: 'basher',
        content: '',
        status: 'running',
        blocks: [
          {
            type: 'text',
            content: 'Checking files...',
            textType: 'text',
          },
        ],
        initialPrompt: '',
        spawnToolCallId: 'tool-1',
        spawnIndex: 0,
      } as any,
    ])
    ctx.streaming.setStreamingAgents(() => new Set(['tool-1-0']))

    const handleEvent = createEventHandler(ctx)
    const toolResultEvent: ToolResultEvent = {
      type: 'tool_result',
      toolCallId: 'tool-1',
      toolName: 'spawn_agents',
      output: [
        {
          type: 'json',
          value: [
            {
              agentName: 'basher',
              value: {
                errorMessage:
                  'Error spawning agent: Invalid params for agent basher',
              },
            },
          ],
        },
      ],
    }
    handleEvent(toolResultEvent)

    const agentBlock = (getMessages()[0].blocks ?? [])[0] as AgentContentBlock
    expect(agentBlock.status).toBe('complete')
    expect(agentBlock.blocks).toHaveLength(2)
    expect(agentBlock.blocks?.[0]).toMatchObject({
      type: 'text',
      content: 'Checking files...',
    })
    expect(agentBlock.blocks?.[1]).toMatchObject({
      type: 'text',
      content: 'Error spawning agent: Invalid params for agent basher',
    })
    expect(getStreamingAgents().size).toBe(0)
  })

  test('handles spawn_agents tool results for agents with tool blocks (lastMessage mode)', () => {
    const { ctx, getMessages, getStreamingAgents } = createTestContext()

    // Create an agent block with an existing tool block (simulating thinker agent's read_files)
    ctx.message.updater.updateAiMessageBlocks(() => [
      {
        type: 'agent',
        agentId: 'tool-1-0',
        agentName: 'Thinker',
        agentType: 'thinker-with-files-gemini',
        content: '',
        status: 'running',
        blocks: [
          {
            type: 'tool',
            toolCallId: 'read-1',
            toolName: 'read_files',
            input: { paths: ['package.json'] },
            output: 'package contents',
          },
        ],
        initialPrompt: 'Think about this',
        spawnToolCallId: 'tool-1',
        spawnIndex: 0,
      } as any,
    ])
    ctx.streaming.setStreamingAgents(() => new Set(['tool-1-0']))

    const handleEvent = createEventHandler(ctx)
    const toolResultEvent: ToolResultEvent = {
      type: 'tool_result',
      toolCallId: 'tool-1',
      toolName: 'spawn_agents',
      output: [
        {
          type: 'json',
          value: [
            {
              agentName: 'thinker-with-files-gemini',
              value: {
                type: 'lastMessage',
                value: [
                  {
                    role: 'assistant',
                    content: [
                      { type: 'text', text: 'Here is the analysis result.' },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    handleEvent(toolResultEvent)

    const agentBlock = (getMessages()[0].blocks ?? [])[0] as AgentContentBlock
    expect(agentBlock.status).toBe('complete')
    // Should have the tool block AND the final text content
    expect(agentBlock.blocks).toHaveLength(2)
    expect(agentBlock.blocks?.[0]).toMatchObject({
      type: 'tool',
      toolName: 'read_files',
    })
    expect(agentBlock.blocks?.[1]).toMatchObject({
      type: 'text',
      content: 'Here is the analysis result.',
    })
    expect(getStreamingAgents().size).toBe(0)
  })

  test('preserves streamed text content and skips duplicate final content', () => {
    const { ctx, getMessages, getStreamingAgents } = createTestContext()

    // Create an agent block with existing text blocks (simulating streamed output like basher)
    ctx.message.updater.updateAiMessageBlocks(() => [
      {
        type: 'agent',
        agentId: 'tool-1-0',
        agentName: 'Basher',
        agentType: 'basher',
        content: '',
        status: 'running',
        blocks: [
          {
            type: 'text',
            content: 'Streamed output from basher',
            textType: 'text',
          },
        ],
        initialPrompt: 'Run a command',
        spawnToolCallId: 'tool-1',
        spawnIndex: 0,
      } as any,
    ])
    ctx.streaming.setStreamingAgents(() => new Set(['tool-1-0']))

    const handleEvent = createEventHandler(ctx)
    const toolResultEvent: ToolResultEvent = {
      type: 'tool_result',
      toolCallId: 'tool-1',
      toolName: 'spawn_agents',
      output: [
        {
          type: 'json',
          value: [
            {
              agentName: 'basher',
              value: {
                type: 'lastMessage',
                value: [
                  {
                    role: 'assistant',
                    content: [
                      { type: 'text', text: 'Streamed output from basher' },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    handleEvent(toolResultEvent)

    const agentBlock = (getMessages()[0].blocks ?? [])[0] as AgentContentBlock
    expect(agentBlock.status).toBe('complete')
    // Should NOT duplicate the streamed text — only the original text block
    expect(agentBlock.blocks).toHaveLength(1)
    expect(agentBlock.blocks?.[0]).toMatchObject({
      type: 'text',
      content: 'Streamed output from basher',
    })
    expect(getStreamingAgents().size).toBe(0)
  })
})
