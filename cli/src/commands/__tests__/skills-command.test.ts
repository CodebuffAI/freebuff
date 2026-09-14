import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { useChatStore } from '../../state/chat-store'
import {
  __resetSkillRegistryForTests,
  __setSkillsForTests,
} from '../../utils/skill-registry'
import { findCommand } from '../command-registry'

import type { RouterParams } from '../command-registry'
import type { SkillDefinition } from '@codebuff/common/types/skill'

const PROJECT_SKILL: SkillDefinition = {
  name: 'release-notes',
  description: 'Draft release notes from recent commits',
  content: '---\nname: release-notes\ndescription: Draft release notes\n---',
  filePath: '/project/.agents/skills/release-notes/SKILL.md',
}

const GLOBAL_SKILL: SkillDefinition = {
  name: 'git-helper',
  description: 'Helpful git workflows',
  content: '---\nname: git-helper\ndescription: Helpful git workflows\n---',
  filePath: '/home/user/.agents/skills/git-helper/SKILL.md',
}

const createMockParams = (overrides: Partial<RouterParams> = {}): RouterParams =>
  ({
    agentMode: 'DEFAULT',
    inputRef: { current: null },
    inputValue: '/skills',
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
  __setSkillsForTests({
    [PROJECT_SKILL.name]: PROJECT_SKILL,
    [GLOBAL_SKILL.name]: GLOBAL_SKILL,
  })
})

afterEach(() => {
  __resetSkillRegistryForTests()
})

describe('/skills command', () => {
  test('opens the panel when skills are loaded', async () => {
    const command = findCommand('skills')
    expect(command).toBeDefined()

    const params = createMockParams()
    const result = await command!.handler(params, '')

    expect(result).toMatchObject({ openSkillsPanel: true })
    expect(params.sendMessage).not.toHaveBeenCalled()
  })

  test('reports install guidance instead of opening an empty panel', async () => {
    __resetSkillRegistryForTests()

    const command = findCommand('skills')
    const params = createMockParams()
    const result = await command!.handler(params, '')

    expect(result).toBeUndefined()
    expect(params.setMessages).toHaveBeenCalledTimes(1)
    const [updater] = (params.setMessages as ReturnType<typeof mock>).mock
      .calls[0] as [(prev: unknown[]) => unknown[]]
    const messages = updater([]) as { role: string; content: string }[]
    const last = messages[messages.length - 1]
    expect(last.content).toContain('No skills loaded')
    expect(last.content).toContain('npx skills add')
  })

  test('is reachable through the skill alias', () => {
    expect(findCommand('skill')).toBeDefined()
  })
})
