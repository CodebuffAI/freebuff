import { globalStopSequence } from './constants'

import type { AgentTemplate } from './templates/types'
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type { SendActionFn } from '@codebuff/common/types/contracts/client'
import type {
  SessionRecord,
  UserInputRecord,
} from '@codebuff/common/types/contracts/live-user-input'
import type { PromptAiSdkStreamFn } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsOf } from '@codebuff/common/types/function-params'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { OpenRouterProviderOptions } from '@codebuff/internal/openrouter-ai-sdk'
import type { ToolSet } from 'ai'

export const getAgentStreamFromTemplate = (params: {
  agentId?: string
  apiKey: string
  clientSessionId: string
  fingerprintId: string
  includeCacheControl?: boolean
  liveUserInputRecord: UserInputRecord
  logger: Logger
  messages: Message[]
  runId: string
  sessionConnections: SessionRecord
  template: AgentTemplate
  tools: ToolSet
  userId: string | undefined
  userInputId: string

  onCostCalculated?: (credits: number) => Promise<void>
  promptAiSdkStream: PromptAiSdkStreamFn
  sendAction: SendActionFn
  trackEvent: TrackEventFn
}): ReturnType<PromptAiSdkStreamFn> => {
  const {
    agentId,
    apiKey,
    clientSessionId,
    fingerprintId,
    includeCacheControl,
    liveUserInputRecord,
    logger,
    messages,
    runId,
    sessionConnections,
    template,
    tools,
    userId,
    userInputId,

    sendAction,
    onCostCalculated,
    promptAiSdkStream,
    trackEvent,
  } = params

  if (!template) {
    throw new Error('Agent template is null/undefined')
  }

  const { model } = template

  const aiSdkStreamParams: ParamsOf<PromptAiSdkStreamFn> = {
    agentId,
    apiKey,
    clientSessionId,
    fingerprintId,
    includeCacheControl,
    logger,
    liveUserInputRecord,
    maxOutputTokens: 32_000,
    maxRetries: 3,
    messages,
    model,
    runId,
    sessionConnections,
    stopSequences: [globalStopSequence],
    tools,
    userId,
    userInputId,

    onCostCalculated,
    sendAction,
    trackEvent,
  }

  if (!aiSdkStreamParams.providerOptions) {
    aiSdkStreamParams.providerOptions = {}
  }
  for (const provider of ['openrouter', 'codebuff'] as const) {
    if (!aiSdkStreamParams.providerOptions[provider]) {
      aiSdkStreamParams.providerOptions[provider] = {}
    }
    ;(
      aiSdkStreamParams.providerOptions[provider] as OpenRouterProviderOptions
    ).reasoning = template.reasoningOptions
  }

  // Pass agent's provider routing options to SDK
  aiSdkStreamParams.agentProviderOptions = template.providerOptions

  return promptAiSdkStream(aiSdkStreamParams)
}
