import { models } from '@codebuff/common/old-constants'
import { promptSuccess } from '@codebuff/common/util/error'
import { spyOn } from 'bun:test'
import z from 'zod/v4'

import { CodebuffClient } from '../../src/client'
import * as databaseModule from '../../src/impl/database'
import * as llmModule from '../../src/impl/llm'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type {
  PromptAiSdkFn,
  PromptAiSdkStreamFn,
  PromptAiSdkStructuredInput,
} from '@codebuff/common/types/contracts/llm'
import type { ParamsOf } from '@codebuff/common/types/function-params'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

export const E2E_MOCK_API_KEY = 'codebuff-e2e-mock'

const MOCK_USER = {
  id: 'e2e-user',
  email: 'e2e-user@codebuff.test',
  name: null,
  discord_id: null,
  referral_code: null,
  stripe_customer_id: null,
  banned: false,
  created_at: new Date('2024-01-01T00:00:00Z'),
} as const

function buildMockAgentTemplate(params: {
  publisherId: string
  agentId: string
  version?: string
}): AgentTemplate {
  const { publisherId, agentId, version } = params
  const id = `${publisherId}/${agentId}@${version ?? 'latest'}`

  return {
    id,
    displayName: `${agentId} (mock)`,
    model: models.openrouter_claude_sonnet_4_5,
    mcpServers: {},
    toolNames: [],
    spawnableAgents: [],
    systemPrompt: '',
    instructionsPrompt: 'You are a helpful assistant.',
    stepPrompt: '',
    inputSchema: {
      prompt: z.string().optional(),
      params: z.object({}).passthrough().optional(),
    },
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    outputMode: 'last_message',
  }
}

const MOCK_TOOL_NAMES = [
  'get_weather',
  'execute_sql',
  'fetch_api',
  'apply_patch',
] as const
type MockToolName = (typeof MOCK_TOOL_NAMES)[number]

function getMessageText(message: Message): string {
  if (!('content' in message)) {
    return ''
  }
  return message.content
    .map((part) => {
      if (
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof part.text === 'string'
      ) {
        return part.text
      }
      return ''
    })
    .join('')
}

function getLatestUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return getMessageText(messages[i])
    }
  }
  return ''
}

function getAllText(messages: Message[]): string {
  return messages.map(getMessageText).join('\n')
}

function extractLatestUserMessage(text: string): string | null {
  const matches = [
    ...text.matchAll(/<user_message>([\s\S]*?)<\/user_message>/g),
  ]
  if (matches.length === 0) {
    return null
  }
  return matches[matches.length - 1]?.[1] ?? null
}

function getPromptText(latestUserText: string, allText: string): string {
  return extractLatestUserMessage(allText) ?? latestUserText
}

function splitTextIntoChunks(text: string): string[] {
  if (!text) {
    return []
  }

  const targetChunks =
    text.length <= 1 ? 1 : text.length > 120 ? 4 : text.length > 60 ? 3 : 2
  if (targetChunks === 1) {
    return [text]
  }

  const chunkSize = Math.ceil(text.length / targetChunks)
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize))
  }
  return chunks
}

function extractQuotedText(text: string): string | null {
  const doubleQuoted = text.match(/"([^"]+)"/)
  if (doubleQuoted?.[1]) {
    return doubleQuoted[1]
  }
  const singleQuoted = text.match(/'([^']+)'/)
  if (singleQuoted?.[1]) {
    return singleQuoted[1]
  }
  return null
}

function extractCity(text: string): string | null {
  const knownCities = [
    'New York',
    'Atlantis',
    'London',
    'Tokyo',
    'Sydney',
    'Paris',
  ]
  for (const city of knownCities) {
    if (text.toLowerCase().includes(city.toLowerCase())) {
      return city
    }
  }
  const match = text.match(/weather in ([A-Za-z\s]+)[?.!]?/i)
  if (match?.[1]) {
    return match[1].trim()
  }
  return null
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/)
  if (match?.[0]) {
    return match[0].replace(/[)\\].,]+$/, '')
  }
  return null
}

function buildMockToolCall(params: {
  tools: Record<string, unknown> | undefined
  latestUserText: string
  hasToolResult: boolean
}): { toolName: MockToolName; input: Record<string, unknown> } | null {
  const { tools, latestUserText, hasToolResult } = params
  if (hasToolResult || !tools) {
    return null
  }

  const availableTools = new Set(Object.keys(tools))
  const lowerPrompt = latestUserText.toLowerCase()

  if (availableTools.has('get_weather') && lowerPrompt.includes('weather')) {
    const city = extractCity(latestUserText) ?? 'New York'
    return { toolName: 'get_weather', input: { city } }
  }

  if (
    availableTools.has('execute_sql') &&
    (lowerPrompt.includes('database') || lowerPrompt.includes('sql'))
  ) {
    const query = lowerPrompt.includes('id 1')
      ? 'SELECT * FROM users WHERE id = 1'
      : 'SELECT * FROM users'
    return { toolName: 'execute_sql', input: { query } }
  }

  if (
    availableTools.has('apply_patch') &&
    (lowerPrompt.includes('apply patch') || lowerPrompt.includes('patch file'))
  ) {
    return {
      toolName: 'apply_patch',
      input: {
        operation: {
          type: 'create_file' as const,
          path: 'hello-from-apply-patch.txt',
          diff: '@@\n+hello from apply_patch\n',
        },
      },
    }
  }

  if (
    availableTools.has('fetch_api') &&
    (lowerPrompt.includes('http') || lowerPrompt.includes('fetch'))
  ) {
    const hintedUrl = extractFirstUrl(latestUserText)
    const url =
      hintedUrl && /jsonplaceholder|example/.test(hintedUrl)
        ? hintedUrl
        : 'https://api.example.com/data'
    return { toolName: 'fetch_api', input: { url, method: 'GET' } }
  }

  return null
}

function buildMockResponseText(params: {
  latestUserText: string
  allText: string
  toolName?: MockToolName
}): string {
  const { latestUserText, allText, toolName } = params
  const normalized = latestUserText.trim()
  const lowerPrompt = normalized.toLowerCase()
  const lowerAll = allText.toLowerCase()

  const quoted = extractQuotedText(normalized)
  if (quoted) {
    return quoted
  }

  if (lowerPrompt.includes('what is my favorite number')) {
    if (lowerAll.includes('favorite number is 42')) {
      return 'Your favorite number is 42.'
    }
  }

  if (lowerPrompt.includes('favorite number is')) {
    return 'Got it.'
  }

  if (lowerPrompt.includes('2 + 2')) {
    return '4'
  }

  if (lowerPrompt.includes('project') && lowerPrompt.includes('file')) {
    return 'Files: src/index.ts, src/calculator.ts, package.json, README.md.'
  }

  if (lowerPrompt.includes('calculator class')) {
    return 'The Calculator class adds numbers and tracks a result.'
  }

  if (lowerPrompt.includes('secret code word')) {
    return 'The secret code word is PINEAPPLE42.'
  }

  if (lowerPrompt.includes('company values')) {
    return 'Innovation and Integrity.'
  }

  if (lowerPrompt.includes('summarize') && lowerAll.includes('todo app')) {
    return 'We are discussing a todo app.'
  }

  if (lowerPrompt.includes('what features') && lowerAll.includes('todo app')) {
    return 'Add due dates, filters, and priorities to the todo app.'
  }

  if (lowerPrompt.includes('weather') || toolName === 'get_weather') {
    return 'The weather is sunny, temperature 72F.'
  }

  if (
    lowerPrompt.includes('database') ||
    lowerPrompt.includes('sql') ||
    toolName === 'execute_sql'
  ) {
    return 'Users include Alice and Bob.'
  }

  if (
    lowerPrompt.includes('apply patch') ||
    lowerPrompt.includes('patch file') ||
    toolName === 'apply_patch'
  ) {
    return 'Applied patch successfully.'
  }

  if (
    lowerPrompt.includes('fetch') ||
    lowerPrompt.includes('http') ||
    toolName === 'fetch_api'
  ) {
    return 'Fetched mock API data.'
  }

  if (lowerPrompt.includes('count to 3')) {
    return '1, 2, 3.'
  }

  if (lowerPrompt.includes('name 3 colors')) {
    return 'Red, Green, Blue.'
  }

  if (lowerPrompt.includes('list 3 fruits')) {
    return 'Apple, Banana, Cherry.'
  }

  if (lowerPrompt.includes('say hello')) {
    return 'Hello!'
  }

  if (!lowerPrompt) {
    return 'Hello!'
  }

  return 'OK.'
}

async function* promptAiSdkStreamMock(
  params: ParamsOf<PromptAiSdkStreamFn>,
): ReturnType<PromptAiSdkStreamFn> {
  const agentChunkMetadata =
    params.agentId != null ? { agentId: params.agentId } : undefined

  const latestUserText = getLatestUserText(params.messages)
  const allText = getAllText(params.messages)
  const promptText = getPromptText(latestUserText, allText)
  const hasToolResult = params.messages.some(
    (message) => message.role === 'tool',
  )

  const toolCall = buildMockToolCall({
    tools: params.tools as Record<string, unknown> | undefined,
    latestUserText: promptText,
    hasToolResult,
  })

  const responseText = buildMockResponseText({
    latestUserText: promptText,
    allText,
    toolName: toolCall?.toolName,
  })

  if (toolCall) {
    yield {
      type: 'tool-call',
      toolCallId: `mock-tool-${Math.random().toString(36).slice(2, 10)}`,
      toolName: toolCall.toolName,
      input: toolCall.input,
    }
  }

  for (const chunk of splitTextIntoChunks(responseText)) {
    yield {
      type: 'text',
      text: chunk,
      ...(agentChunkMetadata ?? {}),
    }
  }

  if (params.onCostCalculated) {
    await params.onCostCalculated(0)
  }

  return promptSuccess(
    `mock-message-${Math.random().toString(36).slice(2, 10)}`,
  )
}

async function promptAiSdkMock(
  params: ParamsOf<PromptAiSdkFn>,
): ReturnType<PromptAiSdkFn> {
  const latestUserText = getLatestUserText(params.messages)
  const allText = getAllText(params.messages)
  const promptText = getPromptText(latestUserText, allText)
  const responseText = buildMockResponseText({
    latestUserText: promptText,
    allText,
  })

  if (params.onCostCalculated) {
    await params.onCostCalculated(0)
  }

  if (params.n && params.n > 1) {
    return promptSuccess(
      JSON.stringify(Array.from({ length: params.n }, () => responseText)),
    )
  }

  return promptSuccess(responseText)
}

async function promptAiSdkStructuredMock<T>(
  params: PromptAiSdkStructuredInput<T>,
): Promise<T> {
  const parsed = params.schema.safeParse({})
  if (params.onCostCalculated) {
    await params.onCostCalculated(0)
  }
  return parsed.success ? parsed.data : ({} as T)
}

let mocksApplied = false

export function setupE2eMocks(): void {
  if (mocksApplied) {
    return
  }
  mocksApplied = true

  spyOn(databaseModule, 'getUserInfoFromApiKey').mockImplementation(
    async ({ fields }) =>
      Object.fromEntries(
        fields.map((field) => [field, MOCK_USER[field]]),
      ) as unknown as Awaited<
        ReturnType<typeof databaseModule.getUserInfoFromApiKey>
      >,
  )
  spyOn(databaseModule, 'fetchAgentFromDatabase').mockImplementation(
    async ({ parsedAgentId }) => buildMockAgentTemplate(parsedAgentId),
  )
  spyOn(databaseModule, 'startAgentRun').mockImplementation(
    async () => `mock-run-${Math.random().toString(36).slice(2, 10)}`,
  )
  spyOn(databaseModule, 'finishAgentRun').mockImplementation(async () => {})
  spyOn(databaseModule, 'addAgentStep').mockImplementation(
    async () => `mock-step-${Math.random().toString(36).slice(2, 10)}`,
  )

  spyOn(llmModule, 'promptAiSdkStream').mockImplementation(
    promptAiSdkStreamMock,
  )
  spyOn(llmModule, 'promptAiSdk').mockImplementation(promptAiSdkMock)
  spyOn(llmModule, 'promptAiSdkStructured').mockImplementation(
    promptAiSdkStructuredMock as typeof llmModule.promptAiSdkStructured,
  )

  spyOn(CodebuffClient.prototype, 'checkConnection').mockResolvedValue(true)
}
