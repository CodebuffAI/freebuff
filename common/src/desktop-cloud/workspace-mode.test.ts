import { describe, expect, test } from 'bun:test'

import {
  chatWorkspaceMode,
  isProjectWorkspaceMode,
  isWorkspaceMode,
  projectWorkspaceMode,
} from './workspace-mode'

describe('workspace mode', () => {
  test('a project is Code unless it was created as Chat', () => {
    expect(projectWorkspaceMode(undefined)).toBe('code')
    expect(projectWorkspaceMode(null)).toBe('code')
    expect(projectWorkspaceMode({})).toBe('code')
    expect(projectWorkspaceMode({ mode: null })).toBe('code')
    expect(projectWorkspaceMode({ mode: 'code' })).toBe('code')
    expect(projectWorkspaceMode({ mode: 'chat' })).toBe('chat')
    expect(projectWorkspaceMode({ mode: 'anything' })).toBe('code')
  })

  test('a chat follows its project, a projectless chat is Chat, a device chat is Code', () => {
    expect(chatWorkspaceMode({ projectId: null }, null)).toBe('chat')
    expect(chatWorkspaceMode({ projectId: 'p' }, { mode: 'chat' })).toBe('chat')
    expect(chatWorkspaceMode({ projectId: 'p' }, { mode: 'code' })).toBe('code')
    expect(chatWorkspaceMode({ projectId: 'p' }, undefined)).toBe('code')
    expect(
      chatWorkspaceMode({ projectId: null, deviceExecution: { sessionId: 's', bindingId: 'b' } }, null),
    ).toBe('code')
    expect(
      chatWorkspaceMode({ projectId: 'p' }, { mode: 'chat', deviceExecution: { sessionId: 's', bindingId: 'b' } }),
    ).toBe('code')
  })

  test('the Buffy thread is Buffy mode whatever else it carries', () => {
    expect(chatWorkspaceMode({ projectId: null, buffy: true }, null)).toBe('buffy')
    expect(chatWorkspaceMode({ projectId: 'p', buffy: true }, { mode: 'code' })).toBe('buffy')
    expect(chatWorkspaceMode({ projectId: null, buffy: false }, null)).toBe('chat')
  })

  test('only the three modes are modes, and a project has one of two', () => {
    expect(isWorkspaceMode('code')).toBe(true)
    expect(isWorkspaceMode('chat')).toBe(true)
    expect(isWorkspaceMode('buffy')).toBe(true)
    expect(isWorkspaceMode('Chat')).toBe(false)
    expect(isWorkspaceMode(null)).toBe(false)
    expect(isProjectWorkspaceMode('chat')).toBe(true)
    expect(isProjectWorkspaceMode('buffy')).toBe(false)
  })
})
