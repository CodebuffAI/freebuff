import { execSync } from 'child_process'
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'

import { runAgentStep } from '@codebuff/agent-runtime/run-agent-step'
import { assembleLocalAgentTemplates } from '@codebuff/agent-runtime/templates/agent-registry'
import {
  handleStepsLogChunkWs,
  requestFilesWs,
  requestMcpToolDataWs,
  requestOptionalFileWs,
  requestToolCallWs,
  sendActionWs,
  sendSubagentChunkWs,
} from '@codebuff/backend/client-wrapper'
import { getFileTokenScores } from '@codebuff/code-map/parse'
import { API_KEY_ENV_VAR, TEST_USER_ID } from '@codebuff/common/old-constants'
import { mockModule } from '@codebuff/common/testing/mock-modules'
import { generateCompactId } from '@codebuff/common/util/string'
import { handleToolCall } from '@codebuff/npm-app/tool-handlers'
import { getSystemInfo } from '@codebuff/npm-app/utils/system-info'
import { mock } from 'bun:test'
import { blue } from 'picocolors'

import { EVALS_AGENT_RUNTIME_IMPL } from './impl/agent-runtime'
import {
  getAllFilePaths,
  getProjectFileTree,
} from '../common/src/project-file-tree'

import type {
  SDKAssistantMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-code'
import type { ClientToolCall } from '@codebuff/common/tools/list'
import type { AgentRuntimeScopedDeps } from '@codebuff/common/types/contracts/agent-runtime'
import type { ToolMessage } from '@codebuff/common/types/messages/codebuff-message'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type {
  AgentState,
  AgentTemplateType,
  SessionState,
} from '@codebuff/common/types/session-state'
import type { ProjectFileContext } from '@codebuff/common/util/file'
import type { WebSocket } from 'ws'

const DEBUG_MODE = true

export type ToolResultBlockParam = Extract<
  SDKUserMessage['message']['content'][number],
  { type: 'tool_result' }
>
export type ToolUseBlock = Extract<
  SDKAssistantMessage['message']['content'][number],
  { type: 'tool_use' }
>

export type AgentStep = {
  response: string
  toolCalls: (ClientToolCall | ToolUseBlock)[]
  toolResults: (ToolMessage | ToolResultBlockParam)[]
}

function readMockFile(projectRoot: string, filePath: string): string | null {
  const fullPath = path.join(projectRoot, filePath)
  try {
    return fs.readFileSync(fullPath, 'utf-8')
  } catch (error) {
    return null
  }
}

let toolCalls: ClientToolCall[] = []
let toolResults: ToolMessage[] = []
export async function createFileReadingMock(projectRoot: string) {
  await mockModule('@codebuff/backend/websockets/websocket-action', () => ({
    requestFiles: ((params: { ws: WebSocket; filePaths: string[] }) => {
      const files: Record<string, string | null> = {}
      for (const filePath of params.filePaths) {
        files[filePath] = readMockFile(projectRoot, filePath)
      }
      return Promise.resolve(files)
    }) satisfies typeof requestFilesWs,
    requestToolCall: (async (params: {
      ws: WebSocket
      userInputId: string
      toolName: string
      input: Record<string, any>
    }): ReturnType<typeof requestToolCallWs> => {
      const { toolName, input } = params
      // Execute the tool call using existing tool handlers
      const toolCall = {
        toolCallId: generateCompactId(),
        toolName,
        input,
      }
      toolCalls.push(toolCall as ClientToolCall)
      try {
        const toolResult = await handleToolCall(toolCall as any)
        toolResults.push({
          role: 'tool',
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          content: toolResult.content,
        })

        // Send successful response back to backend
        return {
          output: toolResult.content,
        }
      } catch (error) {
        // Send error response back to backend
        const resultString =
          error instanceof Error ? error.message : String(error)
        const output = [
          {
            type: 'json',
            value: { errorMessage: resultString },
          },
        ] satisfies ToolResultOutput[]
        toolResults.push({
          role: 'tool',
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          content: output,
        })
        return { output }
      }
    }) satisfies typeof requestToolCallWs,
  }))
}

export async function getProjectFileContext(
  projectPath: string,
): Promise<ProjectFileContext> {
  const fileTree = await getProjectFileTree({
    projectRoot: projectPath,
    fs: fs.promises,
  })
  const allFilePaths = getAllFilePaths(fileTree)
  const knowledgeFilePaths = allFilePaths.filter((filePath) =>
    filePath.endsWith('knowledge.md'),
  )
  const knowledgeFiles: Record<string, string> = {}
  for (const filePath of knowledgeFilePaths) {
    const content = readMockFile(projectPath, filePath)
    if (content !== null) {
      knowledgeFiles[filePath] = content
    }
  }
  const fileTokenScores = (await getFileTokenScores(projectPath, allFilePaths))
    .tokenScores
  return {
    projectRoot: projectPath,
    cwd: projectPath,
    gitChanges: {
      status: '',
      diff: '',
      diffCached: '',
      lastCommitMessages: '',
    },
    changesSinceLastChat: {},
    systemInfo: getSystemInfo(),
    shellConfigFiles: {},
    knowledgeFiles,
    fileTokenScores,
    fileTree,
    agentTemplates: {},
    customToolDefinitions: {},
  }
}

export async function runAgentStepScaffolding(
  agentState: AgentState,
  fileContext: ProjectFileContext,
  prompt: string | undefined,
  sessionId: string,
  agentType: AgentTemplateType,
) {
  const mockWs = new EventEmitter() as WebSocket
  mockWs.send = mock()
  mockWs.close = mock()

  let fullResponse = ''
  const { agentTemplates: localAgentTemplates } = assembleLocalAgentTemplates({
    fileContext,
    logger: console,
  })

  const agentRuntimeScopedImpl: AgentRuntimeScopedDeps = {
    handleStepsLogChunk: (params) =>
      handleStepsLogChunkWs({ ...params, ws: mockWs }),
    requestToolCall: (params) => requestToolCallWs({ ...params, ws: mockWs }),
    requestMcpToolData: (params) =>
      requestMcpToolDataWs({ ...params, ws: mockWs }),
    requestFiles: (params) => requestFilesWs({ ...params, ws: mockWs }),
    requestOptionalFile: (params) =>
      requestOptionalFileWs({ ...params, ws: mockWs }),
    sendSubagentChunk: (params) =>
      sendSubagentChunkWs({ ...params, ws: mockWs }),
    sendAction: (params) => sendActionWs({ ...params, ws: mockWs }),
    apiKey: process.env[API_KEY_ENV_VAR] ?? '',
  }
  const result = await runAgentStep({
    ...EVALS_AGENT_RUNTIME_IMPL,
    ...agentRuntimeScopedImpl,

    additionalToolDefinitions: () => Promise.resolve({}),
    agentState,
    agentType,
    ancestorRunIds: [],
    clientSessionId: sessionId,
    fileContext,
    fingerprintId: 'test-fingerprint-id',
    localAgentTemplates,
    onResponseChunk: (chunk: string | PrintModeEvent) => {
      if (typeof chunk !== 'string') {
        return
      }
      if (DEBUG_MODE) {
        process.stdout.write(chunk)
      }
      fullResponse += chunk
    },
    prompt,
    repoId: undefined,
    repoUrl: undefined,
    runId: 'test-run-id',
    signal: new AbortController().signal,
    spawnParams: undefined,
    system: 'Test system prompt',
    tools: {},
    userId: TEST_USER_ID,
    userInputId: generateCompactId(),
  })

  return {
    ...result,
    fullResponse,
  }
}

export async function runToolCalls(toolCalls: ClientToolCall[]) {
  const toolResults: ToolMessage[] = []
  for (const toolCall of toolCalls) {
    const toolResult = await handleToolCall(toolCall)
    toolResults.push(toolResult)
  }
  return toolResults
}

export async function loopMainPrompt({
  sessionState,
  prompt,
  projectPath,
  maxIterations,
  stopCondition,
  agentType,
}: {
  sessionState: SessionState
  prompt: string
  projectPath: string
  maxIterations: number
  stopCondition?: (sessionState: AgentState) => boolean
  agentType: AgentTemplateType
}) {
  console.log(blue(prompt))

  const startTime = Date.now()
  const sessionId = 'test-session-id-' + generateCompactId()
  let currentAgentState = sessionState.mainAgentState
  let iterations = 1
  const steps: AgentStep[] = []

  for (; iterations < maxIterations; iterations++) {
    console.log('\nIteration', iterations)
    let {
      agentState: newAgentState,
      fullResponse,
      shouldEndTurn,
    } = await runAgentStepScaffolding(
      currentAgentState,
      sessionState.fileContext,
      iterations === 1 ? prompt : undefined,
      sessionId,
      agentType,
    )
    currentAgentState = newAgentState

    const stop = stopCondition && stopCondition(currentAgentState)
    if (stop) break

    steps.push({
      response: fullResponse,
      toolCalls,
      toolResults,
    })

    toolCalls = []
    toolResults = []

    if (shouldEndTurn) {
      break
    }
  }

  console.log('Main loop finished!')
  console.log('  - iterations', iterations)
  console.log(
    '  - took',
    ((Date.now() - startTime) / 1000).toFixed(2),
    'seconds',
  )

  return {
    agentState: currentAgentState,
    iterations: iterations - 1,
    steps,
    duration: Date.now() - startTime,
  }
}

export function extractErrorFiles(output: string): string[] {
  const lines = output.split('\n')
  return lines
    .filter((line) => line.includes(': error TS'))
    .map((line) => line.split('(')[0].trim())
}

export function resetRepoToCommit(projectPath: string, commit: string) {
  console.log(`Resetting repository at ${projectPath} to commit ${commit}...`)
  try {
    execSync(
      `cd ${projectPath} && git reset --hard ${commit} && git clean -fd`,
      {
        timeout: 30_000,
      },
    )
    console.log('Repository reset successful')
  } catch (error) {
    console.error('Error resetting repository:', error)
    throw error
  }
}

export default {
  createFileReadingMock,
  getProjectFileContext,
  runAgentStepScaffolding,
  runToolCalls,
  loopMainPrompt,
  extractErrorFiles,
  resetRepoToCommit,
}
