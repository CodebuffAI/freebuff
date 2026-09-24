import { describe, expect, test } from 'bun:test'

import {
  parseProjectProfileToolInput,
  runProjectProfileReport,
  shouldOfferProjectProfileTool,
} from '../project-profile'

import type { ProjectProfileReport } from '@codebuff/common/constants/project-profile'
import type { StreamChunk } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

function streamOf(chunks: StreamChunk[]) {
  return (async function* () {
    for (const chunk of chunks) yield chunk
    return { aborted: false as const, value: null }
  })() as any
}

describe('shouldOfferProjectProfileTool', () => {
  const base = {
    costMode: 'free',
    isRoot: true,
    toolNames: ['read_files', 'write_file'],
    getProjectProfile: async () => null,
    reportProjectProfile: async () => true,
  }

  test('offers the tool to a free root agent that reads files', () => {
    expect(shouldOfferProjectProfileTool(base)).toBe(true)
  })

  test('skips paid runs, subagents, agents without read_files and hosts without the client', () => {
    expect(shouldOfferProjectProfileTool({ ...base, costMode: 'normal' })).toBe(
      false,
    )
    expect(shouldOfferProjectProfileTool({ ...base, isRoot: false })).toBe(
      false,
    )
    expect(
      shouldOfferProjectProfileTool({ ...base, toolNames: ['decide'] }),
    ).toBe(false)
    expect(
      shouldOfferProjectProfileTool({ ...base, getProjectProfile: undefined }),
    ).toBe(false)
  })
})

describe('parseProjectProfileToolInput', () => {
  test('keeps an unchanged report', () => {
    expect(parseProjectProfileToolInput({ status: 'unchanged' })).toEqual({
      changed: false,
    })
  })

  test('passes on not enough context', () => {
    expect(parseProjectProfileToolInput({ status: 'not_enough_context' })).toBe(
      'not_enough_context',
    )
  })

  test('maps an updated report and removes repeated app kinds', () => {
    expect(
      parseProjectProfileToolInput({
        status: 'updated',
        app_kinds: ['Web app', 'Mobile app', 'Web app'],
        technologies: ['TypeScript', 'Next.js'],
      }),
    ).toEqual({
      changed: true,
      appKinds: ['Web app', 'Mobile app'],
      technologies: ['TypeScript', 'Next.js'],
    })
  })

  test('rejects an updated report without a full profile or with an unknown app kind', () => {
    expect(
      parseProjectProfileToolInput({ status: 'updated', technologies: ['Go'] }),
    ).toBeNull()
    expect(
      parseProjectProfileToolInput({
        status: 'updated',
        app_kinds: [],
        technologies: ['Go'],
      }),
    ).toBeNull()
    expect(
      parseProjectProfileToolInput({
        status: 'updated',
        app_kinds: ['Spaceship'],
        technologies: [],
      }),
    ).toBeNull()
  })
})

describe('runProjectProfileReport', () => {
  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ]

  test('does nothing when a report is not due', async () => {
    let streamed = false
    await runProjectProfileReport({
      history,
      getProjectProfile: async () => ({ due: false, profile: null }),
      reportProjectProfile: async () => true,
      stream: () => {
        streamed = true
        return streamOf([])
      },
      logger,
    })
    expect(streamed).toBe(false)
  })

  test('sends the current profile and forwards the tool call', async () => {
    let sentMessages: Message[] = []
    const reports: ProjectProfileReport[] = []
    await runProjectProfileReport({
      history,
      getProjectProfile: async () => ({
        due: true,
        profile: { appKinds: ['Web app'], technologies: ['TypeScript'] },
      }),
      reportProjectProfile: async ({ report }) => {
        reports.push(report)
        return true
      },
      stream: (messages) => {
        sentMessages = messages
        return streamOf([
          { type: 'text', text: 'ok' },
          {
            type: 'tool-call',
            toolCallId: '1',
            toolName: 'report_project_profile',
            input: {
              status: 'updated',
              app_kinds: ['Web app'],
              technologies: ['TypeScript', 'Tailwind CSS'],
            },
          },
        ])
      },
      logger,
    })
    expect(sentMessages.slice(0, history.length)).toEqual(history)
    const request = JSON.stringify(sentMessages.at(-1))
    expect(request).toContain('app_kinds: Web app')
    expect(request).toContain('technologies: TypeScript')
    expect(reports).toEqual([
      {
        changed: true,
        appKinds: ['Web app'],
        technologies: ['TypeScript', 'Tailwind CSS'],
      },
    ])
  })

  test('reports nothing when the agent has not seen enough', async () => {
    const reports: ProjectProfileReport[] = []
    await runProjectProfileReport({
      history,
      getProjectProfile: async () => ({ due: true, profile: null }),
      reportProjectProfile: async ({ report }) => {
        reports.push(report)
        return true
      },
      stream: () =>
        streamOf([
          {
            type: 'tool-call',
            toolCallId: '1',
            toolName: 'report_project_profile',
            input: { status: 'not_enough_context' },
          },
        ]),
      logger,
    })
    expect(reports).toEqual([])
  })

  test('reports nothing when the model calls another tool', async () => {
    const reports: ProjectProfileReport[] = []
    await runProjectProfileReport({
      history,
      getProjectProfile: async () => ({ due: true, profile: null }),
      reportProjectProfile: async ({ report }) => {
        reports.push(report)
        return true
      },
      stream: () =>
        streamOf([
          {
            type: 'tool-call',
            toolCallId: '1',
            toolName: 'read_files',
            input: { paths: ['a'] },
          },
        ]),
      logger,
    })
    expect(reports).toEqual([])
  })

  test('never throws when the profile service fails', async () => {
    await runProjectProfileReport({
      history,
      getProjectProfile: async () => {
        throw new Error('down')
      },
      reportProjectProfile: async () => true,
      stream: () => streamOf([]),
      logger,
    })
  })
})
