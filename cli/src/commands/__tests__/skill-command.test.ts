import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { useChatStore } from '../../state/chat-store'
import {
  __resetSkillRegistryForTests,
  __setSkillsForTests,
} from '../../utils/skill-registry'
import { findCommand } from '../command-registry'
import { buildSkillPrompt } from '../prompt-builders'
import { routeUserPrompt } from '../router'

import type { RouterParams } from '../command-registry'
import type { SkillDefinition } from '@codebuff/common/types/skill'

const TEST_SKILL: SkillDefinition = {
  name: 'release-notes',
  description: 'Draft release notes from recent commits',
  content:
    '---\nname: release-notes\ndescription: Draft release notes\n---\n\nDo the thing.',
  filePath: '/tmp/skills/release-notes/SKILL.md',
}

const createMockParams = (overrides: Partial<RouterParams> = {}): RouterParams =>
  ({
    agentMode: 'DEFAULT',
    inputRef: { current: null },
    inputValue: '',
    isChainInProgressRef: { current: false },
    isStreaming: false,
    logoutMutation: {} as RouterParams['logoutMutation'],
    streamMessageIdRef: { current: null },
    addToQueue: mock(() => {}),
    clearMessages: mock(() => {}),
    saveToHistory: mock(() => {}),
    scrollToLatest: mock(() => {}),
    sendMessage: mock(async () => {}),
    setCanProcessQueue: mock(() => {}),
    setInputFocused: mock(() => {}),
    setInputValue: mock(() => {}),
    setIsAuthenticated: mock(() => {}),
    setMessages: mock(() => {}),
    setUser: mock(() => {}),
    ...overrides,
  }) as RouterParams

const resetChatStore = () => {
  useChatStore.getState().setInputMode('default')
  useChatStore.getState().setPendingSkillName(null)
}

beforeEach(() => {
  __setSkillsForTests({ [TEST_SKILL.name]: TEST_SKILL })
  resetChatStore()
})

afterEach(() => {
  __resetSkillRegistryForTests()
  resetChatStore()
})

describe('/skill:<name> command', () => {
  test('bare invocation enters skill input mode instead of sending', async () => {
    const command = findCommand('skill:release-notes')
    expect(command).toBeDefined()

    const params = createMockParams({ inputValue: '/skill:release-notes' })
    await command!.handler(params, '')

    expect(useChatStore.getState().inputMode).toBe('skill')
    expect(useChatStore.getState().pendingSkillName).toBe('release-notes')
    expect(params.sendMessage).not.toHaveBeenCalled()
    expect(params.addToQueue).not.toHaveBeenCalled()
  })

  test('invocation with trailing text sends immediately', async () => {
    const command = findCommand('skill:release-notes')
    const params = createMockParams({
      inputValue: '/skill:release-notes for v2.1 only',
    })
    await command!.handler(params, 'for v2.1 only')

    expect(useChatStore.getState().inputMode).toBe('default')
    expect(params.sendMessage).toHaveBeenCalledTimes(1)
    const [{ content }] = (params.sendMessage as ReturnType<typeof mock>).mock
      .calls[0] as [{ content: string }]
    expect(content).toBe(buildSkillPrompt(TEST_SKILL, 'for v2.1 only'))
    expect(content).toContain('<skill name="release-notes">')
    expect(content).toContain(
      'Base directory for this skill: "/tmp/skills/release-notes/"',
    )
    expect(content).toContain('User request: for v2.1 only')
  })

  test('a Windows skill keeps its resource directory in the submitted prompt', async () => {
    const skill = {
      ...TEST_SKILL,
      filePath:
        'C:\\Users\\Test User\\.agents\\skills\\release-notes\\SKILL.md',
      content: 'Read references/guide.md, then run scripts/check.js.',
    }
    __setSkillsForTests({ [skill.name]: skill })
    const command = findCommand('skill:release-notes')!
    const params = createMockParams({ inputValue: '/skill:release-notes run it' })
    await command.handler(params, 'run it')

    const [{ content }] = (params.sendMessage as ReturnType<typeof mock>).mock
      .calls[0] as [{ content: string }]
    expect(content).toContain(
      'Base directory for this skill: "C:/Users/Test User/.agents/skills/release-notes/"',
    )
    expect(content).toContain("not the project's working directory")
    expect(content).toContain(skill.content)
  })
})

describe('skill input mode submit', () => {
  const enterSkillMode = () => {
    useChatStore.getState().setInputMode('skill')
    useChatStore.getState().setPendingSkillName(TEST_SKILL.name)
  }

  test('submit with text sends the skill plus the user request', async () => {
    enterSkillMode()
    const params = createMockParams({ inputValue: 'focus on the API changes' })
    await routeUserPrompt(params)

    expect(useChatStore.getState().inputMode).toBe('default')
    expect(useChatStore.getState().pendingSkillName).toBeNull()
    expect(params.sendMessage).toHaveBeenCalledTimes(1)
    const [{ content }] = (params.sendMessage as ReturnType<typeof mock>).mock
      .calls[0] as [{ content: string }]
    expect(content).toBe(
      buildSkillPrompt(TEST_SKILL, 'focus on the API changes'),
    )
    expect(content).toContain(
      'Base directory for this skill: "/tmp/skills/release-notes/"',
    )
  })

  test('empty submit runs the skill without a user request', async () => {
    enterSkillMode()
    const params = createMockParams({ inputValue: '' })
    await routeUserPrompt(params)

    expect(params.sendMessage).toHaveBeenCalledTimes(1)
    const [{ content }] = (params.sendMessage as ReturnType<typeof mock>).mock
      .calls[0] as [{ content: string }]
    expect(content).toBe(buildSkillPrompt(TEST_SKILL, ''))
    expect(content).not.toContain('User request:')
  })

  test('submit while a turn is running queues instead of sending', async () => {
    enterSkillMode()
    const params = createMockParams({
      inputValue: 'and be brief',
      isStreaming: true,
    })
    await routeUserPrompt(params)

    expect(params.sendMessage).not.toHaveBeenCalled()
    expect(params.addToQueue).toHaveBeenCalledTimes(1)
    const [queued] = (params.addToQueue as ReturnType<typeof mock>).mock
      .calls[0] as [string]
    expect(queued).toBe(buildSkillPrompt(TEST_SKILL, 'and be brief'))
  })

  test('a skill deleted mid-session reports instead of sending nothing', async () => {
    enterSkillMode()
    __resetSkillRegistryForTests()
    const params = createMockParams({ inputValue: 'anything' })
    await routeUserPrompt(params)

    expect(params.sendMessage).not.toHaveBeenCalled()
    expect(params.setMessages).toHaveBeenCalled()
    expect(useChatStore.getState().inputMode).toBe('default')
  })

  test('leaving skill mode clears the pending skill', () => {
    enterSkillMode()
    useChatStore.getState().setInputMode('default')
    expect(useChatStore.getState().pendingSkillName).toBeNull()
  })
})
