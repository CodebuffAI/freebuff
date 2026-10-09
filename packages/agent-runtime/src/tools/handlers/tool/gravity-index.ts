import { FREEBUFF_DESKTOP_THREAD_AGENT_ID } from '@codebuff/common/constants/free-agents'
import { jsonToolResult } from '@codebuff/common/util/messages'

import { callGravityIndexAPI } from '../../../llm-api/codebuff-web-api'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { ClientEnv, CiEnv } from '@codebuff/common/types/contracts/env'
import type { JSONObject, JSONValue } from '@codebuff/common/types/json'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { AgentState } from '@codebuff/common/types/session-state'

const omitUndefined = (value: Record<string, JSONValue | undefined>) => {
  const result: JSONObject = {}
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined) {
      result[key] = field
    }
  }
  return result
}

const isJSONObject = (value: JSONValue | undefined): value is JSONObject =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Gravity slugs are lowercase kebab-case; models write "Resend",
 *  "google_ai_studio" or "Google AI Studio". */
export const normalizeGravitySlug = (slug: string): string =>
  slug
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')

type GravitySearchSeen = {
  searchId: string
  recommendedSlug: string | undefined
  optionSlugs: string[]
}

/** Every gravity_index search result this run has seen, newest first. */
const searchesInHistory = (
  messages: readonly Message[],
): GravitySearchSeen[] => {
  const seen: GravitySearchSeen[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'tool' || message.toolName !== 'gravity_index') {
      continue
    }
    const part = (message.content as unknown[]).find(
      (item): item is { type: 'json'; value: JSONValue } =>
        !!item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'json',
    )
    const value = part?.value
    if (!isJSONObject(value) || typeof value.search_id !== 'string') continue
    const recommendation = isJSONObject(value.recommendation)
      ? value.recommendation
      : undefined
    const options = Array.isArray(value.options) ? value.options : []
    seen.push({
      searchId: value.search_id,
      recommendedSlug:
        typeof recommendation?.slug === 'string'
          ? recommendation.slug
          : undefined,
      optionSlugs: options
        .filter(isJSONObject)
        .map((option) => option.slug)
        .filter((slug): slug is string => typeof slug === 'string'),
    })
  }
  return seen
}

export type ReportPreflight =
  | { kind: 'send'; searchId: string; integratedSlug: string; rewritten?: string }
  | { kind: 'refuse'; errorMessage: string }

/**
 * Checks a `report_integration` against the searches this run actually saw,
 * before it reaches Gravity, which credits a conversion only when
 * `integrated_slug` equals the search's RECOMMENDATION slug. Logs showed the
 * agent reporting an option's slug, or a search that had no recommendation
 * (~1,100 rejected reports Aug 24–Oct 9).
 *
 * - The referenced search recommended this service (modulo slug spelling):
 *   send it with Gravity's exact slug.
 * - Another search in this run recommended it: send THAT search_id. The
 *   recommendation genuinely happened; the model just carried the wrong id.
 * - The referenced search is in history but recommended something else or
 *   nothing, and no other search recommended it: refuse locally with a message
 *   the model can act on, instead of a doomed upstream call.
 * - The referenced search is not in history (a catalog hand-off, a subagent's
 *   search, a compacted history): send unchanged. Nothing is known to be
 *   wrong, and Gravity remains the judge.
 *
 * It never manufactures a match: no new search is run to obtain one.
 */
export const preflightReportIntegration = (params: {
  searchId: string
  integratedSlug: string
  messages: readonly Message[]
}): ReportPreflight => {
  const wanted = normalizeGravitySlug(params.integratedSlug)
  const searches = searchesInHistory(params.messages)
  const recommends = (search: GravitySearchSeen) =>
    search.recommendedSlug !== undefined &&
    normalizeGravitySlug(search.recommendedSlug) === wanted

  const referenced = searches.find((s) => s.searchId === params.searchId)
  if (referenced && recommends(referenced)) {
    const slug = referenced.recommendedSlug!
    return {
      kind: 'send',
      searchId: params.searchId,
      integratedSlug: slug,
      ...(slug !== params.integratedSlug ? { rewritten: 'slug' } : {}),
    }
  }

  const recommending = searches.find(recommends)
  if (recommending) {
    return {
      kind: 'send',
      searchId: recommending.searchId,
      integratedSlug: recommending.recommendedSlug!,
      rewritten: 'search_id',
    }
  }

  if (!referenced) {
    return {
      kind: 'send',
      searchId: params.searchId,
      integratedSlug: params.integratedSlug,
    }
  }

  const why = referenced.recommendedSlug
    ? `recommended "${referenced.recommendedSlug}"${
        referenced.optionSlugs.some((s) => normalizeGravitySlug(s) === wanted)
          ? ` and listed "${params.integratedSlug}" only as an option`
          : ''
      }`
    : 'returned no recommendation'
  return {
    kind: 'refuse',
    errorMessage: `Not reported: search "${params.searchId}" ${why}, and no search in this conversation recommended "${params.integratedSlug}". A conversion can only be reported for a search's recommended service. If you integrated "${referenced.recommendedSlug ?? 'the recommended service'}", report that slug; otherwise there is nothing to report. Do not retry with the same arguments.`,
  }
}

/** Surface label sent with the Gravity Index request, derived from the agent
 *  template. */
const gravitySurface = (agentTemplate: { id: string }): string => {
  if (agentTemplate.id === 'base-chat') return 'freebuff_chat'
  // Freebuff Desktop's thread agents (`freebuff-desktop-thread-{local,worktree}[-v3]`). Desktop runs
  // on the signed-in user's own key, so it attributes like the CLI (no external_user_id) and only
  // needs its own label so its clicks and conversions are not counted as CLI traffic.
  if (agentTemplate.id.startsWith(FREEBUFF_DESKTOP_THREAD_AGENT_ID)) {
    return 'freebuff_desktop'
  }
  // Freebuff Web project agents are the `base2-free*` and `base3-free*`
  // families (both prefixes: the harness swap changed the root ids).
  if (
    agentTemplate.id.startsWith('base2-free') ||
    agentTemplate.id.startsWith('base3-free')
  ) {
    return 'freebuff_web'
  }
  return 'codebuff_cli'
}

/** Surfaces that run under a shared service-account API key; these send a
 *  per-end-user identifier with the request. */
const isServiceAccountSurface = (surface: string): boolean =>
  surface === 'freebuff_chat' || surface === 'freebuff_web'

export const handleGravityIndex = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<'gravity_index'>
  agentTemplate: AgentTemplate
  /** Absent in direct unit tests; the runtime always passes it. */
  agentState?: AgentState
  logger: Logger
  apiKey: string

  agentStepId: string
  clientSessionId: string
  fingerprintId: string
  repoId: string | undefined
  userInputId: string
  userId: string | undefined

  fetch: typeof globalThis.fetch
  clientEnv: ClientEnv
  ciEnv: CiEnv
}): Promise<{
  output: CodebuffToolOutput<'gravity_index'>
  creditsUsed: number
}> => {
  const {
    previousToolCallFinished,
    toolCall,
    agentTemplate,
    agentState,
    agentStepId,
    apiKey,
    clientSessionId,
    fingerprintId,
    logger,
    repoId,
    userId,
    userInputId,
    fetch,
    clientEnv,
    ciEnv,
  } = params
  const { action } = toolCall.input

  const startedAt = Date.now()
  const gravityContext = {
    toolCallId: toolCall.toolCallId,
    action,
    userId,
    agentStepId,
    clientSessionId,
    fingerprintId,
    userInputId,
    repoId,
  }

  await previousToolCallFinished

  let creditsUsed = 0
  try {
    let existingInput = toolCall.input as JSONObject
    // Missing fields fall through to the server's per-action validation.
    if (
      toolCall.input.action === 'report_integration' &&
      toolCall.input.search_id &&
      toolCall.input.integrated_slug
    ) {
      const preflight = preflightReportIntegration({
        searchId: toolCall.input.search_id,
        integratedSlug: toolCall.input.integrated_slug,
        messages: agentState?.messageHistory ?? [],
      })
      if (preflight.kind === 'refuse') {
        logger.info(
          {
            ...gravityContext,
            searchId: toolCall.input.search_id,
            integratedSlug: toolCall.input.integrated_slug,
          },
          'Gravity report_integration refused before upstream: not the recommendation',
        )
        return {
          output: jsonToolResult({ errorMessage: preflight.errorMessage }),
          creditsUsed,
        }
      }
      if (preflight.rewritten) {
        logger.info(
          {
            ...gravityContext,
            rewritten: preflight.rewritten,
            fromSearchId: toolCall.input.search_id,
            toSearchId: preflight.searchId,
            fromSlug: toolCall.input.integrated_slug,
            toSlug: preflight.integratedSlug,
          },
          'Gravity report_integration corrected from this run’s searches',
        )
      }
      existingInput = {
        ...existingInput,
        search_id: preflight.searchId,
        integrated_slug: preflight.integratedSlug,
      }
    }
    const existingMetadata = isJSONObject(existingInput.metadata)
      ? existingInput.metadata
      : {}
    const surface = gravitySurface(agentTemplate)
    const metadata = {
      ...existingMetadata,
      ...omitUndefined({
        surface,
        tool_call_id: toolCall.toolCallId,
        agent_step_id: agentStepId,
        fingerprint_id: fingerprintId,
        user_input_id: userInputId,
        repo_id: repoId,
      }),
    }
    const input = {
      ...existingInput,
      external_session_id: clientSessionId,
      // On service-account surfaces, `fingerprintId` (e.g.
      // `freebuff-chat-<userId>` or the project id) is sent as the external
      // user id. Other surfaces omit it.
      ...(isServiceAccountSurface(surface)
        ? { external_user_id: fingerprintId }
        : {}),
      metadata,
    } satisfies JSONObject

    const webApi = await callGravityIndexAPI({
      input,
      fetch,
      logger,
      apiKey,
      env: { clientEnv, ciEnv },
    })

    if (webApi.error || !webApi.result) {
      logger.warn(
        {
          ...gravityContext,
          durationMs: Date.now() - startedAt,
          success: false,
          error: webApi.error,
        },
        'Gravity Index returned error',
      )
      return {
        output: jsonToolResult({
          errorMessage: webApi.error ?? 'Invalid Gravity Index response',
        }),
        creditsUsed,
      }
    }

    if (typeof webApi.creditsUsed === 'number') {
      creditsUsed = webApi.creditsUsed
    }

    logger.info(
      {
        ...gravityContext,
        durationMs: Date.now() - startedAt,
        recommendation:
          typeof webApi.result.recommendation === 'object'
            ? webApi.result.recommendation
            : undefined,
        creditsUsed,
        success: true,
      },
      'Gravity Index request completed via web API',
    )

    return {
      output: jsonToolResult(webApi.result),
      creditsUsed,
    }
  } catch (error) {
    const errorMessage = `Error calling Gravity Index action "${action}": ${
      error instanceof Error ? error.message : 'Unknown error'
    }`
    logger.error(
      {
        ...gravityContext,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
        durationMs: Date.now() - startedAt,
        success: false,
      },
      'Gravity Index request failed with error',
    )
    return { output: jsonToolResult({ errorMessage }), creditsUsed }
  }
}) satisfies CodebuffToolHandlerFunction<'gravity_index'>
