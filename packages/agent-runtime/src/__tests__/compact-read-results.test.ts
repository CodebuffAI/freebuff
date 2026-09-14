import * as analytics from '@codebuff/common/analytics'
import {
  createTestAgentRuntimeParams,
  mockFileContext,
} from '@codebuff/common/testing/fixtures/agent-runtime'
import {
  createMockDbOperations,
  setupDbSpies,
} from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import {
  createFileReadLimiter,
  windowFileRead,
} from '@codebuff/common/util/file-read-limits'
import { afterEach, expect, it, mock, spyOn } from 'bun:test'

import { byokModelLimits } from '../../../../sdk/src/byok'
import { loopAgentSteps } from '../run-agent-step'
import { countTokens, countTokensMessages } from '../util/token-counter'
import { createToolCallChunk } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

afterEach(() => mock.restore())

// The reporter's failure shape: a ~9k live request plus an SDK-limited batch
// of file reads exceeds BYOK's default 25,804-token input threshold. Previously
// each successful read vanished before inference, so the model could only
// reread. The control uses identical history and files with a larger window.
for (const contextWindow of [32768, 131072]) {
  it(`progresses from reading to writing with a ${contextWindow}-token BYOK window`, async () => {
    const db = setupDbSpies(createMockDbOperations())
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})
    const limits = byokModelLimits({ contextWindow })
    const runtime = createTestAgentRuntimeParams()
    const template: AgentTemplate = {
      ...runtime.agentTemplate,
      spawnerPrompt: 'Read-result preservation probe',
      outputMode: 'last_message',
      toolNames: ['read_files', 'write_file', 'end_turn'],
      instructionsPrompt: '',
      mcpServers: {},
      spawnableAgents: [],
      windowedFileReads: true,
      compactContext: {
        maxContextLength: limits.maxContextLength,
        cacheExpiryMs: null,
      },
    }
    const source =
      '// FILE_CONTENT_CANARY\n' +
      Array.from(
        { length: 1900 },
        (_, i) =>
          `export const row${i} = { label: 'Action ${i}', enabled: true };`,
      ).join('\n')
    let reads = 0
    let compactions = 0
    const writes: Record<string, string> = {}
    const requests: Message[][] = []
    runtime.requestFiles = mock(async ({ filePaths, fileWindows }) => {
      const limiter = createFileReadLimiter({ countTokens })
      const files = Object.fromEntries(
        filePaths.map((path: string) => {
          const window = fileWindows?.[path]?.[0]
          return [
            path,
            limiter.limit(
              windowFileRead(source, window?.offset, window?.limit),
            ),
          ]
        }),
      )
      reads++
      expect(JSON.stringify(files)).toContain('FILE_CONTENT_CANARY')
      return files
    })
    runtime.requestToolCall = mock(async ({ toolName, input }) => {
      expect(toolName).toBe('write_file')
      writes[input.path] = input.content
      return { output: [{ type: 'json', value: { message: 'File written' } }] }
    })
    runtime.promptAiSdkStream = mock(async function* ({
      messages,
    }: {
      messages: Message[]
    }) {
      requests.push(structuredClone(messages))
      expect(countTokensMessages(messages)).toBeLessThanOrEqual(
        limits.maxContextLength,
      )
      if (writes['ready.ts'] || reads >= 3) {
        yield createToolCallChunk('end_turn', {})
      } else if (JSON.stringify(messages).includes('FILE_CONTENT_CANARY')) {
        yield createToolCallChunk('write_file', {
          path: 'ready.ts',
          instructions: 'Record successful progress after the read.',
          content: 'export const ready = true\n',
        })
      } else {
        yield createToolCallChunk('read_files', {
          paths: ['src/app.tsx', 'src/theme.ts'],
        })
      }
      return promptSuccess('synthetic-response')
    })

    try {
      const result = await loopAgentSteps({
        ...runtime,
        agentTemplate: template,
        agentType: template.id,
        localAgentTemplates: { [template.id]: template },
        repoId: undefined,
        repoUrl: undefined,
        userInputId: 'test-input',
        agentState: {
          ...getInitialSessionState(mockFileContext).mainAgentState,
          agentId: 'test-agent',
          messageHistory: [
            {
              role: 'user',
              tags: ['USER_PROMPT'],
              sentAt: Date.now(),
              content: [
                {
                  type: 'text',
                  text: 'Improve accessibility, keyboard navigation, colors, layout, and help text.\n'.repeat(
                    470,
                  ),
                },
              ],
            },
          ],
          stepsRemaining: 5,
        },
        prompt: undefined,
        spawnParams: undefined,
        fingerprintId: 'test-fingerprint',
        userId: 'test-user',
        clientSessionId: 'test-session',
        ancestorRunIds: [],
        onCompaction: () => {
          compactions++
        },
        onResponseChunk: () => {},
        signal: new AbortController().signal,
      } as any)
      expect(result.output?.type).not.toBe('error')
      expect(reads).toBe(1)
      expect(writes['ready.ts']).toBe('export const ready = true\n')
      const afterRead = requests[1]
      expect(
        afterRead.some(
          (message) =>
            message.role === 'tool' && message.toolName === 'read_files',
        ),
      ).toBe(true)
      expect(JSON.stringify(afterRead)).toContain('FILE_CONTENT_CANARY')
      if (contextWindow === 32768) {
        expect(compactions).toBeGreaterThan(0)
        expect(JSON.stringify(afterRead)).toContain(
          'omitted to fit the context window',
        )
      } else {
        expect(compactions).toBe(0)
        expect(JSON.stringify(afterRead)).not.toContain(
          'omitted to fit the context window',
        )
      }
    } finally {
      db.restore()
    }
  })
}
