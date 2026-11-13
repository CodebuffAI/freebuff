/**
 * Agent Client Protocol (ACP) support for the Freebuff CLI.
 *
 * `freebuff --acp` serves ACP v1 over stdio (JSON-RPC, newline-delimited), so
 * editors and other ACP clients (Zed, and anything speaking the protocol —
 * agentclientprotocol.com) can drive this CLI as an agent subprocess. This is
 * the in-tree answer to issue #319; it reuses the exact run path the TUI
 * uses — `getCodebuffClient()` — so free mode's session admission, metadata
 * and device signing stay identical, and the server's client allowlist still
 * sees an official Freebuff CLI.
 *
 * The mapping is PrintModeEvent (the SDK's `handleEvent` stream) -> ACP
 * `session/update`:
 *   text            -> agent_message_chunk
 *   reasoning_delta -> agent_thought_chunk
 *   tool_call       -> tool_call (pending)
 *   tool_result     -> tool_call_update (completed, with output content)
 *   error           -> notice
 *   finish          -> the `session/prompt` response resolves (end_turn)
 *
 * Nothing here touches auth, ads or the session store: the ACP surface is a
 * second front end over the same conversation machinery, with sessions kept
 * in-memory per connection and continued via the SDK's `previousRun` state.
 */
import { RequestError } from '@agentclientprotocol/sdk'

import { logger } from '../utils/logger'
import { getCodebuffClient } from '../utils/codebuff-client'
import { loadAgentDefinitions } from '../utils/local-agent-registry'
import {
  AGENT_MODE_TO_COST_MODE,
  AGENT_MODE_TO_ID,
  IS_FREEBUFF,
} from '../utils/constants'
import {
  clientDescriptorMetadata,
  freebuffSessionMetadata,
} from '../utils/freebuff-session-identity'
import { AcpSessionError, acpFreebuffSession } from './freebuff-session'

import type { AgentMode } from '../utils/constants'

import type { AgentContext } from '@agentclientprotocol/sdk'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { RunState } from '@codebuff/sdk'
import type { ContentBlock, ToolKind } from '@agentclientprotocol/sdk'

/** Coarse ACP tool kind per Freebuff tool name. Unknown tools stay `other`. */
const TOOL_KINDS: Record<string, ToolKind> = {
  read_files: 'read',
  write_file: 'edit',
  edit_file: 'edit',
  apply_patch: 'edit',
  find_files: 'search',
  code_search: 'search',
  web_search: 'search',
  run_terminal_command: 'execute',
  update_todo_list: 'think',
}

/** The ACP update a PrintModeEvent maps to. */
export type AcpUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock }
  | {
      sessionUpdate: 'tool_call'
      toolCallId: string
      title: string
      name: string
      kind: ToolKind
      status: 'pending'
      rawInput?: unknown
    }
  | {
      sessionUpdate: 'tool_call_update'
      toolCallId: string
      status: 'completed' | 'failed'
      content?: Array<{ type: 'content'; content: ContentBlock }>
    }
  | { sessionUpdate: 'notice'; notice: string }

/** What one turn needs from the SDK run. Injected so the protocol surface can
 *  be tested without a backend, and so the run path stays swappable. */
export type AcpTurnRequest = {
  prompt: string
  cwd: string
  /** LITE by default: the only mode a free account can buy. */
  mode: AgentMode
  previousRun: RunState | null
  signal: AbortSignal
  onEvent: (event: PrintModeEvent) => void | Promise<void>
}

export type AcpTurnResult = {
  previousRun: RunState | null
}

type AcpSession = {
  cwd: string
  mode: AgentMode
  previousRun: RunState | null
  /** The in-flight turn's abort, so `session/cancel` reaches the SDK run. */
  pendingPrompt: AbortController | null
  /** Tool calls opened this turn that never reached a terminal status. */
  openToolCalls: Set<string>
}

export class FreebuffAcpAgent {
  private readonly sessions = new Map<string, AcpSession>()
  private readonly logger: Logger
  /** Runs one turn. Replaced in tests; the default is the SDK run. */
  private readonly runTurn: (request: AcpTurnRequest) => Promise<AcpTurnResult>
  /** Mode new sessions start in. ACP can override it per session later. */
  private readonly defaultMode: AgentMode

  constructor(options: {
    logger?: Logger
    runTurn?: (request: AcpTurnRequest) => Promise<AcpTurnResult>
    mode?: AgentMode
  } = {}) {
    this.logger = options.logger ?? logger
    this.runTurn = options.runTurn ?? defaultRunTurn
    this.defaultMode = options.mode ?? 'LITE'
  }

  newSession(cwd: string, mode: AgentMode = this.defaultMode): string {
    const sessionId = crypto.randomUUID()
    this.sessions.set(sessionId, {
      cwd,
      mode,
      previousRun: null,
      pendingPrompt: null,
      openToolCalls: new Set(),
    })
    return sessionId
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** Human title for a tool call, from its input. Kept deliberately small:
   *  ACP clients render `rawInput` themselves when they want detail. */
  toolTitle(toolName: string, input: Record<string, unknown>): string {
    const path = (input as { path?: unknown }).path
    const command = (input as { command?: unknown }).command
    if (typeof path === 'string') return `${toolName}: ${path}`
    if (typeof command === 'string') return `${toolName}: ${command.slice(0, 80)}`
    return toolName
  }

  /** PrintModeEvent -> ACP update, or null when the event carries nothing a
   *  client can show. Pure: no I/O, so it is directly unit-testable. */
  eventToUpdate(
    _sessionId: string,
    event: PrintModeEvent,
  ): { update: AcpUpdate } | { error: string } | null {
    switch (event.type) {
      case 'text':
        if (!event.text) return null
        return {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: event.text },
          },
        }
      case 'reasoning_delta':
        if (!event.text) return null
        return {
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: event.text },
          },
        }
      case 'tool_call': {
        return {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: event.toolCallId,
            title: this.toolTitle(event.toolName, event.input),
            name: event.toolName,
            kind: TOOL_KINDS[event.toolName] ?? 'other',
            status: 'pending',
            rawInput: event.input,
          },
        }
      }
      case 'tool_result': {
        const content: ContentBlock[] = []
        for (const part of event.output) {
          if (part.type === 'json') {
            content.push({
              type: 'text',
              text:
                typeof part.value === 'string'
                  ? part.value
                  : JSON.stringify(part.value),
            })
          } else if (part.type === 'media') {
            content.push({
              type: 'text',
              text: `[${part.mediaType} attachment, ${part.data.length} base64 chars]`,
            })
          }
        }
        return {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: event.toolCallId,
            status: 'completed',
            content: content.map((c) => ({
              type: 'content' as const,
              content: c,
            })),
          },
        }
      }
      case 'error':
        return { error: event.message }
      default:
        // start, finish, subagent_start/finish, download carry nothing an ACP
        // client renders as an update.
        return null
    }
  }

  async prompt(
    sessionId: string,
    promptBlocks: ContentBlock[],
    cx: AgentContext,
  ): Promise<'end_turn' | 'cancelled' | 'refusal'> {
    const session = this.sessions.get(sessionId)
    if (!session) throw RequestError.sessionNotFound(sessionId)
    // Two concurrent turns would interleave their updates and race
    // `previousRun`; ACP clients are expected to cancel first.
    if (session.pendingPrompt) {
      throw RequestError.invalidParams(
        {},
        'This session is already running a turn. Cancel it before sending another.',
      )
    }

    const prompt = promptBlocks
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim()
    if (!prompt) {
      throw RequestError.invalidParams(
        {},
        'Prompt contained no text content',
      )
    }

    const abort = new AbortController()
    session.pendingPrompt = abort
    session.openToolCalls.clear()

    const notify = async (update: AcpUpdate) => {
      await cx.notify('session/update', { sessionId, update } as never)
    }

    try {
      const result = await this.runTurn({
        prompt,
        cwd: session.cwd,
        mode: session.mode,
        previousRun: session.previousRun,
        signal: abort.signal,
        onEvent: async (event: PrintModeEvent) => {
          if (abort.signal.aborted) return
          // Track the calls this turn leaves open so they can be closed at the
          // end; the mapping itself stays pure.
          if (event.type === 'tool_call') {
            session.openToolCalls.add(event.toolCallId)
          } else if (event.type === 'tool_result') {
            session.openToolCalls.delete(event.toolCallId)
          }
          const mapped = this.eventToUpdate(sessionId, event)
          if (!mapped) return
          if ('error' in mapped) {
            await notify({ sessionUpdate: 'notice', notice: mapped.error })
            return
          }
          await notify(mapped.update)
        },
      })

      // Close any tool call left open so clients never show a spinner forever.
      for (const toolCallId of session.openToolCalls) {
        await notify({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: abort.signal.aborted ? 'failed' : 'completed',
        })
      }
      session.openToolCalls.clear()

      session.previousRun = result.previousRun
      return abort.signal.aborted ? 'cancelled' : 'end_turn'
    } catch (error) {
      // A refused admission is not a protocol failure: the editor should keep
      // the session and show why, so the user can fix the account state and
      // send again instead of reconnecting the agent.
      if (error instanceof AcpSessionError) {
        await notify({ sessionUpdate: 'notice', notice: error.message })
        return 'refusal'
      }
      throw error
    } finally {
      session.pendingPrompt = null
    }
  }

  cancel(sessionId: string): void {
    this.sessions.get(sessionId)?.pendingPrompt?.abort()
  }
}

/** The production turn: one SDK `run` on the shared CLI client, the same path
 *  the TUI's send-message flow takes. */
const defaultRunTurn = async (request: AcpTurnRequest): Promise<AcpTurnResult> => {
  const client = await getCodebuffClient()
  if (!client) throw RequestError.authRequired({})

  const agentDefinitions = loadAgentDefinitions()

  // No renderer means no `useFreebuffSession`: nothing has admitted the hour
  // the TUI would have claimed, and the backend refuses an unadmitted free
  // completion. Claim it here and keep it for the life of the process.
  const admission = IS_FREEBUFF
    ? await acpFreebuffSession.ensure(request.signal)
    : null

  const result = (await client.run({
    agent: AGENT_MODE_TO_ID[request.mode],
    prompt: request.prompt,
    agentDefinitions,
    previousRun: request.previousRun ?? undefined,
    cwd: request.cwd,
    signal: request.signal,
    costMode: AGENT_MODE_TO_COST_MODE[request.mode],
    ...(admission
      ? {
          extraCodebuffMetadata: {
            ...freebuffSessionMetadata(admission.instanceId),
            ...clientDescriptorMetadata(request.prompt),
          },
        }
      : {}),
    handleEvent: request.onEvent,
  } as never)) as RunState

  if (result.output?.type === 'error' && !request.signal.aborted) {
    // A failed run still resolves the turn. Surface it, or the client shows a
    // successful turn that produced nothing.
    logger.warn(
      { error: result.output.message },
      '[acp] turn ended with an error',
    )
    await request.onEvent({ type: 'error', message: result.output.message })
  }
  return { previousRun: result }
}
