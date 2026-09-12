import type { TrackEventFn } from './analytics'
import type { ConsumeCreditsWithFallbackFn } from './billing'
import type {
  HandleStepsLogChunkFn,
  RequestFilesFn,
  RequestImageFileFn,
  RequestMcpToolDataFn,
  RequestOptionalFileFn,
  RequestToolCallFn,
  SendActionFn,
  SendSubagentChunkFn,
} from './client'
import type {
  AddAgentStepFn,
  DatabaseAgentCache,
  FetchAgentFromDatabaseFn,
  FinishAgentRunFn,
  GetUserInfoFromApiKeyFn,
  StartAgentRunFn,
} from './database'
import type { ClientEnv, CiEnv } from './env'
import type {
  PromptAiSdkFn,
  PromptAiSdkStreamFn,
  PromptAiSdkStructuredFn,
} from './llm'
import type { Logger } from './logger'
import type { TraceWriter } from './trace'

/** Shared dependencies */
export type AgentRuntimeDeps = {
  // Environment
  clientEnv: ClientEnv
  ciEnv: CiEnv

  // Database
  getUserInfoFromApiKey: GetUserInfoFromApiKeyFn
  fetchAgentFromDatabase: FetchAgentFromDatabaseFn
  startAgentRun: StartAgentRunFn
  finishAgentRun: FinishAgentRunFn
  addAgentStep: AddAgentStepFn

  // Billing
  consumeCreditsWithFallback: ConsumeCreditsWithFallbackFn

  // LLM
  promptAiSdkStream: PromptAiSdkStreamFn
  promptAiSdk: PromptAiSdkFn
  promptAiSdkStructured: PromptAiSdkStructuredFn

  // Mutable State
  databaseAgentCache: DatabaseAgentCache

  // Analytics
  trackEvent: TrackEventFn

  // Other
  logger: Logger
  /** Optional debug trace of agent message histories (see TraceWriter) */
  traceWriter?: TraceWriter
  fetch: typeof globalThis.fetch
}

/** Per-run dependencies */
export type AgentRuntimeScopedDeps = {
  // Client (WebSocket)
  handleStepsLogChunk: HandleStepsLogChunkFn
  requestToolCall: RequestToolCallFn
  requestMcpToolData: RequestMcpToolDataFn
  requestFiles: RequestFilesFn
  requestOptionalFile: RequestOptionalFileFn
  /** Only hosts that read the workspace locally provide this. Without it,
   *  read_files sends image paths through `requestFiles` like any file. */
  requestImageFile?: RequestImageFileFn
  sendAction: SendActionFn
  sendSubagentChunk: SendSubagentChunkFn

  apiKey: string
}
