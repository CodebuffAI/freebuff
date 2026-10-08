import * as analytics from '@codebuff/common/analytics'
import { FREEBUFF_TURN_SPEND_LIMIT_MESSAGE } from '@codebuff/common/constants/freebuff-errors'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { clearMockedModules } from '@codebuff/common/testing/mock-modules'
import {
  createMockDbOperations,
  setupDbSpies,
} from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { AbortError, promptSuccess } from '@codebuff/common/util/error'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { APICallError, RetryError } from 'ai'
import { z } from 'zod/v4'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPatch } from 'diff'

import { loopAgentSteps } from '../run-agent-step'
import { frameSteeringText, STEERING_NOTE } from '../util/messages'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import {
  MAX_CONSECUTIVE_STREAM_RECOVERIES,
  OUTPUT_LIMIT_TAG,
  REPEATED_OUTPUT_LIMIT_MESSAGE,
  REPEATED_STREAM_INTERRUPTIONS_MESSAGE,
  STREAM_INTERRUPTED_TAG,
} from '../tools/stream-parser'
import {
  FILE_EDIT_LOOP_RECOVERY_MESSAGE,
  FILE_EDIT_LOOP_STOP_MESSAGE,
} from '../util/file-edit-loop'
import {
  FILE_EDIT_TOOLS_UNAVAILABLE_NOTE,
  TODO_LOOP_RECOVERY_MESSAGE,
  TODO_LOOP_STOP_MESSAGE,
  WRITE_TODOS_UNCHANGED_MESSAGE,
} from '../util/todo-loop'
import {
  FOLLOWUP_TODO_NUDGE_TAG,
  MAX_FOLLOWUP_TODO_NUDGES,
} from '../util/followup-todo-nudge'
import { TODO_PROGRESS_REMINDER_TAG } from '../util/todo-progress-reminder'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'
import type { StepGenerator } from '@codebuff/common/types/agent-template'
import type { AgentState } from '@codebuff/common/types/session-state'

describe('loopAgentSteps - runAgentStep vs runProgrammaticStep behavior', () => {
  let mockTemplate: AgentTemplate
  let mockAgentState: AgentState
  let llmCallCount: number
  let agentRuntimeImpl: Omit<
    ReturnType<typeof createTestAgentRuntimeParams>,
    'agentTemplate' | 'localAgentTemplates'
  > & {
    promptAiSdkStream?: ReturnType<typeof mock>
  }
  let loopAgentStepsBaseParams: Parameters<typeof loopAgentSteps>[0]
  let dbSpies: DbSpies

  beforeAll(async () => {
    // Set up mocks.
  })

  beforeEach(() => {
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()

    agentRuntimeImpl = {
      ...baseRuntimeParams,
    }

    llmCallCount = 0

    // Setup spies for database operations using typed helper
    dbSpies = setupDbSpies(createMockDbOperations())

    agentRuntimeImpl.promptAiSdkStream = mock(async function* ({}) {
      llmCallCount++
      yield { type: 'text' as const, text: 'LLM response\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    })

    // Mock analytics
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})

    // Mock crypto.randomUUID
    spyOn(crypto, 'randomUUID').mockImplementation(
      () => 'mock-uuid-0000-0000-0000-000000000000' as const,
    )

    // Create mock template with programmatic agent
    mockTemplate = {
      id: 'test-agent',
      displayName: 'Test Agent',
      spawnerPrompt: 'Testing',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['read_files', 'write_file', 'end_turn'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test user prompt',
      stepPrompt: 'Test agent step prompt',
      handleSteps: undefined, // Will be set in individual tests
    } satisfies AgentTemplate as AgentTemplate

    // Create mock agent state
    const sessionState = getInitialSessionState(mockFileContext)
    mockAgentState = {
      ...sessionState.mainAgentState,
      agentId: 'test-agent-id',
      messageHistory: [
        userMessage('Initial message'),
        assistantMessage('Initial response'),
      ],
      output: undefined,
      stepsRemaining: 10, // Ensure we don't hit the limit
    }

    loopAgentStepsBaseParams = {
      ...agentRuntimeImpl,
      agentType: 'test-agent',
      localAgentTemplates: { 'test-agent': mockTemplate },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'test-user-input',
      agentState: mockAgentState,
      prompt: 'Test prompt',
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      onResponseChunk: () => {},
      signal: new AbortController().signal,
    }
  })

  afterEach(() => {
    clearAgentGeneratorCache(agentRuntimeImpl)
    dbSpies.restore()
    mock.restore()
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()
    agentRuntimeImpl = {
      ...baseRuntimeParams,
    }
  })

  afterAll(() => {
    clearMockedModules()
  })

  it('offers one completion check after edits, then allows a repair and finishes', async () => {
    mockTemplate.completionCheck = true
    let calls = 0
    const prompts: string[] = []
    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      promptAiSdkStream: async function* ({ messages }) {
        calls++
        prompts.push(JSON.stringify(messages))
        if (calls === 1 || calls === 3) {
          yield createToolCallChunk('write_file', {
            path: 'output.txt',
            instructions: 'Write result',
            content: 'verified',
          })
        } else {
          yield { type: 'text' as const, text: 'Done' }
        }
        return promptSuccess('completion-test')
      },
    })
    expect(calls).toBe(4)
    expect(prompts[1]).not.toContain('Final completion check:')
    expect(prompts[2]).toContain('Final completion check:')
    expect(prompts[3].split('Final completion check:')).toHaveLength(2)
  })

  it('does not add a completion check to a plain answer or exceed the step budget', async () => {
    mockTemplate.completionCheck = true
    await loopAgentSteps(loopAgentStepsBaseParams)
    expect(llmCallCount).toBe(1)
    mockAgentState.stepsRemaining = 1
    let calls = 0
    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      promptAiSdkStream: async function* () {
        calls++
        yield createToolCallChunk('write_file', {
          path: 'output.txt',
          instructions: 'Write result',
          content: 'test',
        })
        return promptSuccess('limited-test')
      },
    })
    expect(calls).toBe(1)
  })

  describe('completion check failure boundaries', () => {
    const capacityError = () =>
      new APICallError({
        message: 'Model capacity unavailable',
        url: 'https://example.com/responses',
        requestBodyValues: {},
        statusCode: 200,
        responseBody: JSON.stringify({ error: { code: 'flex_unavailable' } }),
        isRetryable: false,
      })

    beforeEach(() => {
      mockTemplate.completionCheck = true
      mockTemplate.outputMode = 'last_message'
    })

    for (const remainingMs of [-1, 39_000, 55_000, 119_999, 120_000]) {
      it(`reserves time before starting a check (${remainingMs}ms left)`, async () => {
        const now = 1_000_000
        spyOn(Date, 'now').mockReturnValue(now)
        const prompts: string[] = []
        await loopAgentSteps({
          ...loopAgentStepsBaseParams,
          deadlineAt: now + remainingMs,
          promptAiSdkStream: async function* ({ messages }) {
            prompts.push(JSON.stringify(messages))
            if (prompts.length === 1) {
              yield createToolCallChunk('write_file', {
                path: 'output.txt',
                content: 'done',
                instructions: 'Write result',
              })
            } else yield { type: 'text', text: 'Done' }
            return promptSuccess('deadline')
          },
        })
        expect(prompts).toHaveLength(remainingMs >= 120_000 ? 3 : 2)
        expect(prompts.at(-1)!.includes('Final completion check:')).toBe(
          remainingMs >= 120_000,
        )
      })
    }

    for (const failure of [
      'capacity',
      'network',
      'server',
      'text',
      'tool',
      'xml-tool',
      'after-tool',
      'abort',
      'forbidden',
      'spend-limit',
      'no-answer',
      'bug',
    ] as const) {
      it(`handles ${failure} during optional verification without hiding work or errors`, async () => {
        let calls = 0
        const controller = new AbortController()
        const emitted: unknown[] = []
        const writes: string[] = []
        const result = await loopAgentSteps({
          ...loopAgentStepsBaseParams,
          signal: controller.signal,
          onResponseChunk: (chunk) => emitted.push(chunk),
          requestToolCall: async ({ toolName, input }) => {
            if (toolName === 'write_file') writes.push(input.content)
            return { output: [{ type: 'json', value: { message: 'written' } }] }
          },
          promptAiSdkStream: async function* () {
            calls++
            if (calls === 1) {
              yield createToolCallChunk('write_file', {
                path: 'output.txt',
                content: 'original',
                instructions: 'Write result',
              })
            } else if (calls === 2) {
              if (failure === 'no-answer')
                yield createToolCallChunk('end_turn', {})
              else
                yield {
                  type: 'text',
                  text: 'Completed result; initial tests passed.',
                }
            } else {
              yield { type: 'reasoning', text: 'Checking the result.' }
              if (failure === 'text')
                yield { type: 'text', text: 'I found a failing check.' }
              if (failure === 'xml-tool') {
                yield {
                  type: 'text',
                  text:
                    '<codebuff_tool_call>' +
                    JSON.stringify({
                      cb_tool_name: 'write_file',
                      path: 'repair.txt',
                      content: 'repair',
                      instructions: 'Repair result',
                    }) +
                    '</codebuff_tool_call>',
                }
              }
              if (
                (failure === 'tool' || failure === 'after-tool') &&
                calls === 3
              ) {
                yield createToolCallChunk('write_file', {
                  path: 'repair.txt',
                  content: 'repair',
                  instructions: 'Repair result',
                })
                if (failure === 'after-tool') return promptSuccess('repair')
              }
              if (failure === 'abort') controller.abort()
              if (failure === 'bug') throw new Error('Unexpected internal bug')
              if (failure === 'network')
                throw Object.assign(new Error('connection reset'), {
                  code: 'ECONNRESET',
                })
              if (
                failure === 'forbidden' ||
                failure === 'server' ||
                failure === 'spend-limit'
              ) {
                throw new APICallError({
                  message: failure,
                  url: 'https://example.com/responses',
                  requestBodyValues: {},
                  statusCode:
                    failure === 'forbidden'
                      ? 403
                      : failure === 'spend-limit'
                        ? 429
                        : 503,
                  responseBody:
                    failure === 'spend-limit'
                      ? JSON.stringify({
                          error: 'turn_spend_limit',
                          message: FREEBUFF_TURN_SPEND_LIMIT_MESSAGE,
                        })
                      : undefined,
                })
              }
              throw capacityError()
            }
            return promptSuccess('check')
          },
        })
        const recovered = ['capacity', 'network', 'server'].includes(failure)
        expect(result.output.type).toBe(recovered ? 'lastMessage' : 'error')
        expect(calls).toBe(failure === 'after-tool' ? 4 : 3)
        if (recovered) {
          expect(JSON.stringify(result.output)).toContain(
            'Completed result; initial tests passed.',
          )
          expect(JSON.stringify(result.output)).toContain(
            'no additional verification was completed',
          )
          expect(
            JSON.stringify(result.agentState.messageHistory),
          ).not.toContain('Final completion check:')
          expect(JSON.stringify(emitted)).toContain(
            'no additional verification was completed',
          )
          expect(result.agentState.stepsRemaining).toBe(7)
        } else {
          expect(JSON.stringify(result.output)).not.toContain(
            'preceding result is preserved',
          )
        }
        // Native calls wait for a complete stream; XML calls can execute
        // before the provider fails. Neither may be treated as a clean check.
        expect(writes).toEqual(
          failure === 'xml-tool' || failure === 'after-tool'
            ? ['original', 'repair']
            : ['original'],
        )
      })
    }

    it('handles steering that arrives during a failed optional check', async () => {
      let calls = 0
      let delivered = false
      const prompts: string[] = []
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        drainSteeringMessages: async () => {
          if (calls === 3 && !delivered) {
            delivered = true
            return ['Also explain how to run it.']
          }
          return []
        },
        promptAiSdkStream: async function* ({ messages }) {
          calls++
          prompts.push(JSON.stringify(messages))
          if (calls === 1)
            yield createToolCallChunk('write_file', {
              path: 'output.txt',
              content: 'done',
              instructions: 'Write result',
            })
          else if (calls === 3) throw capacityError()
          else
            yield {
              type: 'text',
              text: calls === 2 ? 'Done' : 'Run with bun output.txt',
            }
          return promptSuccess('steering')
        },
      })
      expect(calls).toBe(4)
      expect(prompts[3]).toContain('Also explain how to run it.')
      expect(JSON.stringify(result.output)).toContain('Run with bun output.txt')
    })
  })

  describe('completion verification with real artifacts', () => {
    const good = 'module.exports = 42;\n'
    const wrong = 'module.exports = 0;\n'
    const check =
      "require('node:assert/strict').equal(require('./answer.cjs'), 42); console.log('verified 42');\n"
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const verify = `${quote(process.execPath)} check.cjs`
    const filtered = `${verify} 2>&1 | tail -n 5`
    const checkedPipeline = `set -o pipefail; ${filtered}`
    const write = (path: string, content: string) =>
      createToolCallChunk('write_file', {
        path,
        content,
        instructions: 'Update the verification fixture',
      })
    const run = (command: string) =>
      createToolCallChunk('run_terminal_command', { command })

    // Script only the model boundary. The loop, file handlers, patches and
    // shell checks execute for real. These cases prove repair/verification can
    // complete after a premature answer, not that a live model obeys the prompt.
    const scenarios = [
      {
        name: 'repairs invalid syntax before verifying the final file',
        before: () => [write('answer.cjs', 'module.exports = ;\n')],
        repair: () => [run(verify), write('answer.cjs', good), run(verify)],
        initialStatuses: [],
        repairedStatuses: [1, 0],
      },
      {
        name: 'reruns verification after an edit invalidates a previous pass',
        before: () => [
          write('answer.cjs', good),
          run(verify),
          write('answer.cjs', wrong),
        ],
        repair: () => [run(verify), write('answer.cjs', good), run(verify)],
        initialStatuses: [0],
        repairedStatuses: [0, 1, 0],
      },
      {
        name: 'exposes a failure hidden by a successful output filter',
        before: () => [write('answer.cjs', wrong), run(filtered)],
        repair: () => [
          run(checkedPipeline),
          write('answer.cjs', good),
          run(checkedPipeline),
        ],
        initialStatuses: [0],
        repairedStatuses: [0, 1, 0],
      },
      {
        name: 'restores a silenced assertion and fixes the implementation',
        before: () => [
          write('answer.cjs', wrong),
          write('check.cjs', '// Assertion removed to make the check pass.\n'),
          run(verify),
        ],
        repair: () => [
          write('check.cjs', check),
          run(verify),
          write('answer.cjs', good),
          run(verify),
        ],
        initialStatuses: [0],
        repairedStatuses: [0, 1, 0],
      },
    ]

    for (const scenario of scenarios) {
      for (const enabled of [false, true]) {
        it(`${scenario.name} (completion check ${enabled ? 'on' : 'off'})`, async () => {
          const directory = mkdtempSync(
            join(tmpdir(), 'completion-verification-'),
          )
          try {
            writeFileSync(join(directory, 'check.cjs'), check)
            writeFileSync(join(directory, 'oracle.cjs'), check)
            mockTemplate.toolNames.push('run_terminal_command')
            mockTemplate.completionCheck = enabled
            const before = scenario.before()
            const repair = scenario.repair()
            const statuses: number[] = []
            const output: string[] = []
            let calls = 0
            let completionPrompts = 0
            const result = await loopAgentSteps({
              ...loopAgentStepsBaseParams,
              prompt:
                'Make answer.cjs export 42 and verify it without weakening the assertion.',
              requestOptionalFile: async ({ filePath }) => {
                try {
                  return readFileSync(join(directory, filePath), 'utf8')
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                    return null
                  throw error
                }
              },
              requestToolCall: async ({ toolName, input }) => {
                if (toolName === 'write_file') {
                  if (!['answer.cjs', 'check.cjs'].includes(input.path))
                    throw new Error('Unexpected file')
                  const target = join(directory, input.path)
                  const content =
                    input.type === 'patch'
                      ? applyPatch(readFileSync(target, 'utf8'), input.content)
                      : input.content
                  if (typeof content !== 'string')
                    throw new Error('Patch failed')
                  writeFileSync(target, content)
                  return {
                    output: [
                      {
                        type: 'json',
                        value: { file: input.path, message: 'File written' },
                      },
                    ],
                  }
                }
                if (
                  toolName !== 'run_terminal_command' ||
                  ![verify, filtered, checkedPipeline].includes(input.command)
                ) {
                  throw new Error('Unexpected command')
                }
                const child = spawnSync('bash', ['-c', input.command], {
                  cwd: directory,
                  encoding: 'utf8',
                  timeout: 2000,
                })
                if (child.error) throw child.error
                statuses.push(child.status ?? -1)
                output.push(child.stdout + child.stderr)
                return {
                  output: [
                    {
                      type: 'json',
                      value: {
                        command: input.command,
                        exitCode: child.status,
                        stdout: child.stdout,
                        stderr: child.stderr,
                      },
                    },
                  ],
                }
              },
              promptAiSdkStream: async function* ({ messages }) {
                const index = calls++
                if (index < before.length) yield before[index]!
                else if (index === before.length)
                  yield { type: 'text', text: 'Done; everything passes.' }
                else {
                  // Repairs are reachable only if the real loop resumes after
                  // the premature answer and supplies the completion check.
                  completionPrompts = (
                    JSON.stringify(messages).match(
                      /Final completion check:/g,
                    ) ?? []
                  ).length
                  if (completionPrompts !== 1)
                    throw new Error('Expected exactly one completion check')
                  const next = repair[index - before.length - 1]
                  if (next) yield next
                  else
                    yield {
                      type: 'text',
                      text: 'Verified the final file exports 42 with the original assertion.',
                    }
                }
                return promptSuccess(`verification-${calls}`)
              },
            })
            expect(result.output.type).not.toBe('error')
            expect(calls).toBe(
              before.length + 1 + (enabled ? repair.length + 1 : 0),
            )
            expect(completionPrompts).toBe(enabled ? 1 : 0)
            expect(statuses).toEqual(
              enabled ? scenario.repairedStatuses : scenario.initialStatuses,
            )
            // Independent oracle: even deleting check.cjs cannot manufacture a pass.
            const oracle = spawnSync(process.execPath, ['oracle.cjs'], {
              cwd: directory,
              encoding: 'utf8',
              timeout: 2000,
            })
            if (oracle.error) throw oracle.error
            expect(oracle.status).toBe(enabled ? 0 : 1)
            if (enabled) {
              expect(readFileSync(join(directory, 'check.cjs'), 'utf8')).toBe(
                check,
              )
              expect(output.at(-1)).toContain('verified 42')
            }
          } finally {
            rmSync(directory, { recursive: true, force: true })
          }
        })
      }
    }
  })

  it('adds deadline reminders only when entering a new urgency threshold', async () => {
    let now = 1000000
    spyOn(Date, 'now').mockImplementation(() => now)
    const prompts: string[] = []
    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      deadlineAt: now + 600000,
      promptAiSdkStream: async function* ({ messages }) {
        prompts.push(JSON.stringify(messages))
        if (prompts.length < 4) {
          yield createToolCallChunk('read_files', { paths: ['file1.txt'] })
          if (prompts.length === 2) now += 400000
          if (prompts.length === 3) now += 150000
        } else yield { type: 'text' as const, text: 'Done' }
        return promptSuccess('deadline-test')
      },
    })
    expect(prompts[0]).toContain('600 seconds remain')
    expect(prompts[1].split('Time budget:')).toHaveLength(2)
    expect(prompts[2]).toContain('200 seconds remain')
    expect(prompts[3]).toContain('50 seconds remain')
  })

  it('stops a loop of identical rejected file edits after recovery attempts and can resume on a new prompt', async () => {
    mockAgentState.stepsRemaining = 200
    let calls = 0
    let clientWrites = 0
    const seenPrompts: string[] = []
    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      // the file already holds exactly what the model keeps sending
      requestOptionalFile: async () => 'unchanged',
      requestToolCall: async () => {
        clientWrites++
        throw new Error('a rejected write never reaches the client')
      },
      promptAiSdkStream: async function* ({ messages }) {
        calls++
        seenPrompts.push(JSON.stringify(messages))
        yield { type: 'text', text: 'Writing the file now.' }
        yield createToolCallChunk('write_file', {
          path: 'output.txt',
          instructions: `Attempt ${calls}`,
          content: 'unchanged',
        })
        return promptSuccess(`edit-${calls}`)
      },
    })

    expect(calls).toBe(6)
    expect(clientWrites).toBe(0)
    expect(seenPrompts[2]).not.toContain(FILE_EDIT_LOOP_RECOVERY_MESSAGE)
    expect(seenPrompts[3]).toContain(FILE_EDIT_LOOP_RECOVERY_MESSAGE)
    expect(result.output).toMatchObject({
      type: 'error',
      message: FILE_EDIT_LOOP_STOP_MESSAGE,
    })
    expect(
      result.agentState.messageHistory.filter(
        (m) => m.role === 'tool' && m.toolName === 'write_file',
      ),
    ).toHaveLength(6)

    let resumeCalls = 0
    const resumed = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentState: result.agentState,
      prompt: 'Try a different approach',
      requestOptionalFile: async () => 'unchanged',
      promptAiSdkStream: async function* () {
        if (++resumeCalls === 1) {
          yield createToolCallChunk('write_file', {
            path: 'output.txt',
            instructions: 'once more',
            content: 'unchanged',
          })
        } else {
          yield createToolCallChunk('end_turn', {})
        }
        return promptSuccess(`resumed-${resumeCalls}`)
      },
    })
    expect(resumeCalls).toBe(2)
    expect(resumed.output.type).not.toBe('error')
  })

  it('stops an unchanged to-do loop after recovery attempts and can resume on a new prompt', async () => {
    mockTemplate.toolNames.push('write_todos')
    mockAgentState.stepsRemaining = 200
    let calls = 0
    const seenPrompts: string[] = []
    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      promptAiSdkStream: async function* ({ messages }) {
        calls++
        seenPrompts.push(JSON.stringify(messages))
        yield { type: 'reasoning', text: 'I should stop repeating the list.' }
        yield { type: 'text', text: 'Executing now.' }
        yield createToolCallChunk('write_todos', {
          todos: [{ task: 'x', completed: false }],
        })
        return promptSuccess(`todo-${calls}`)
      },
    })

    expect(calls).toBe(6)
    expect(seenPrompts[2]).not.toContain(TODO_LOOP_RECOVERY_MESSAGE)
    expect(seenPrompts[3]).toContain(TODO_LOOP_RECOVERY_MESSAGE)
    expect(result.output).toMatchObject({
      type: 'error',
      message: TODO_LOOP_STOP_MESSAGE,
    })
    // The real tool handler completed each call; the error is the model loop,
    // not a lost result or a tool that never resolves.
    expect(
      result.agentState.messageHistory.filter(
        (m) => m.role === 'tool' && m.toolName === 'write_todos',
      ),
    ).toHaveLength(6)

    let resumeCalls = 0
    const resumed = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentState: result.agentState,
      prompt: 'Continue with a different approach',
      promptAiSdkStream: async function* () {
        if (++resumeCalls === 1) {
          yield createToolCallChunk('write_todos', {
            todos: [{ task: 'x', completed: false }],
          })
        } else {
          yield createToolCallChunk('end_turn', {})
        }
        return promptSuccess(`resumed-${resumeCalls}`)
      },
    })
    expect(resumeCalls).toBe(2)
    expect(resumed.output.type).not.toBe('error')
  })

  it('allows the model to recover by using another tool, then update its list again', async () => {
    mockTemplate.toolNames.push('write_todos')
    let calls = 0
    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      promptAiSdkStream: async function* ({ messages }) {
        calls++
        if (calls === 4) {
          expect(JSON.stringify(messages)).toContain(TODO_LOOP_RECOVERY_MESSAGE)
          yield createToolCallChunk('read_files', { paths: ['src/example.ts'] })
        } else if (calls === 7) {
          yield createToolCallChunk('end_turn', {})
        } else {
          yield createToolCallChunk('write_todos', {
            todos: [{ task: 'x', completed: false }],
          })
        }
        return promptSuccess(`recovery-${calls}`)
      },
    })
    expect(calls).toBe(7)
    expect(result.output.type).not.toBe('error')
    expect(
      JSON.stringify(result.agentState.messageHistory).split(
        TODO_LOOP_RECOVERY_MESSAGE,
      ),
    ).toHaveLength(2)
  })

  it('does not interrupt changing to-do lists or completion updates', async () => {
    mockTemplate.toolNames.push('write_todos')
    let calls = 0
    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      promptAiSdkStream: async function* () {
        calls++
        if (calls === 9) {
          yield createToolCallChunk('end_turn', {})
        } else {
          yield createToolCallChunk('write_todos', {
            todos: [
              {
                task: calls <= 4 ? 'Read code' : 'Run tests',
                completed: calls % 4 > 2 || calls % 4 === 0,
              },
            ],
          })
        }
        return promptSuccess(`progress-${calls}`)
      },
    })
    expect(calls).toBe(9)
    expect(result.output.type).not.toBe('error')
    expect(JSON.stringify(result.agentState.messageHistory)).not.toContain(
      TODO_LOOP_RECOVERY_MESSAGE,
    )
  })

  describe('followup cards with unfinished to-dos', () => {
    const followups = () =>
      createToolCallChunk('suggest_followups', {
        followups: [
          { prompt: 'Continue with the next step', label: 'Continue' },
        ],
      })
    const list = (doneCount: number, total = 3) =>
      createToolCallChunk('write_todos', {
        todos: Array.from({ length: total }, (_, i) => ({
          task: `Step ${i + 1}`,
          completed: i < doneCount,
        })),
      })
    const nudges = (state: AgentState) =>
      state.messageHistory.filter((m) =>
        m.tags?.includes(FOLLOWUP_TODO_NUDGE_TAG),
      ).length

    beforeEach(() => {
      mockTemplate.toolNames.push('write_todos', 'suggest_followups')
    })

    it('continues a turn that stopped mid-list, then ends with cards once the list is done', async () => {
      let calls = 0
      const seenPrompts: string[] = []
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        promptAiSdkStream: async function* ({ messages }) {
          calls++
          seenPrompts.push(JSON.stringify(messages))
          if (calls === 1) {
            yield list(1)
          } else if (calls === 2) {
            // The reported behaviour: step 1 of 3 done, then stop on cards.
            yield { type: 'text', text: 'Step 1 is done.' }
            yield followups()
          } else if (calls === 3) {
            yield list(3)
          } else {
            yield { type: 'text', text: 'All three steps are done.' }
            yield followups()
          }
          return promptSuccess(`followups-${calls}`)
        },
      })

      expect(calls).toBe(4)
      expect(result.output.type).not.toBe('error')
      expect(seenPrompts[1]).not.toContain('to-do list still has')
      expect(seenPrompts[2]).toContain(
        JSON.stringify(
          'to-do list still has 2 unfinished items: "Step 2", "Step 3"',
        ).slice(1, -1),
      )
      expect(nudges(result.agentState)).toBe(1)
    })

    it('ends on cards when every to-do is done', async () => {
      let calls = 0
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        promptAiSdkStream: async function* () {
          yield ++calls === 1 ? list(3) : followups()
          return promptSuccess(`done-${calls}`)
        },
      })
      expect(calls).toBe(2)
      expect(nudges(result.agentState)).toBe(0)
    })

    it('lets the model stop after one nudge when it makes no progress', async () => {
      let calls = 0
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        promptAiSdkStream: async function* () {
          if (++calls === 1) {
            yield list(1)
          } else {
            yield {
              type: 'text',
              text: 'I need you to install git before I can continue.',
            }
            yield followups()
          }
          return promptSuccess(`blocked-${calls}`)
        },
      })
      expect(calls).toBe(3)
      expect(nudges(result.agentState)).toBe(1)
    })

    it(`stops nudging after ${MAX_FOLLOWUP_TODO_NUDGES} times in one prompt`, async () => {
      mockAgentState.stepsRemaining = 50
      let calls = 0
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        promptAiSdkStream: async function* () {
          calls++
          // Progress every cycle (one more item, one more done) but never the
          // whole list.
          yield calls % 2 === 1
            ? list((calls + 1) / 2, (calls + 1) / 2 + 1)
            : followups()
          return promptSuccess(`cap-${calls}`)
        },
      })
      expect(nudges(result.agentState)).toBe(MAX_FOLLOWUP_TODO_NUDGES)
      expect(calls).toBe(2 * (MAX_FOLLOWUP_TODO_NUDGES + 1))
    })

    it('ignores a part-done list from an earlier prompt', async () => {
      mockAgentState.messageHistory = [
        userMessage({ content: 'Build it', tags: ['USER_PROMPT'] }),
        assistantMessage({
          type: 'tool-call',
          toolCallId: 'old',
          toolName: 'write_todos',
          input: {
            todos: [
              { task: 'Step 1', completed: true },
              { task: 'Step 2', completed: false },
            ],
          },
        }),
        {
          role: 'tool',
          toolCallId: 'old',
          toolName: 'write_todos',
          content: [],
        },
      ]
      let calls = 0
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        prompt: 'What does this file do?',
        promptAiSdkStream: async function* () {
          calls++
          yield { type: 'text', text: 'It parses the config.' }
          yield followups()
          return promptSuccess(`question-${calls}`)
        },
      })
      expect(calls).toBe(1)
      expect(nudges(result.agentState)).toBe(0)
    })
  })

  describe('to-do progress reminders', () => {
    const list = (doneCount: number, total = 4) =>
      createToolCallChunk('write_todos', {
        todos: Array.from({ length: total }, (_, i) => ({
          task: `Step ${i + 1}`,
          completed: i < doneCount,
        })),
      })
    const read = () => createToolCallChunk('read_files', { paths: ['src/example.ts'] })
    // History carries every reminder given so far, so each prompt shows the running count.
    const reminders = (prompt: string) =>
      prompt.split('since you last updated it').length - 1

    it('reminds a model that works through its list without ticking items off, once per list', async () => {
      mockTemplate.toolNames.push('write_todos')
      mockAgentState.stepsRemaining = 200
      // 0/4 then five reads; ticks 1/4 then five reads; then ignores the second reminder
      const script = [
        list(0), read(), read(), read(), read(), read(),
        list(1), read(), read(), read(), read(), read(),
        read(), read(), read(), read(), read(), read(),
      ]
      const seen: string[] = []
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        promptAiSdkStream: async function* ({ messages }) {
          seen.push(JSON.stringify(messages))
          yield script[seen.length - 1] ?? createToolCallChunk('end_turn', {})
          return promptSuccess(`progress-${seen.length}`)
        },
      })
      expect(result.output.type).not.toBe('error')
      expect(seen).toHaveLength(script.length + 1)
      // Not before the fifth untouched call; right after it, with the real count.
      expect(reminders(seen[5]!)).toBe(0)
      expect(reminders(seen[6]!)).toBe(1)
      expect(seen[6]).toContain('0 of 4 done')
      // Ticking an item re-arms it, five calls later.
      expect(reminders(seen[11]!)).toBe(1)
      expect(reminders(seen[12]!)).toBe(2)
      expect(seen[12]).toContain('1 of 4 done')
      // Ignored: never repeated for the same list.
      expect(reminders(seen.at(-1)!)).toBe(2)
      expect(
        result.agentState.messageHistory.filter((m) =>
          m.tags?.includes(TODO_PROGRESS_REMINDER_TAG),
        ),
      ).toHaveLength(2)
    })
  })

  describe('unchanged write_todos results', () => {
    const todoResults = (state: AgentState): string[] =>
      state.messageHistory.flatMap((m) =>
        m.role === 'tool' && m.toolName === 'write_todos'
          ? m.content.map((part) =>
              part.type === 'json'
                ? String((part.value as { message: unknown }).message)
                : '',
            )
          : [],
      )

    it('answers a repeated list as a no-op from the first repeat', async () => {
      mockTemplate.toolNames.push('write_todos')
      let calls = 0
      const seenPrompts: string[] = []
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        promptAiSdkStream: async function* ({ messages }) {
          calls++
          seenPrompts.push(JSON.stringify(messages))
          if (calls === 3) {
            yield createToolCallChunk('end_turn', {})
          } else {
            yield createToolCallChunk('write_todos', {
              todos: [{ task: 'Write the script', completed: false }],
            })
          }
          return promptSuccess(`unchanged-${calls}`)
        },
      })

      expect(calls).toBe(3)
      expect(result.output.type).not.toBe('error')
      expect(todoResults(result.agentState)).toEqual([
        'Todos written',
        WRITE_TODOS_UNCHANGED_MESSAGE,
      ])
      // The model sees it on the very next step, well before the streak
      // detector's recovery guidance at the third identical call.
      expect(seenPrompts[2]).toContain(WRITE_TODOS_UNCHANGED_MESSAGE)
      expect(seenPrompts[2]).not.toContain(TODO_LOOP_RECOVERY_MESSAGE)
    })

    it('never flags a list whose status or tasks changed', async () => {
      mockTemplate.toolNames.push('write_todos')
      const lists = [
        [
          { task: 'Read code', completed: false },
          { task: 'Write fix', completed: false },
        ],
        [
          { task: 'Read code', completed: true },
          { task: 'Write fix', completed: false },
        ],
        [
          { task: 'Read code', completed: true },
          { task: 'Write fix', completed: true },
        ],
        [
          { task: 'Read code', completed: true },
          { task: 'Write fix', completed: true },
          { task: 'Run tests', completed: false },
        ],
      ]
      let calls = 0
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        promptAiSdkStream: async function* () {
          const todos = lists[calls++]
          yield todos
            ? createToolCallChunk('write_todos', { todos })
            : createToolCallChunk('end_turn', {})
          return promptSuccess(`progress-${calls}`)
        },
      })

      expect(result.output.type).not.toBe('error')
      expect(todoResults(result.agentState)).toEqual(
        lists.map(() => 'Todos written'),
      )
    })

    it('flags a list re-sent unchanged at the start of the next turn', async () => {
      mockTemplate.toolNames.push('write_todos')
      const todos = [{ task: 'Write the script', completed: false }]
      const first = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        promptAiSdkStream: async function* () {
          yield createToolCallChunk('write_todos', { todos })
          yield createToolCallChunk('end_turn', {})
          return promptSuccess('turn-1')
        },
      })
      const second = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentState: first.agentState,
        prompt: 'continue',
        promptAiSdkStream: async function* () {
          yield createToolCallChunk('write_todos', { todos })
          yield createToolCallChunk('end_turn', {})
          return promptSuccess('turn-2')
        },
      })

      expect(todoResults(second.agentState)).toEqual([
        'Todos written',
        WRITE_TODOS_UNCHANGED_MESSAGE,
      ])
    })

    it('tells a model without file-editing tools not to substitute write_todos', async () => {
      // Desktop plan mode withholds the write tools. A model that meant to
      // call write_file kept emitting write_todos instead.
      mockTemplate.toolNames = ['read_files', 'write_todos', 'end_turn']
      mockAgentState.stepsRemaining = 200
      let calls = 0
      const seenPrompts: string[] = []
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        promptAiSdkStream: async function* ({ messages }) {
          calls++
          seenPrompts.push(JSON.stringify(messages))
          yield {
            type: 'text',
            text: 'Writing the script with write_file now:',
          }
          yield createToolCallChunk('write_todos', {
            todos: [{ task: 'Write the QC script', completed: false }],
          })
          return promptSuccess(`plan-${calls}`)
        },
      })

      expect(calls).toBe(6)
      expect(result.output).toMatchObject({
        type: 'error',
        message: TODO_LOOP_STOP_MESSAGE,
      })
      expect(todoResults(result.agentState).slice(1)).toEqual(
        Array(5).fill(
          `${WRITE_TODOS_UNCHANGED_MESSAGE} ${FILE_EDIT_TOOLS_UNAVAILABLE_NOTE}`,
        ),
      )
      expect(seenPrompts[3]).toContain(
        JSON.stringify(
          `${TODO_LOOP_RECOVERY_MESSAGE} ${FILE_EDIT_TOOLS_UNAVAILABLE_NOTE}`,
        ).slice(1, -1),
      )
    })
  })

  it('retains completed steps after a spending cap and resumes under a new run id', async () => {
    mockTemplate.handleSteps = function* () {
      yield 'STEP'
      yield 'STEP'
    }
    let calls = 0
    const capped = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      startAgentRun: async () => 'capped-run',
      promptAiSdkStream: async function* () {
        if (++calls === 2) {
          throw new APICallError({
            statusCode: 429,
            message: FREEBUFF_TURN_SPEND_LIMIT_MESSAGE,
            url: 'http://localhost/api/v1/chat/completions',
            requestBodyValues: {},
            responseBody: JSON.stringify({
              error: 'turn_spend_limit',
              message: FREEBUFF_TURN_SPEND_LIMIT_MESSAGE,
            }),
            isRetryable: false,
          })
        }
        yield { type: 'text' as const, text: 'Completed research: result 42.' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('completed-step')
      },
    })
    expect(calls).toBe(2)
    expect(capped.output).toMatchObject({
      type: 'error',
      error: 'turn_spend_limit',
    })
    expect(JSON.stringify(capped.agentState.messageHistory)).toContain(
      'Completed research: result 42.',
    )
    expect(capped.agentState.runId).toBe('capped-run')

    const resumed = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentState: capped.agentState,
      prompt: 'Continue',
      startAgentRun: async () => 'fresh-run',
    })
    expect(resumed.output.type).not.toBe('error')
    expect(resumed.agentState.runId).toBe('fresh-run')
    const history = JSON.stringify(resumed.agentState.messageHistory)
    expect(history).toContain('Completed research: result 42.')
    expect(history).toContain('Continue')
  })

  it('an abort during agent-run registration is a cancel, not a failed run', async () => {
    // registration ends on the run's signal now, so the null it returns under an abort is the
    // abort itself and must read like every other cancel
    const controller = new AbortController()
    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      signal: controller.signal,
      startAgentRun: async () => {
        controller.abort()
        return null
      },
    })
    expect(result.output).toEqual({
      type: 'error',
      message: 'Run cancelled by user',
    })
    expect(llmCallCount).toBe(0)
  })

  it('skips run tracking for the context-pruner by name, not by substring', async () => {
    mockTemplate.handleSteps = function* () {
      yield 'STEP'
    }
    const runIdFor = async (id: string) => {
      const template = { ...mockTemplate, id }
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: id,
        agentTemplate: template,
        localAgentTemplates: { [id]: template },
        agentState: { ...mockAgentState, messageHistory: [] },
        startAgentRun: async () => 'ledger-run',
      })
      return result.agentState.runId
    }

    expect(await runIdFor('context-pruner')).toStartWith('untracked-')
    expect(await runIdFor('codebuff/context-pruner@1.0.0')).toStartWith(
      'untracked-',
    )
    // The web API refuses untracked ids, so a model-calling agent whose id
    // merely contains the name must keep its ledger run.
    expect(await runIdFor('context-pruner-test-agent')).toBe('ledger-run')
  })

  it('should verify correct STEP behavior - LLM called once after STEP', async () => {
    // This test verifies that when a programmatic agent yields STEP,
    // the LLM should be called once in the next iteration

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      // Execute a tool, then STEP
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield 'STEP' // Should pause here and let LLM run
      // Continue after LLM runs (this won't be reached in this test since LLM ends turn)
      yield {
        toolName: 'write_file',
        input: { path: 'output.txt', content: 'test' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    console.log(`LLM calls made: ${llmCallCount}`)
    console.log(`Step count: ${stepCount}`)

    // CORRECT BEHAVIOR: After STEP, LLM should be called once
    // The programmatic agent yields STEP, then LLM runs once and ends turn
    expect(llmCallCount).toBe(1) // LLM called once after STEP

    // The programmatic agent should have been called once (yielded STEP)
    expect(stepCount).toBe(1)
  })

  it('should demonstrate correct behavior when programmatic agent completes without STEP', async () => {
    // This test shows that when a programmatic agent doesn't yield STEP,
    // it should complete without calling the LLM at all (since it ends with end_turn)

    const mockGeneratorFunction = function* () {
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield {
        toolName: 'write_file',
        input: { path: 'output.txt', content: 'test' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should NOT call LLM since the programmatic agent ended with end_turn
    expect(llmCallCount).toBe(0)
    // The result should have agentState
    expect(result.agentState).toBeDefined()
  })

  it('should run programmatic step first, then LLM step, then continue', async () => {
    // This test verifies the correct execution order in loopAgentSteps:
    // 1. Programmatic step runs first and yields STEP
    // 2. LLM step runs once
    // 3. Loop continues but generator is complete after first STEP

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      // First execution: do some work, then STEP
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield 'STEP' // Hand control to LLM
      // After LLM runs, continue (this happens in the same generator instance)
      yield {
        toolName: 'write_file',
        input: { path: 'output.txt', content: 'updated by LLM' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify execution order:
    // 1. Programmatic step function was called once (creates generator)
    // 2. LLM was called once after STEP
    // 3. Generator continued after LLM step
    expect(stepCount).toBe(1) // Generator function called once
    expect(llmCallCount).toBe(1) // LLM called once after first STEP
    expect(result.agentState).toBeDefined()
  })

  it('should handle programmatic agent that yields STEP_ALL', async () => {
    // Test STEP_ALL behavior - should run LLM then continue with programmatic step

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield 'STEP_ALL' // Hand all remaining control to LLM
      // Should continue after LLM completes all its steps
      yield {
        toolName: 'write_file',
        input: { path: 'final.txt', content: 'done' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(stepCount).toBe(1) // Generator function called once
    expect(llmCallCount).toBe(1) // LLM should be called once
    expect(result.agentState).toBeDefined()
  })

  it('should not call LLM when programmatic agent returns without STEP', async () => {
    // Test that programmatic agents that don't yield STEP don't trigger LLM

    const mockGeneratorFunction = function* () {
      yield { toolName: 'read_files', input: { paths: ['test.txt'] } }
      yield {
        toolName: 'write_file',
        input: { path: 'result.txt', content: 'processed' },
      }
      // No STEP - agent completes without LLM involvement
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(llmCallCount).toBe(0) // No LLM calls should be made
    expect(result.agentState).toBeDefined()
  })

  it('should handle LLM-only agent (no handleSteps)', async () => {
    // Test traditional LLM-based agents that don't have handleSteps

    const llmOnlyTemplate = {
      ...mockTemplate,
      handleSteps: undefined, // No programmatic step function
    }

    const localAgentTemplates = {
      'test-agent': llmOnlyTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(llmCallCount).toBe(1) // LLM should be called once
    expect(result.agentState).toBeDefined()
  })

  it('offers spawnable agents as tools only to an agent with spawn_agents', async () => {
    const toolsOffered: string[][] = []
    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({ tools }) {
      toolsOffered.push(Object.keys(tools ?? {}))
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    }
    const helper = { ...mockTemplate, id: 'helper', spawnerPrompt: 'Helps' }
    const toolNameSets: AgentTemplate['toolNames'][] = [
      ['end_turn'],
      ['spawn_agents', 'end_turn'],
    ]

    for (const toolNames of toolNameSets) {
      await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        localAgentTemplates: {
          'test-agent': {
            ...mockTemplate,
            toolNames,
            spawnableAgents: ['helper'],
          },
          helper,
        },
      })
    }

    expect(toolsOffered).toEqual([
      ['end_turn'],
      ['spawn_agents', 'end_turn', 'helper'],
    ])
  })

  it('should pass the full message history to the traceWriter when provided', async () => {
    const recordedSteps: Array<{ agentId: string; messages: unknown[] }> = []
    const traceWriter = {
      recordStep: (params: { agentId: string; messages: unknown[] }) => {
        recordedSteps.push(params)
      },
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      traceWriter,
      agentType: 'test-agent',
      localAgentTemplates: {
        'test-agent': { ...mockTemplate, handleSteps: undefined },
      },
    })

    expect(result.agentState).toBeDefined()
    // Called at least at the start and end of the step
    expect(recordedSteps.length).toBeGreaterThanOrEqual(2)
    expect(recordedSteps[0]!.agentId).toBe('test-agent-id')
    // End-of-step call sees the assistant response appended to the history
    const lastMessages = recordedSteps[recordedSteps.length - 1]!.messages
    expect(lastMessages.length).toBeGreaterThan(
      recordedSteps[0]!.messages.length,
    )
  })

  it('should handle programmatic agent error and still call LLM', async () => {
    // Test error handling in programmatic step - should still allow LLM to run

    const mockGeneratorFunction = function* () {
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      throw new Error('Programmatic step failed')
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // After programmatic step error, should end turn and not call LLM
    expect(llmCallCount).toBe(0)
    expect(result.agentState).toBeDefined()
    expect(result.agentState.output?.error).toContain(
      'Error executing handleSteps for agent test-agent',
    )
  })

  it('should handle mixed execution with multiple STEP yields', async () => {
    // Test complex scenario with multiple STEP yields and LLM interactions
    // Note: In current implementation, LLM typically ends turn after running,
    // so this tests the first STEP interaction

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      yield { toolName: 'read_files', input: { paths: ['input.txt'] } }
      yield 'STEP' // First LLM interaction
      yield {
        toolName: 'write_file',
        input: { path: 'temp.txt', content: 'intermediate' },
      }
      yield {
        toolName: 'write_file',
        input: { path: 'final.txt', content: 'complete' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(stepCount).toBe(1) // Generator function called once
    expect(llmCallCount).toBe(1) // LLM called once after STEP
    expect(result.agentState).toBeDefined()
  })

  it('should pass shouldEndTurn: true as stepsComplete when end_turn tool is called', async () => {
    // Test that when LLM calls end_turn, shouldEndTurn (stepsComplete) is correctly passed
    // to the handleSteps generator via the step result.
    //
    // Flow:
    // 1. Generator yields 'STEP', runProgrammaticStep returns
    // 2. loopAgentSteps calls runAgentStep (LLM), which calls end_turn -> shouldEndTurn = true
    // 3. loopAgentSteps calls runProgrammaticStep again with stepsComplete: true
    // 4. Generator resumes from yield 'STEP' and receives { stepsComplete: true }

    let stepsCompleteValues: boolean[] = []

    const mockGeneratorFunction = function* () {
      // First STEP - after LLM runs and calls end_turn, we receive stepsComplete: true
      const result1 = yield 'STEP'
      stepsCompleteValues.push(result1.stepsComplete)

      // Since stepsComplete was true, we should end gracefully
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify that stepsComplete was passed correctly:
    // After yielding STEP and LLM running (which calls end_turn),
    // the generator receives stepsComplete: true
    expect(stepsCompleteValues).toHaveLength(1)
    expect(stepsCompleteValues[0]).toBe(true)
  })

  it('should continue loop when handleSteps returns endTurn: false even if LLM calls end_turn', async () => {
    // Test that handleSteps endTurn: false takes precedence over LLM end_turn tool call

    let programmaticStepCount = 0
    let llmStepCount = 0

    const mockGeneratorFunction = function* () {
      // First iteration: return endTurn: false
      programmaticStepCount++
      yield 'STEP'

      // Second iteration: also return endTurn: false
      programmaticStepCount++
      yield 'STEP'

      // Third iteration: finally return endTurn: true to end the loop
      programmaticStepCount++
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    // Mock LLM to always call end_turn, but handleSteps should override it
    let promptCallCount = 0
    loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
      promptCallCount++
      llmStepCount++

      // LLM always tries to end turn
      yield { type: 'text' as const, text: 'LLM response\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess(`mock-message-id-${promptCallCount}`)
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify handleSteps ran 3 times (yielded STEP twice, then end_turn)
    expect(programmaticStepCount).toBe(3)

    // Verify LLM was called 2 times (once per STEP yield)
    expect(llmStepCount).toBe(2)

    // This confirms that even though LLM called end_turn every time,
    // the loop continued because handleSteps kept yielding STEP before finally ending
  })

  it('should restart loop when agent finishes without setting required output', async () => {
    // Test that when an agent has outputSchema but finishes without calling set_output,
    // the loop restarts with a system message

    const outputSchema = z.object({
      result: z.string(),
      status: z.string(),
    })

    const templateWithOutputSchema = {
      ...mockTemplate,
      outputSchema,
      toolNames: ['set_output', 'end_turn'], // Add set_output to available tools
      handleSteps: undefined, // LLM-only agent
    }

    const localAgentTemplates = {
      'test-agent': templateWithOutputSchema,
    }

    let llmCallNumber = 0
    const llmStepNumbers: string[] = []
    let capturedAgentState: AgentState | null = null

    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({
      extraCodebuffMetadata,
    }) {
      llmCallNumber++
      llmStepNumbers.push(extraCodebuffMetadata?.llm_step_number ?? '')
      if (llmCallNumber === 1) {
        // First call: agent tries to end turn without setting output
        yield {
          type: 'text' as const,
          text: 'First response without output\n\n',
        }
        yield createToolCallChunk('end_turn', {})
      } else if (llmCallNumber === 2) {
        // Second call: agent sets output after being reminded
        // Manually set the output to simulate the set_output tool execution
        if (capturedAgentState) {
          capturedAgentState.output = {
            result: 'test result',
            status: 'success',
          }
        }
        yield { type: 'text' as const, text: 'Setting output now\n\n' }
        yield createToolCallChunk('set_output', {
          result: 'test result',
          status: 'success',
        })
        yield { type: 'text' as const, text: '\n\n' }
        yield createToolCallChunk('end_turn', {})
      } else {
        // Safety: if called more than twice, just end
        yield { type: 'text' as const, text: 'Ending\n\n' }
        yield createToolCallChunk('end_turn', {})
      }
      return promptSuccess('mock-message-id')
    }

    mockAgentState.output = undefined
    capturedAgentState = mockAgentState

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should call LLM twice: once to try ending without output, once after reminder
    expect(llmCallNumber).toBe(2)
    expect(llmStepNumbers).toEqual(['1', '2'])

    // Should have output set after the second attempt
    expect(result.agentState.output).toEqual({
      result: 'test result',
      status: 'success',
    })

    // Check that a system message was added to message history
    const systemMessages = result.agentState.messageHistory.filter(
      (msg) =>
        msg.role === 'user' &&
        msg.content[0].type === 'text' &&
        msg.content[0].text.includes('set_output'),
    )
    expect(systemMessages.length).toBeGreaterThan(0)
  })

  it('should not restart loop if output is set correctly', async () => {
    // Test that when an agent has outputSchema and sets output correctly,
    // the loop ends normally without restarting

    const outputSchema = z.object({
      result: z.string(),
    })

    const templateWithOutputSchema = {
      ...mockTemplate,
      outputSchema,
      toolNames: ['set_output', 'end_turn'],
      handleSteps: undefined,
    }

    const localAgentTemplates = {
      'test-agent': templateWithOutputSchema,
    }

    let llmCallNumber = 0
    let capturedAgentState: AgentState | null = null

    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({}) {
      llmCallNumber++
      // Agent sets output correctly on first call
      if (capturedAgentState) {
        capturedAgentState.output = { result: 'success' }
      }
      yield { type: 'text' as const, text: 'Setting output\n\n' }
      yield createToolCallChunk('set_output', { result: 'success' })
      yield { type: 'text' as const, text: '\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    }

    mockAgentState.output = undefined
    capturedAgentState = mockAgentState

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should only call LLM once since output was set correctly
    expect(llmCallNumber).toBe(1)

    // Should have output set
    expect(result.agentState.output).toEqual({ result: 'success' })
  })

  it('should pass generateN from programmatic step to runAgentStep as n parameter', async () => {
    // Test that when programmatic step returns generateN, it's passed to runAgentStep

    let agentStepN: number | undefined

    const mockGeneratorFunction = function* () {
      // Yield GENERATE_N to trigger n parameter
      yield { type: 'GENERATE_N', n: 5 }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    // Mock promptAiSdk to capture the n parameter
    loopAgentStepsBaseParams.promptAiSdk = async (params: any) => {
      agentStepN = params.n
      return promptSuccess(
        JSON.stringify([
          'Response 1',
          'Response 2',
          'Response 3',
          'Response 4',
          'Response 5',
        ]),
      )
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify generateN was passed to runAgentStep as n
    expect(agentStepN).toBe(5)
  })

  it('should pass nResponses from runAgentStep back to programmatic step', async () => {
    // Test that nResponses returned by runAgentStep are passed to next programmatic step

    let receivedNResponses: string[] | undefined

    const mockGeneratorFunction = function* () {
      const { nResponses } = yield { type: 'GENERATE_N', n: 3 }
      receivedNResponses = nResponses
      const step = yield {
        toolName: 'read_files',
        input: { paths: ['test.txt'] },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const expectedResponses = [
      'Implementation A',
      'Implementation B',
      'Implementation C',
    ]
    loopAgentStepsBaseParams.promptAiSdk = async () => {
      return promptSuccess(JSON.stringify(expectedResponses))
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(receivedNResponses).toEqual(expectedResponses)
  })

  it('should allow agents without outputSchema to end normally', async () => {
    // Test that agents without outputSchema can end without setting output

    const templateWithoutOutputSchema = {
      ...mockTemplate,
      outputSchema: undefined,
      handleSteps: undefined,
    }

    const localAgentTemplates = {
      'test-agent': templateWithoutOutputSchema,
    }

    let llmCallNumber = 0
    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({}) {
      llmCallNumber++
      yield { type: 'text' as const, text: 'Response without output\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should only call LLM once and end normally
    expect(llmCallNumber).toBe(1)

    // Output should be undefined since no outputSchema required
    expect(result.agentState.output).toBeUndefined()
  })

  it('should continue loop if agent does not end turn (has more work)', async () => {
    // Test that validation only triggers when shouldEndTurn is true

    const outputSchema = z.object({
      result: z.string(),
    })

    const templateWithOutputSchema = {
      ...mockTemplate,
      outputSchema,
      toolNames: ['read_files', 'set_output', 'end_turn'],
      handleSteps: undefined,
    }

    const localAgentTemplates = {
      'test-agent': templateWithOutputSchema,
    }

    let llmCallNumber = 0
    let capturedAgentState: AgentState | null = null

    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({}) {
      llmCallNumber++
      if (llmCallNumber === 1) {
        // First call: agent does some work but doesn't end turn
        yield { type: 'text' as const, text: 'Doing work\n\n' }
        yield createToolCallChunk('read_files', { paths: ['test.txt'] })
      } else {
        // Second call: agent sets output and ends
        if (capturedAgentState) {
          capturedAgentState.output = { result: 'done' }
        }
        yield { type: 'text' as const, text: 'Finishing\n\n' }
        yield createToolCallChunk('set_output', { result: 'done' })
        yield { type: 'text' as const, text: '\n\n' }
        yield createToolCallChunk('end_turn', {})
      }
      return promptSuccess('mock-message-id')
    }

    mockAgentState.output = undefined
    capturedAgentState = mockAgentState

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should call LLM twice: once for work, once to set output and end
    expect(llmCallNumber).toBe(2)

    // Should have output set
    expect(result.agentState.output).toEqual({ result: 'done' })
  })

  describe('abort handling', () => {
    it('should handle AbortError and finish with cancelled status', async () => {
      // Test that when an AbortError is thrown (e.g., from a tool handler),
      // loopAgentSteps catches it, finishes with 'cancelled' status, and returns
      // an error output indicating the run was cancelled.

      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Track finishAgentRun calls
      let finishAgentRunStatus: string | undefined
      const mockFinishAgentRun = mock(async (params: { status: string }) => {
        finishAgentRunStatus = params.status
      })

      // Mock promptAiSdkStream to throw an AbortError (simulating user cancellation mid-stream)
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        // Yield some content first
        yield { type: 'text' as const, text: 'Starting work...\n' }
        // Then throw AbortError to simulate user cancellation
        throw new AbortError('User pressed Ctrl+C')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        finishAgentRun: mockFinishAgentRun,
      })

      // Verify the output indicates cancellation
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toBe('Run cancelled by user')
      }

      // Verify finishAgentRun was called with 'cancelled' status
      expect(mockFinishAgentRun).toHaveBeenCalled()
      expect(finishAgentRunStatus).toBe('cancelled')
    })

    it('should distinguish AbortError from other errors', async () => {
      // Test that non-abort errors are NOT treated as cancellations

      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Track finishAgentRun calls
      let finishAgentRunStatus: string | undefined
      const mockFinishAgentRun = mock(async (params: { status: string }) => {
        finishAgentRunStatus = params.status
      })

      // Mock promptAiSdkStream to throw a regular error (not AbortError)
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        yield { type: 'text' as const, text: 'Starting...\n' }
        throw new Error('Network connection failed')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        finishAgentRun: mockFinishAgentRun,
      })

      // Verify the output indicates an error (not cancellation)
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toContain('Network connection failed')
        expect(result.output.message).not.toBe('Run cancelled by user')
      }

      // Verify finishAgentRun was called with 'failed' status (not 'cancelled')
      expect(mockFinishAgentRun).toHaveBeenCalled()
      expect(finishAgentRunStatus).toBe('failed')
    })

    it('should handle signal.aborted before loop starts', async () => {
      // Test that if signal is already aborted when loopAgentSteps is called,
      // it returns immediately with a cancelled message

      const abortController = new AbortController()
      abortController.abort() // Abort immediately

      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        signal: abortController.signal,
      })

      // Verify the output indicates cancellation
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toBe('Run cancelled by user')
      }

      // LLM should not have been called since we aborted before starting
      expect(llmCallCount).toBe(0)
    })
  })

  describe('API error handling', () => {
    it('should propagate error code and server message from 403 APICallError responseBody', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Mock promptAiSdkStream to throw an APICallError with a 403 status
      // and a responseBody containing the server's structured error
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        throw new APICallError({
          statusCode: 403,
          message: 'Forbidden',
          url: 'https://api.codebuff.com/v1/chat/completions',
          requestBodyValues: {},
          responseBody: JSON.stringify({
            error: 'free_mode_unavailable',
            message: 'Free mode is not available in your country.',
            countryCode: 'US',
            countryBlockReason: 'anonymous_network',
            ipPrivacySignals: ['vpn', 'hosting'],
          }),
          isRetryable: false,
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        // Should use the server's message, NOT the generic "Forbidden"
        expect(result.output.message).toBe(
          'Free mode is not available in your country.',
        )
        // Should NOT have the 'Agent run error: ' prefix since message came from responseBody
        expect(result.output.message).not.toContain('Agent run error:')
        // Should propagate the error code so the CLI can match on it
        expect(result.output.error).toBe('free_mode_unavailable')
        // Should propagate the status code
        expect(result.output.statusCode).toBe(403)
        expect(result.output.countryCode).toBe('US')
        expect(result.output.countryBlockReason).toBe('anonymous_network')
        expect(result.output.ipPrivacySignals).toEqual(['vpn', 'hosting'])
      }
    })

    it('should prefix with "Agent run error:" when responseBody has no parseable message', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // APICallError with no responseBody
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        throw new APICallError({
          statusCode: 500,
          message: 'Internal Server Error',
          url: 'https://api.codebuff.com/v1/chat/completions',
          requestBodyValues: {},
          responseBody: undefined,
          isRetryable: true,
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        // Should have the prefix since there's no server message
        expect(result.output.message).toContain('Agent run error:')
        expect(result.output.message).toContain('Internal Server Error')
        // No error code since responseBody wasn't parseable
        expect(result.output.error).toBeUndefined()
      }
    })

    it('a session gate refusing a later step keeps every step that completed', async () => {
      // Hosts resume a free-mode turn that lost its session from this state
      // (Desktop checkpoints it; the CLI adopts it). If the refusal dropped the
      // steps before it, "continue" after a session ended would start over.
      const llmOnlyTemplate = { ...mockTemplate, handleSteps: undefined }
      let calls = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        calls++
        if (calls === 1) {
          yield { type: 'text' as const, text: 'Reading the schema first.\n\n' }
          yield createToolCallChunk('read_files', { paths: ['schema.sql'] })
          return promptSuccess('step-1')
        }
        throw new APICallError({
          statusCode: 428,
          message: 'Precondition Required',
          url: 'https://api.codebuff.com/v1/chat/completions',
          requestBodyValues: {},
          responseBody: JSON.stringify({
            error: 'waiting_room_required',
            message: 'Your free session has ended.',
          }),
          isRetryable: false,
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates: { 'test-agent': llmOnlyTemplate },
      })

      expect(calls).toBe(2)
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.error).toBe('waiting_room_required')
        expect(result.output.statusCode).toBe(428)
      }
      const history = JSON.stringify(result.agentState.messageHistory)
      expect(history).toContain('Reading the schema first.')
      expect(history).toContain('schema.sql')
      expect(
        result.agentState.messageHistory.some((m) => m.role === 'tool'),
      ).toBe(true)
      // the host's snapshots read the SAME object, so they see the step too
      expect(mockAgentState.messageHistory).toBe(
        result.agentState.messageHistory,
      )
    })

    it('should unwrap retry errors to propagate underlying 409 gate errors', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const apiError = new APICallError({
        statusCode: 409,
        message: 'Conflict',
        url: 'https://api.codebuff.com/v1/chat/completions',
        requestBodyValues: {},
        responseBody: JSON.stringify({
          error: 'session_superseded',
          message:
            'Another instance of freebuff has taken over this session. Only one instance per account is allowed.',
        }),
        isRetryable: true,
      })

      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        throw new RetryError({
          message: 'Failed after 4 attempts. Last error: Conflict',
          reason: 'maxRetriesExceeded',
          errors: [apiError],
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toBe(
          'Another instance of freebuff has taken over this session. Only one instance per account is allowed.',
        )
        expect(result.output.message).not.toContain('Agent run error:')
        expect(result.output.error).toBe('session_superseded')
        expect(result.output.statusCode).toBe(409)
      }
    })

    it('should explain fetch idle timeouts instead of showing the raw runtime message', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Bun aborts a fetch after 5 minutes without receiving bytes, throwing a
      // DOMException named TimeoutError with this exact message.
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        const timeoutError = new Error('The operation timed out.')
        timeoutError.name = 'TimeoutError'
        throw timeoutError
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toContain(
          'no data was received from the server for 5 minutes',
        )
        expect(result.output.message).not.toContain('Agent run error:')
        expect(result.output.message).not.toBe('The operation timed out.')
      }
    })

    it("reports a caller's deadline as a cancellation, not as the 5-minute idle timeout", async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // `AbortSignal.timeout` fires with a DOMException named TimeoutError —
      // the same name Bun's fetch idle timeout uses — and the stream rejects
      // with that reason.
      const controller = new AbortController()
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        const timeoutError = new Error('The operation timed out.')
        timeoutError.name = 'TimeoutError'
        controller.abort(timeoutError)
        throw timeoutError
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        signal: controller.signal,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toBe('Run cancelled by user')
        expect(result.output.message).not.toContain('5 minutes')
      }
    })

    it('should explain dropped socket connections instead of showing the raw runtime message', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Bun's fetch throws a plain Error with this message (and code
      // ECONNRESET/ConnectionClosed) when the TCP connection is dropped.
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        const socketError = new Error(
          'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
        ) as Error & { code: string }
        socketError.code = 'ECONNRESET'
        throw socketError
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toContain('Connection interrupted')
        expect(result.output.message).not.toContain('Agent run error:')
        expect(result.output.message).not.toContain(
          'pass `verbose: true` in the second argument to fetch()',
        )
      }
    })
  })

  describe('steering (drainSteeringMessages)', () => {
    it('awaits image-bearing steering and sends each message with its own images on the next model call', async () => {
      const images = [
        { type: 'image' as const, image: 'Zmlyc3Q=', mediaType: 'image/png' },
        { type: 'image' as const, image: 'c2Vjb25k', mediaType: 'image/jpeg' },
      ]
      const seen: unknown[][] = []
      let drained = false
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        drainSteeringMessages: async () => {
          await Promise.resolve()
          if (drained) return []
          drained = true
          return ['Text correction', { prompt: 'Compare both images', content: images }, { prompt: '', content: [images[1]] }]
        },
        promptAiSdkStream: async function* ({ messages }) {
          seen.push(structuredClone(messages))
          yield createToolCallChunk('end_turn', {})
          return promptSuccess(`step-${seen.length}`)
        },
      })
      const expected = [
        [{ type: 'text', text: frameSteeringText('Text correction') }],
        [{ type: 'text', text: frameSteeringText('Compare both images') }, ...images],
        [{ type: 'text', text: frameSteeringText('') }, images[1]],
      ]
      expect(seen).toHaveLength(2)
      for (const content of expected) {
        expect(seen[0]).not.toContainEqual(expect.objectContaining({ role: 'user', content }))
        expect(seen[1]).toContainEqual(expect.objectContaining({ role: 'user', content }))
        expect(result.agentState.messageHistory).toContainEqual(expect.objectContaining({
          role: 'user', content, tags: ['USER_PROMPT'], keepDuringTruncation: true,
        }))
      }
    })

    it('appends a steering message at the step boundary and continues the turn', async () => {
      // The mock LLM ends the turn after one step. A steering message that arrives
      // during that step should be appended to history and keep the turn going, so
      // the agent runs a second step that can see (and act on) the new message.
      const steerText = 'Also rename the variable to fooBar'
      let drainCalls = 0
      const drainSteeringMessages = () => {
        drainCalls++
        return drainCalls === 1 ? [steerText] : []
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        drainSteeringMessages,
      })

      // Step 1 wanted to end the turn, but the steer kept it going → a 2nd step ran.
      expect(llmCallCount).toBe(2)

      // The steered text landed in history as a user message.
      const steered = result.agentState.messageHistory.find(
        (m) =>
          m.role === 'user' && JSON.stringify(m.content).includes(steerText),
      )
      expect(steered).toBeDefined()
      expect((steered as { tags?: string[] }).tags).toContain('USER_PROMPT')
    })

    it('frames a steered message exactly once, as sent mid-turn, so the earlier request is kept', async () => {
      const steerText = 'also add a README'
      const seen: unknown[][] = []
      let drained = false
      await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        prompt: 'build the login page',
        drainSteeringMessages: () => {
          if (drained) return []
          drained = true
          // The second is already framed (a host re-delivering it): not re-wrapped.
          return [steerText, frameSteeringText('and a footer')]
        },
        promptAiSdkStream: async function* ({ messages }) {
          seen.push(structuredClone(messages))
          yield createToolCallChunk('end_turn', {})
          return promptSuccess(`step-${seen.length}`)
        },
      })

      expect(seen).toHaveLength(2)
      const request = JSON.stringify(seen[1])
      // The original request is still there, unframed.
      expect(request).toContain('build the login page')
      expect(request).not.toContain(
        JSON.stringify(frameSteeringText('build the login page')).slice(1, -1),
      )
      for (const text of [steerText, 'and a footer']) {
        expect(seen[1]).toContainEqual(
          expect.objectContaining({
            role: 'user',
            content: [{ type: 'text', text: frameSteeringText(text) }],
          }),
        )
      }
      // One note per steered message, never a nested frame.
      expect(request.split(STEERING_NOTE).length - 1).toBe(2)
      expect(request.split('<user_message_sent_while_working>').length - 1).toBe(2)
    })

    it('does not extend the turn when no steering messages arrive', async () => {
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        drainSteeringMessages: () => [],
      })

      // No steer → the agent ends the turn after its single step, as usual.
      expect(llmCallCount).toBe(1)
      expect(result.agentState).toBeDefined()
    })
  })

  describe('stream interruptions', () => {
    it('retries after a stream interruption and completes the turn', async () => {
      let callCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        callCount++
        if (callCount === 1) {
          // A stream cut mid-response: partial text, then the interruption
          // chunk promptAiSdkStream yields when no finish marker arrived.
          yield { type: 'text' as const, text: 'partial answer that got cut ' }
          yield {
            type: 'error' as const,
            source: 'stream-interrupted' as const,
            message: 'The connection dropped while the response was streaming.',
          }
          return promptSuccess('interrupted-message-id')
        }
        yield { type: 'text' as const, text: 'complete answer' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('complete-message-id')
      }

      const result = await loopAgentSteps(loopAgentStepsBaseParams)

      // The interruption forced a second step (the retry), which completed.
      expect(callCount).toBe(2)
      expect(result.output?.type).not.toBe('error')

      const notes = result.agentState.messageHistory.filter(
        (m) => m.role === 'user' && m.tags?.includes(STREAM_INTERRUPTED_TAG),
      )
      expect(notes).toHaveLength(1)
    })

    it('gives up with a clear error when every attempt is interrupted', async () => {
      let callCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        callCount++
        yield {
          type: 'error' as const,
          source: 'stream-interrupted' as const,
          message: 'The connection dropped while the response was streaming.',
        }
        return promptSuccess(`interrupted-${callCount}`)
      }

      const result = await loopAgentSteps(loopAgentStepsBaseParams)

      expect(result.output?.type).toBe('error')
      expect((result.output as { message?: string }).message).toContain(
        REPEATED_STREAM_INTERRUPTIONS_MESSAGE,
      )
      // The retried interruptions, plus the final attempt that trips the cap
      // instead of retrying forever (well under maxAgentSteps).
      expect(callCount).toBe(MAX_CONSECUTIVE_STREAM_RECOVERIES + 1)
    })

    it('retries after an output-limit thinking overrun and completes the turn', async () => {
      let callCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        callCount++
        if (callCount === 1) {
          // The model burned its output budget on reasoning: only reasoning
          // chunks, then the output-limit chunk promptAiSdkStream yields for
          // a 'length' finish with no content or tool calls.
          yield { type: 'reasoning' as const, text: 'thinking forever ' }
          yield {
            type: 'error' as const,
            source: 'output-limit' as const,
            message: 'The response hit its output token limit while reasoning.',
          }
          return promptSuccess('limited-message-id')
        }
        yield { type: 'text' as const, text: 'concise answer' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('complete-message-id')
      }

      const result = await loopAgentSteps(loopAgentStepsBaseParams)

      expect(callCount).toBe(2)
      expect(result.output?.type).not.toBe('error')

      const notes = result.agentState.messageHistory.filter(
        (m) => m.role === 'user' && m.tags?.includes(OUTPUT_LIMIT_TAG),
      )
      expect(notes).toHaveLength(1)
    })

    it('gives up with the output-limit message when every attempt overruns', async () => {
      let callCount = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        callCount++
        yield {
          type: 'error' as const,
          source: 'output-limit' as const,
          message: 'The response hit its output token limit while reasoning.',
        }
        return promptSuccess(`limited-${callCount}`)
      }

      const result = await loopAgentSteps(loopAgentStepsBaseParams)

      expect(result.output?.type).toBe('error')
      expect((result.output as { message?: string }).message).toContain(
        REPEATED_OUTPUT_LIMIT_MESSAGE,
      )
      expect(callCount).toBe(MAX_CONSECUTIVE_STREAM_RECOVERIES + 1)
    })
  })

  describe('provider usage as context size', () => {
    it('uses receipts without a host callback, replaces them each step, and persists across turns', async () => {
      mockTemplate.stepPrompt = ''
      mockTemplate.instructionsPrompt = ''
      mockTemplate.toolNames.push('write_todos')
      let calls = 0
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        promptAiSdkStream: async function* ({ onUsageReceived }) {
          calls++
          if (calls === 1) {
            yield createToolCallChunk('write_todos', {
              todos: [{ task: 'inspect', completed: false }],
            })
          } else {
            expect(mockAgentState.contextTokenCount).toBeGreaterThan(30_000)
            yield { type: 'text', text: 'done' }
          }
          onUsageReceived?.({
            inputTokens: calls === 1 ? 30_000 : 35_000,
            outputTokens: 100,
            totalTokens: 999_999,
            cachedInputTokens: 20_000,
          })
          return promptSuccess(`receipt-${calls}`)
        },
      })
      expect(calls).toBe(2)
      expect(result.agentState.contextTokenCount).toBe(35_100)

      const restored = JSON.parse(
        JSON.stringify(result.agentState),
      ) as AgentState
      await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentState: restored,
        prompt: 'One more thing',
        promptAiSdkStream: async function* () {
          expect(restored.contextTokenCount).toBeGreaterThan(35_100)
          expect(restored.contextTokenCount).toBeLessThan(35_200)
          yield { type: 'text', text: 'ok' }
          return promptSuccess('missing-usage')
        },
      })
      expect(restored.contextTokenCount).toBeGreaterThan(35_100)
    })

    it('compacts on reported usage even when local history is small, then resets the anchor', async () => {
      mockTemplate.stepPrompt = ''
      mockTemplate.instructionsPrompt = ''
      mockTemplate.compactContext = {
        maxContextLength: 16_384,
        cacheExpiryMs: null,
      }
      mockTemplate.toolNames.push('write_todos')
      mockAgentState.messageHistory.push(
        assistantMessage('prior finding '.repeat(1000)),
      )
      let calls = 0
      let compactions = 0
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        onCompaction: () => compactions++,
        promptAiSdkStream: async function* ({ onUsageReceived, messages }) {
          if (++calls === 1) {
            yield createToolCallChunk('write_todos', {
              todos: [{ task: 'inspect', completed: false }],
            })
            onUsageReceived?.({
              inputTokens: 15_000,
              outputTokens: 500,
              totalTokens: 15_500,
              cachedInputTokens: 0,
            })
          } else {
            expect(JSON.stringify(messages)).toContain('<conversation_summary>')
            expect(mockAgentState.contextTokenBaseline).toBeUndefined()
            yield { type: 'text', text: 'done' }
            onUsageReceived?.({
              inputTokens: 1000,
              outputTokens: 10,
              totalTokens: 1010,
              cachedInputTokens: 0,
            })
          }
          return promptSuccess('step')
        },
      })
      expect(result.output.type).not.toBe('error')
      expect(compactions).toBe(1)
      expect(calls).toBe(2)
      expect(result.agentState.contextTokenCount).toBe(1010)
    })
  })

  describe('the end-of-turn context recount', () => {
    // The cancel exit is where the recount earns its keep, and it is also the
    // only exit where the two behaviours are far apart enough to assert
    // cleanly. A turn that ends normally re-enters the loop once and re-runs
    // the in-loop estimate before breaking, so that estimate already covers the
    // answer; a turn that is cancelled leaves the loop from inside the step,
    // and the last estimate it took predates everything the model produced.
    const BIG_PARTIAL_ANSWER = 'here is what I found so far. '.repeat(2000)

    const contextTokensAfterCancelledTurn = async (agentState: AgentState) => {
      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentState,
        promptAiSdkStream: async function* () {
          yield { type: 'text' as const, text: BIG_PARTIAL_ANSWER }
          throw new AbortError('User pressed Ctrl+C')
        },
      })
      return result.agentState.contextTokenCount
    }

    const withHistory = (extra?: Partial<AgentState>): AgentState => ({
      ...mockAgentState,
      messageHistory: [...mockAgentState.messageHistory],
      contextTokenCount: 0,
      ...extra,
    })

    it('leaves the root counting the history the turn actually kept', async () => {
      // The host persists this number and shows it to the user between turns,
      // so it has to describe the history the NEXT message is sent on top of —
      // including the partial answer a cancelled turn preserves.
      const asRoot = await contextTokensAfterCancelledTurn(withHistory())
      expect(asRoot).toBeGreaterThan(10_000)
    })

    it('keeps partial subagent output in its cheap fallback estimate too', async () => {
      const asRoot = await contextTokensAfterCancelledTurn(withHistory())
      const asSubagent = await contextTokensAfterCancelledTurn(
        withHistory({ parentId: 'parent-agent-id' }),
      )
      expect(asRoot).toBeGreaterThan(10_000)
      expect(asSubagent).toBeGreaterThan(10_000)
    })
  })
})
