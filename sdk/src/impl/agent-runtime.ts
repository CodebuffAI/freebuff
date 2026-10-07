import { trackEvent as trackCommonEvent } from '@codebuff/common/analytics'
import { BYOK_LOCAL_USER_ID } from '@codebuff/common/constants/byok'
import { env as clientEnvDefault } from '@codebuff/common/env'
import { getCiEnv } from '@codebuff/common/env-ci'
import { shouldTrackAnalyticsEvent } from '@codebuff/common/util/analytics-sampling'
import { success } from '@codebuff/common/util/error'

import { getWebsiteUrl } from '../constants'
import type { ResolvedByokConnection } from '../byok'
import type { CodebuffRequestHeadersProvider } from './model-provider'

import {
  addAgentStep,
  fetchAgentFromDatabase,
  finishAgentRun,
  getUserInfoFromApiKey,
  startAgentRun,
} from './database'
import { promptAiSdk, promptAiSdkStream, promptAiSdkStructured } from './llm'

import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { DatabaseAgentCache } from '@codebuff/common/types/contracts/database'
import type { ClientEnv } from '@codebuff/common/types/contracts/env'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { TraceWriter } from '@codebuff/common/types/contracts/trace'
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'

const DATABASE_AGENT_CACHE_MAX_ENTRIES = 200

/** Insertion-order (FIFO) eviction so the cache can't grow without bound in
 *  long-lived processes (e.g. the freebuff chat server, which runs the agent
 *  runtime in-process). Templates are large — prompts plus handleSteps source. */
class BoundedAgentCache extends Map<string, AgentTemplate | null> {
  override set(key: string, value: AgentTemplate | null): this {
    if (!this.has(key)) {
      while (this.size >= DATABASE_AGENT_CACHE_MAX_ENTRIES) {
        const oldestKey = this.keys().next().value
        if (oldestKey === undefined) break
        this.delete(oldestKey)
      }
    }
    return super.set(key, value)
  }
}

const databaseAgentCache: DatabaseAgentCache = new BoundedAgentCache()

export function getAgentRuntimeImpl(
  params: {
    logger?: Logger
    traceWriter?: TraceWriter
    apiKey: string
    clientEnv?: ClientEnv
    /** Enables an auth-free, direct local runtime for this one run. */
    byok?: ResolvedByokConnection
    /** Registry publishers whose executable agents may load; see ../agent-publisher-trust.ts. */
    trustedAgentPublishers?: readonly string[]
    /** Never fetch from the agent registry; see `CodebuffClientOptions.disableAgentRegistry`. */
    disableAgentRegistry?: boolean
    /** Extra headers per backend completions request; see `CodebuffClientOptions.requestHeaders`. */
    requestHeaders?: CodebuffRequestHeadersProvider
  } & Pick<
    AgentRuntimeScopedDeps,
    | 'handleStepsLogChunk'
    | 'requestToolCall'
    | 'requestMcpToolData'
    | 'requestFiles'
    | 'requestImageFile'
    | 'requestOptionalFile'
    | 'sendAction'
    | 'sendSubagentChunk'
  >,
): AgentRuntimeDeps & AgentRuntimeScopedDeps {
  const {
    logger,
    traceWriter,
    apiKey,
    byok,
    trustedAgentPublishers,
    disableAgentRegistry,
    requestHeaders,
    clientEnv: clientEnvInput,
    handleStepsLogChunk,
    requestToolCall,
    requestMcpToolData,
    requestFiles,
    requestImageFile,
    requestOptionalFile,
    sendAction,
    sendSubagentChunk,
  } = params

  const clientEnv: ClientEnv = {
    ...(clientEnvInput ?? clientEnvDefault),
    NEXT_PUBLIC_CODEBUFF_APP_URL: getWebsiteUrl(),
  }

  const trackSdkRuntimeEvent: TrackEventFn = (eventParams) => {
    if (
      clientEnv.NEXT_PUBLIC_CB_ENVIRONMENT === 'prod' &&
      !shouldTrackAnalyticsEvent({
        event: eventParams.event,
        distinctId: eventParams.userId,
        properties: eventParams.properties,
      })
    ) {
      return
    }

    trackCommonEvent(eventParams)
  }

  return {
    // Environment
    clientEnv,
    ciEnv: getCiEnv(),

    // Database
    getUserInfoFromApiKey: byok
      ? async () => ({ id: BYOK_LOCAL_USER_ID }) as any
      : getUserInfoFromApiKey,
    // A BYOK run only uses its local agent registry. A missing local agent is
    // an error, never a reason to send its prompt or identity to Freebuff.
    // Otherwise a registry template is fetched through the publisher-trust
    // gate: its handleSteps is code this process would eval.
    fetchAgentFromDatabase: byok || disableAgentRegistry
      ? async () => null
      : (fetchParams) =>
          fetchAgentFromDatabase({ ...fetchParams, trustedAgentPublishers }),
    startAgentRun: byok ? async () => `byok-${crypto.randomUUID()}` : startAgentRun,
    finishAgentRun: byok ? async () => {} : finishAgentRun,
    addAgentStep: byok ? async () => `byok-step-${crypto.randomUUID()}` : addAgentStep,

    // Billing
    consumeCreditsWithFallback: async () =>
      success({
        chargedToOrganization: false,
      }),

    // LLM. A BYOK run talks to the user's own provider, so the host's backend
    // request headers never apply to it.
    promptAiSdkStream: byok
      ? ((params) => promptAiSdkStream({ ...params, byok } as any))
      : requestHeaders
        ? ((params) => promptAiSdkStream({ ...params, requestHeaders }))
        : promptAiSdkStream,
    promptAiSdk: byok
      ? ((params) => promptAiSdk({ ...params, byok } as any))
      : requestHeaders
        ? ((params) => promptAiSdk({ ...params, requestHeaders }))
        : promptAiSdk,
    promptAiSdkStructured: byok
      ? ((params) => promptAiSdkStructured({ ...params, byok } as any))
      : requestHeaders
        ? ((params) => promptAiSdkStructured({ ...params, requestHeaders }) as any)
        : promptAiSdkStructured,

    // Mutable State
    databaseAgentCache: byok ? new Map() : databaseAgentCache,

    // Analytics
    trackEvent: byok ? (() => {}) : trackSdkRuntimeEvent,

    // Other
    logger: logger ?? noopLogger,
    traceWriter,
    // Server-side research/Gravity helpers use this runtime fetch. BYOK has
    // no Codebuff service allowance, so fail closed; model requests use the
    // direct provider fetch constructed in model-provider.ts instead.
    fetch: byok
      ? (async () => {
          throw new Error('Hosted service tools are unavailable in a direct BYOK run')
        }) as unknown as typeof globalThis.fetch
      : globalThis.fetch,

    // Client (WebSocket)
    handleStepsLogChunk,
    requestToolCall,
    requestMcpToolData,
    requestFiles,
    requestImageFile,
    requestOptionalFile,
    sendAction,
    sendSubagentChunk,

    apiKey,
  }
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
