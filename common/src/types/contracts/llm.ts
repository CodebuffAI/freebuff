import type { TrackEventFn } from './analytics'
import type { SendActionFn } from './client'
import type { CheckLiveUserInputFn } from './live-user-input'
import type { OpenRouterProviderRoutingOptions } from '../agent-template'
import type { ParamsExcluding } from '../function-params'
import type { Logger } from './logger'
import type { Model } from '../../old-constants'
import type { Message } from '../messages/codebuff-message'
import type { generateText, streamText, ToolCallPart } from 'ai'
import type z from 'zod/v4'

export type StreamChunk =
  | {
      type: 'text'
      text: string
      agentId?: string
    }
  | {
      type: 'reasoning'
      text: string
    }
  | Pick<
      ToolCallPart,
      'type' | 'toolCallId' | 'toolName' | 'input' | 'providerOptions'
    >
  | { type: 'error'; message: string }

export type PromptAiSdkStreamFn = (
  params: {
    apiKey: string
    runId: string
    messages: Message[]
    clientSessionId: string
    fingerprintId: string
    model: Model
    userId: string | undefined
    chargeUser?: boolean
    thinkingBudget?: number
    userInputId: string
    agentId?: string
    maxRetries?: number
    onCostCalculated?: (credits: number) => Promise<void>
    includeCacheControl?: boolean
    agentProviderOptions?: OpenRouterProviderRoutingOptions
    sendAction: SendActionFn
    logger: Logger
    trackEvent: TrackEventFn
  } & ParamsExcluding<typeof streamText, 'model' | 'messages'> &
    ParamsExcluding<CheckLiveUserInputFn, 'clientSessionId'>,
) => AsyncGenerator<StreamChunk, string | null>

export type PromptAiSdkFn = (
  params: {
    apiKey: string
    runId: string
    messages: Message[]
    clientSessionId: string
    fingerprintId: string
    userInputId: string
    model: Model
    userId: string | undefined
    chargeUser?: boolean
    agentId?: string
    onCostCalculated?: (credits: number) => Promise<void>
    includeCacheControl?: boolean
    agentProviderOptions?: OpenRouterProviderRoutingOptions
    maxRetries?: number
    sendAction: SendActionFn
    logger: Logger
    trackEvent: TrackEventFn
    n?: number
  } & ParamsExcluding<typeof generateText, 'model' | 'messages'> &
    ParamsExcluding<CheckLiveUserInputFn, 'clientSessionId'>,
) => Promise<string>

export type PromptAiSdkStructuredInput<T> = {
  apiKey: string
  runId: string
  messages: Message[]
  schema: z.ZodType<T>
  clientSessionId: string
  fingerprintId: string
  userInputId: string
  model: Model
  userId: string | undefined
  maxTokens?: number
  temperature?: number
  timeout?: number
  chargeUser?: boolean
  agentId?: string
  onCostCalculated?: (credits: number) => Promise<void>
  includeCacheControl?: boolean
  agentProviderOptions?: OpenRouterProviderRoutingOptions
  maxRetries?: number
  sendAction: SendActionFn
  logger: Logger
  trackEvent: TrackEventFn
} & ParamsExcluding<CheckLiveUserInputFn, 'clientSessionId'>
export type PromptAiSdkStructuredOutput<T> = Promise<T>
export type PromptAiSdkStructuredFn = <T>(
  params: PromptAiSdkStructuredInput<T>,
) => PromptAiSdkStructuredOutput<T>

export type HandleOpenRouterStreamFn = (params: {
  body: any
  userId: string
  agentId: string
}) => Promise<ReadableStream>
