import path from 'path'

import { callMainPrompt } from '@codebuff/agent-runtime/main-prompt'
import { adjustContextTokenCountForHistoryEdit } from '@codebuff/agent-runtime/util/context-token-count'
import {
  buildUserMessageContent,
  withSystemTags,
} from '@codebuff/agent-runtime/util/messages'
import { MAX_AGENT_STEPS_DEFAULT } from '@codebuff/common/constants/agents'
import { toRepoSnapshot } from '@codebuff/common/util/file'
import { dropUnansweredToolCalls } from '@codebuff/common/util/messages'
import {
  FILE_READ_STATUS,
  toOptionalFile,
} from '@codebuff/common/constants/paths'
import {
  getMCPClient,
  listMCPTools,
  callMCPTool,
} from '@codebuff/common/mcp/client'
import {
  COMPOSIO_META_TOOL_NAMES,
  isComposioMetaToolName,
} from '@codebuff/common/constants/composio'
import { toolNames } from '@codebuff/common/tools/constants'
import { clientToolCallSchema } from '@codebuff/common/tools/list'
import { AgentOutputSchema } from '@codebuff/common/types/session-state'
import {
  FETCH_IDLE_TIMEOUT_USER_MESSAGE,
  TRANSIENT_NETWORK_ERROR_USER_MESSAGE,
  extractApiErrorDetails,
  isFetchIdleTimeoutError,
  isTransientNetworkError,
} from '@codebuff/common/util/error'
import { isSensitiveEnvFilePath } from '@codebuff/common/util/env-file-path'
import { cloneDeep } from 'lodash'

import { executeComposioToolViaServer } from './composio'
import { byokModelLimits } from './byok'
import type { ResolvedByokConnection } from './byok'
import { getErrorStatusCode } from './error-utils'
import { getAgentRuntimeImpl } from './impl/agent-runtime'
import { getUserInfoFromApiKey } from './impl/database'
import { initialSessionState, applyOverridesToSessionState } from './run-state'
import type { ComputedProjectIndex } from './run-state'
import { changeFile } from './tools/change-file'
import { applyPatchTool } from './tools/apply-patch'
import { codeSearch } from './tools/code-search'
import { glob } from './tools/glob'
import { listDirectory } from './tools/list-directory'
import { getProjectPathLookupKeys } from './tools/path-utils'
import { getFiles, getImageFile } from './tools/read-files'
import { readUrl } from './tools/read-url'
import { runTerminalCommand } from './tools/run-terminal-command'
import type { TerminalCommandBroker } from './tools/run-terminal-command'

import type { CustomToolDefinition } from './custom-tool'
import type { RunState } from './run-state'
import type { FileFilter } from './tools/read-files'
import type { ServerAction } from '@codebuff/common/actions'
import type { FileReadWindow } from '@codebuff/common/types/contracts/client'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { ToolName } from '@codebuff/common/tools/constants'
import type { PublishedClientToolName } from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  AgentUsageData,
  ContextCompactionData,
} from '@codebuff/common/types/contracts/llm'
import type { TraceWriter } from '@codebuff/common/types/contracts/trace'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { SessionState } from '@codebuff/common/types/session-state'
import type { SkillsMap } from '@codebuff/common/types/skill'
import type { Source } from '@codebuff/common/types/source'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

/**
 * Client-side replacements for the tools the SDK would otherwise execute
 * itself, keyed by tool name. `read_files` is EXCLUDED from the mapped half
 * and declared on its own because its signature differs: it answers a map of
 * path to content rather than a tool-result array. As an intersection with the
 * mapped half it was unsatisfiable — an implementation had to be assignable to
 * both signatures at once — which is why callers cast to `never`.
 */
export type OverrideToolHandlers = {
  [K in Exclude<PublishedClientToolName, 'read_files'>]?: (
    input: any,
  ) => Promise<ToolResultOutput[]>
} & {
  read_files?: (input: {
    filePaths: string[]
    /** Present only for `windowedFileReads` agents. An override that ignores
     *  it returns whole files, which is a cost regression rather than a
     *  correctness bug — but it is the whole point of the flag, so overrides
     *  on hosted surfaces window the content themselves (they hold the file
     *  before their own read budget truncates it). */
    fileWindows?: Record<string, FileReadWindow[]>
  }) => Promise<Record<string, string | null>>
}

function isRunPauseError(error: unknown) {
  return (
    !!error &&
    typeof error === 'object' &&
    (('codebuffRunPaused' in error &&
      (error as { codebuffRunPaused?: unknown }).codebuffRunPaused === true) ||
      ('name' in error &&
        (error as { name?: unknown }).name === 'CodebuffRunPausedError'))
  )
}

/** Remove the resolved credential and conventional provider variables before a
 * terminal tool inherits the host environment. This does not disable normal
 * user tooling network access; it only prevents an agent from reading BYOK
 * credentials through a subprocess. */
function scrubByokCredentialEnv(
  env: Record<string, string> | undefined,
  credential: string,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === credential || /(?:openrouter|openai|anthropic).*api.*key/i.test(key)) continue
    result[key] = value
  }
  return result
}

export type CodebuffClientOptions = {
  apiKey?: string
  /** Direct, local inference for this run. The key is intentionally runtime-only. */
  byok?: ResolvedByokConnection

  cwd?: string
  /** Optional directory path to load skills from. Skills found here will be available to the `skill` tool. */
  skillsDir?: string
  /**
   * Supplies the run's skills instead of the default local-filesystem walk.
   *
   * Set this when the repo being acted on is NOT on the machine running this
   * SDK — the default loader reads this machine's disk, which for a
   * server-embedded runner means the server's own files. See
   * `InitialSessionStateOptions.skillsLoader` in ./run-state.ts.
   */
  skillsLoader?: () => Promise<SkillsMap>
  /**
   * Also load the user's `~/.claude/skills` and `~/.agents/skills`. Defaults
   * to false. Set it only in a process that BELONGS to that user — an
   * interactive CLI on their own machine. Anything server-side must leave it
   * unset. See `LoadSkillsOptions.includeHomeSkills`.
   */
  includeHomeSkills?: boolean
  projectFiles?: Record<string, string>
  /** Precomputed index for exactly these `projectFiles` (build it with
   *  `computeProjectIndexFromFiles`). Skips the per-run tree-sitter parse;
   *  ignored when `projectFiles` is absent. */
  projectIndex?: ComputedProjectIndex
  knowledgeFiles?: Record<string, string>
  agentDefinitions?: AgentDefinition[]
  maxAgentSteps?: number
  env?: Record<string, string>
  /** Optional host process boundary that keeps terminal tools away from an
   * interactive console. Headless consumers can omit it. */
  terminalCommandBroker?: TerminalCommandBroker

  handleEvent?: (event: PrintModeEvent) => void | Promise<void>
  handleStreamChunk?: (
    chunk:
      | string
      | {
          type: 'subagent_chunk'
          agentId: string
          agentType: string
          chunk: string
        }
      | {
          type: 'reasoning_chunk'
          agentId: string
          ancestorRunIds: string[]
          chunk: string
        },
  ) => void | Promise<void>

  /** Optional filter to classify files before reading (runs before gitignore check) */
  fileFilter?: FileFilter

  overrideTools?: OverrideToolHandlers
  customToolDefinitions?: CustomToolDefinition[]

  fsSource?: Source<CodebuffFileSystem>
  spawnSource?: Source<CodebuffSpawn>
  logger?: Logger
  /** Optional debug trace of agent message histories. Called with the full
   *  history at each agent step boundary; implementations should append each
   *  message once (see TraceWriter). */
  traceWriter?: TraceWriter
}

export type ImageContent = {
  type: 'image'
  image: string // base64 encoded
  mediaType: string
}

export type TextContent = {
  type: 'text'
  text: string
}

export type MessageContent = TextContent | ImageContent

export type RunOptions = {
  agent: string | AgentDefinition
  prompt: string
  /** End user represented by this run. Trusted service accounts may use this
   *  to run on behalf of a signed-in user; ordinary API keys cannot delegate. */
  userId?: string
  /** Content array for multimodal messages (text + images) */
  content?: MessageContent[]
  params?: Record<string, any>
  previousRun?: RunState
  extraToolResults?: ToolMessage[]
  signal?: AbortSignal
  /** Optional steering hook. Drained at each agent step boundary during the run;
   * any returned texts are appended to the conversation as user prompts (and keep
   * the turn going) before the next LLM call. Lets a host inject messages into a
   * running agent without aborting — i.e. "steer" it, as opposed to queuing a new
   * prompt for after the turn finishes. */
  drainSteeringMessages?: () => string[]
  costMode?: string
  /** Extra key/values merged into each LLM request's `codebuff_metadata`.
   *  Used by hosts (e.g. the CLI) to forward client-scoped identifiers like
   *  `freebuff_instance_id` that server-side gates read from the request body. */
  extraCodebuffMetadata?: Record<string, string>
  /** Optional checkpoint hook. Called once when the run starts and then
   * periodically while it is in flight, with a RunState snapshot that
   * preserves all progress so far (the user's prompt plus any completed
   * agent steps, ending with an interruption note). Hosts can persist these
   * snapshots so that a killed process (closed terminal, crash) does not
   * lose the in-flight turn. The final resolved RunState supersedes any
   * snapshot; no snapshots are emitted after the run settles. */
  onStateSnapshot?: (runState: RunState) => void
  /** Provider-reported usage for each root-agent model request. */
  onUsage?: (usage: AgentUsageData) => void
  /** A model request ended before an exact provider usage receipt arrived. */
  onUsageIncomplete?: () => void
  /** Mechanical context compaction performed by the root agent runtime. */
  onCompaction?: (data: ContextCompactionData) => void
}

/** How often onStateSnapshot fires while a run is in flight. */
const STATE_SNAPSHOT_INTERVAL_MS = 5_000

export const STATE_SNAPSHOT_INTERRUPTION_MESSAGE =
  'The session ended before this response completed. Partial progress has been preserved.'

/**
 * Copy a SessionState for a checkpoint / cancellation snapshot: the caller
 * appends an interruption message and must not disturb the live session.
 *
 * lodash cloneDeep of the whole session is expensive — ~230ms on an ~8 MB
 * session — and this runs on the CLI's render/input thread every ~5s at each
 * in-flight snapshot, a major source of long-session freezes.
 *
 * Only mainAgentState needs an independent copy: the mutations that would
 * otherwise bleed into an already-captured snapshot all live there —
 * messageHistory (.push), agentContext subgoals (update_subgoal). We copy it
 * with a JSON round-trip, which is ~50x faster than cloneDeep (~4ms). The
 * snapshot is only ever consumed as JSON — persisted to disk, and re-serialized
 * when fed back as previousRunState — so a JSON round-trip is byte-for-byte
 * parity with the prior cloneDeep→JSON.stringify path. It also can't choke on
 * the URL / Buffer / Uint8Array instances the message schema permits in
 * image/file content (structuredClone throws on URL and rewrites
 * Buffer→Uint8Array; both change the persisted bytes or fall back).
 *
 * fileContext is large, effectively read-only during a run, and already
 * persisted as-is, so we share it by reference rather than copy it.
 *
 * Falls back to cloneDeep only if JSON.stringify throws (circular refs /
 * BigInt — which AgentState isn't expected to contain, as it uses IDs rather
 * than object back-refs) so a snapshot — or the final error state, which shares
 * this path — can never fail to build.
 */
export function cloneSessionState(
  state: SessionState,
  logger?: Logger,
): SessionState {
  let mainAgentState: SessionState['mainAgentState']
  try {
    mainAgentState = JSON.parse(JSON.stringify(state.mainAgentState))
  } catch (error) {
    logger?.debug?.(
      { error: error instanceof Error ? error.message : String(error) },
      'JSON clone of mainAgentState failed; falling back to cloneDeep',
    )
    mainAgentState = cloneDeep(state.mainAgentState)
  }
  return { fileContext: state.fileContext, mainAgentState }
}

/**
 * The session state a cancelled or errored turn persists, and the state a
 * follow-up prompt resumes from.
 *
 * This is the LAST thing that edits the history — after the runtime's
 * end-of-turn recount, not before it. It drops the half-step an interrupted
 * turn can leave behind and appends the message explaining why the turn ended,
 * so `contextTokenCount` has to follow: a count taken before these edits
 * describes a history that was never stored, and the host shows that number to
 * the user before their next message.
 *
 * The adjustment is a difference rather than a recount because the system
 * prompt and tool schemas — the other half of the count — are not in scope
 * here; carrying the delta keeps them exactly.
 */
export function buildCancelledSessionState(params: {
  sessionState: SessionState
  /** The runtime replaced the shared messageHistory, i.e. it got far enough to
   *  record the user's prompt itself. */
  runtimeMadeProgress: boolean
  /** The user's prompt, re-added only when the runtime never recorded it. */
  promptMessage?: Message
  /** Why the turn ended. Appended as a system-tagged user message. */
  message: string
  logger?: Logger
}): SessionState {
  const { sessionState, runtimeMadeProgress, promptMessage, message, logger } =
    params

  const state = cloneSessionState(sessionState, logger)
  const previousHistory = state.mainAgentState.messageHistory
  // A checkpoint can land after an assistant tool call is recorded but before
  // its result arrives. Drop that half-step at the persistence boundary so a
  // resumed run starts from structurally valid history.
  //
  // Copied unconditionally: dropUnansweredToolCalls returns its input when
  // there is nothing to drop, and the appends below must not reach the array
  // `previousHistory` names.
  const nextHistory = [...dropUnansweredToolCalls(previousHistory)]

  if (!runtimeMadeProgress && promptMessage) {
    nextHistory.push(promptMessage)
  }
  nextHistory.push({
    role: 'user' as const,
    content: [{ type: 'text' as const, text: withSystemTags(message) }],
  })

  state.mainAgentState.messageHistory = nextHistory
  state.mainAgentState.contextTokenCount = adjustContextTokenCountForHistoryEdit(
    {
      contextTokenCount: state.mainAgentState.contextTokenCount,
      previousHistory,
      nextHistory,
    },
  )
  return state
}

const createAbortError = (signal?: AbortSignal) => {
  if (signal?.reason instanceof Error) {
    return signal.reason
  }
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

type RunExecutionOptions = RunOptions &
  CodebuffClientOptions & {
    apiKey: string
    fingerprintId: string
  }
type RunReturnType = RunState

export async function run(options: RunExecutionOptions): Promise<RunState> {
  const requestedInference = options.byok
    ? { source: 'byok' as const, connectionId: options.byok.id, revision: options.byok.revision, model: options.byok.model }
    : { source: 'codebuff' as const }
  const previousInference = options.previousRun?.inference
  if (options.previousRun && !previousInference && options.byok) {
    return {
      sessionState: options.previousRun.sessionState,
      traceSessionId: options.previousRun.traceSessionId ?? crypto.randomUUID(),
      inference: undefined,
      output: { type: 'error', message: 'This session has no inference source pin; start a new BYOK task.' },
    }
  }
  // Hosted history can move to a personal provider once. A BYOK pin must never
  // return to hosted inference or silently change credentials on a resumed run.
  if (
    previousInference &&
    ((previousInference.source !== requestedInference.source &&
        !(previousInference.source === 'codebuff' && requestedInference.source === 'byok')) ||
      (previousInference.source === 'byok' &&
        requestedInference.source === 'byok' &&
        (previousInference.connectionId !== requestedInference.connectionId ||
          previousInference.revision !== requestedInference.revision ||
          previousInference.model !== requestedInference.model)))
  ) {
    return {
      sessionState: options.previousRun?.sessionState,
      traceSessionId: options.previousRun?.traceSessionId ?? crypto.randomUUID(),
      inference: previousInference,
      output: { type: 'error', message: 'This session is bound to a different inference connection; start a new task.' },
    }
  }
  const { signal } = options

  if (signal?.aborted) {
    const abortError = createAbortError(signal)
    return {
      sessionState: options.previousRun?.sessionState,
      traceSessionId:
        options.previousRun?.traceSessionId ?? crypto.randomUUID(),
      inference: requestedInference,
      output: {
        type: 'error',
        message: abortError.message,
      },
    }
  }

  const result = await runOnce({
    ...options,
    onStateSnapshot: options.onStateSnapshot
      ? (snapshot) =>
          options.onStateSnapshot?.({
            ...snapshot,
            inference: requestedInference,
          })
      : undefined,
  })
  return { ...result, inference: requestedInference }
}

async function runOnce({
  apiKey,
  fingerprintId,
  byok,

  cwd,
  skillsDir,
  skillsLoader,
  includeHomeSkills,
  projectFiles,
  projectIndex,
  knowledgeFiles,
  agentDefinitions,
  maxAgentSteps = MAX_AGENT_STEPS_DEFAULT,
  env,
  terminalCommandBroker,

  handleEvent,
  handleStreamChunk,

  fileFilter,
  overrideTools,
  customToolDefinitions,

  fsSource = () => require('fs').promises,
  spawnSource,
  logger,
  traceWriter,

  agent,
  prompt,
  userId: requestedUserId,
  content,
  params,
  previousRun,
  extraToolResults,
  signal,
  drainSteeringMessages,
  costMode,
  extraCodebuffMetadata,
  onStateSnapshot,
  onUsage,
  onUsageIncomplete,
  onCompaction,
}: RunExecutionOptions): Promise<RunState> {
  const fsSourceValue = typeof fsSource === 'function' ? fsSource() : fsSource
  const fs = await fsSourceValue
  let spawn: CodebuffSpawn
  if (spawnSource) {
    const spawnSourceValue = await spawnSource
    spawn = spawnSourceValue as CodebuffSpawn
  } else {
    spawn = require('child_process').spawn as CodebuffSpawn
  }
  let activeCustomToolDefinitions = customToolDefinitions ?? []
  // Never hand a provider credential to an agent subprocess. The credential is
  // only closed over by the model implementation below.
  const toolEnv = byok ? scrubByokCredentialEnv(env, byok.apiKey) : env

  // Init session state
  let agentId
  if (typeof agent !== 'string') {
    const clonedDefs = agentDefinitions ? cloneDeep(agentDefinitions) : []
    agentDefinitions = [...clonedDefs, agent]
    agentId = agent.id
  } else {
    agentId = agent
  }
  let sessionState: SessionState
  if (previousRun?.sessionState) {
    // applyOverridesToSessionState handles deep cloning and applying any provided overrides
    sessionState = await applyOverridesToSessionState(
      cwd,
      previousRun.sessionState,
      {
        knowledgeFiles,
        agentDefinitions,
        customToolDefinitions,
        projectFiles,
        projectIndex,
        maxAgentSteps,
      },
    )
  } else {
    // No previous run, so create a fresh session state
    sessionState = await initialSessionState({
      cwd,
      skillsDir,
      skillsLoader,
      includeHomeSkills,
      knowledgeFiles,
      agentDefinitions,
      customToolDefinitions,
      projectFiles,
      projectIndex,
      maxAgentSteps,
      fs,
      spawn,
      logger,
    })
  }
  const traceSessionId = previousRun?.traceSessionId ?? crypto.randomUUID()

  if (byok) {
    // The selected connection is a run snapshot. Apply its model to every
    // local helper/subagent template so no helper silently consumes Freebuff
    // inference or switches to a different provider.
    const limits = byokModelLimits(byok)
    for (const template of Object.values(sessionState.fileContext.agentTemplates)) {
      if (template && typeof template === 'object') {
        const byokTemplate = template as {
          model?: string
          compactContext?: boolean | Record<string, unknown>
        }
        byokTemplate.model = byok.model
        byokTemplate.compactContext = {
          ...(typeof byokTemplate.compactContext === 'object'
            ? byokTemplate.compactContext
            : {}),
          maxContextLength: limits.maxContextLength,
        }
      }
    }
  }

  for (const toolName of COMPOSIO_META_TOOL_NAMES) {
    delete sessionState.fileContext.customToolDefinitions[toolName]
  }

  let resolvePromise: (value: RunReturnType) => any = () => {}
  let _reject: (error: any) => any = () => {}
  const promise = new Promise<RunReturnType>((res, rej) => {
    resolvePromise = res
    _reject = rej
  })

  // Snapshot support: stop emitting the moment the run settles so a late
  // snapshot can never overwrite the final state persisted by the host.
  let settled = false
  let snapshotTimer: ReturnType<typeof setInterval> | null = null
  const resolve = (value: RunReturnType) => {
    settled = true
    if (snapshotTimer !== null) {
      clearInterval(snapshotTimer)
      snapshotTimer = null
    }
    resolvePromise(value)
  }

  async function onError(error: { message: string }) {
    if (handleEvent) {
      await handleEvent({ type: 'error', message: error.message })
    }
  }

  // The agent runtime mutates sessionState.mainAgentState as it progresses,
  // replacing messageHistory with a new array once it adds the user prompt.
  // Comparing array identity detects progress more robustly than length:
  // context pruning could shrink history below its starting length without
  // meaning the runtime never ran.
  let initialMessageHistory = sessionState.mainAgentState.messageHistory

  /** Calculates the current session state if cancelled.
   *
   * This is used when callMainPrompt throws an error. If the agent runtime made
   * any progress (replaced the shared messageHistory), those messages are
   * preserved. Otherwise the user's message is added so it isn't lost.
   */
  function getCancelledSessionState(message: string): SessionState {
    const runtimeMadeProgress =
      sessionState.mainAgentState.messageHistory !== initialMessageHistory

    return buildCancelledSessionState({
      sessionState,
      runtimeMadeProgress,
      // Only add the user's message if the runtime didn't get a chance to.
      promptMessage:
        prompt || content
          ? {
              role: 'user' as const,
              content: buildUserMessageContent(prompt, params, content),
              tags: ['USER_PROMPT'] as string[],
            }
          : undefined,
      message,
      logger,
    })
  }
  function getCancelledRunState(message?: string): RunState {
    message = message ?? 'Run cancelled by user.'
    return {
      sessionState: getCancelledSessionState(message),
      traceSessionId,
      output: {
        type: 'error',
        message,
      },
    }
  }

  const onResponseChunk = async (
    action: ServerAction<'response-chunk'>,
  ): Promise<void> => {
    if (signal?.aborted) {
      return
    }
    const { chunk } = action

    if (typeof chunk !== 'string') {
      if (chunk.type === 'reasoning_delta') {
        handleStreamChunk?.({
          type: 'reasoning_chunk',
          chunk: chunk.text,
          // The agent's stable id (matches subagent_start/subagent_chunk), so
          // subagent reasoning attributes to the right agent. (Previously this
          // forwarded runId, which no consumer's agent map is keyed by.)
          agentId: chunk.agentId,
          ancestorRunIds: chunk.ancestorRunIds,
        })
      } else {
        await handleEvent?.(chunk)
      }
      return
    }

    if (handleStreamChunk) {
      await handleStreamChunk(chunk)
    }
  }
  const onSubagentResponseChunk = async (
    action: ServerAction<'subagent-response-chunk'>,
  ) => {
    if (signal?.aborted) {
      return
    }
    const { agentId, agentType, chunk } = action

    if (handleStreamChunk && chunk) {
      await handleStreamChunk({
        type: 'subagent_chunk',
        agentId,
        agentType,
        chunk,
      })
    }
  }

  const agentRuntimeImpl = getAgentRuntimeImpl({
    logger,
    traceWriter,
    apiKey,
    byok,
    handleStepsLogChunk: () => {
      // Does nothing for now
    },
    requestToolCall: async ({ userInputId, toolName, input, mcpConfig }) => {
      return handleToolCall({
        action: {
          type: 'tool-call-request',
          requestId: crypto.randomUUID(),
          userInputId,
          toolName,
          input,
          timeout: undefined,
          mcpConfig,
        },
        overrides: overrideTools ?? {},
        customToolDefinitions: activeCustomToolDefinitions
          ? Object.fromEntries(
              activeCustomToolDefinitions.map((def) => [def.toolName, def]),
            )
          : {},
        cwd,
        fs,
        env: toolEnv,
        terminalCommandBroker,
        apiKey,
        byok,
        signal,
      })
    },
    requestMcpToolData: async ({ mcpConfig, toolNames }) => {
      const mcpClientId = await getMCPClient(mcpConfig)
      const listToolsResult = await listMCPTools(mcpClientId)
      const tools = listToolsResult.tools
      const filteredTools: typeof tools = []
      for (const tool of tools) {
        if (!toolNames) {
          filteredTools.push(tool)
          continue
        }
        if (toolNames.includes(tool.name)) {
          filteredTools.push(tool)
          continue
        }
      }

      return filteredTools
    },
    requestFiles: ({ filePaths, fileWindows }) =>
      readFiles({
        filePaths,
        fileWindows,
        override: overrideTools?.read_files,
        fileFilter,
        cwd,
        fs,
      }),
    // Only a local read can return an image's bytes. An override reads a
    // remote workspace through the text-only contract, so it keeps images.
    requestImageFile: overrideTools?.read_files
      ? undefined
      : ({ filePath }) =>
          getImageFile({
            filePath,
            cwd: requireCwd(cwd, 'read_files'),
            fs,
            fileFilter,
          }),
    requestOptionalFile: async ({ filePath }) => {
      const files = await readFiles({
        filePaths: [filePath],
        override: overrideTools?.read_files,
        fileFilter,
        cwd,
        fs,
        // str_replace/write_file use this path to compute edits. A truncated
        // read makes exact matches later in large files impossible.
        limitContent: false,
        enforceEnvPolicy: false,
      })
      const lookupKeys = cwd
        ? getProjectPathLookupKeys(cwd, filePath)
        : [filePath]
      const fileKey = lookupKeys.find((key) => key in files)
      return toOptionalFile(fileKey === undefined ? null : files[fileKey]!)
    },
    sendAction: ({ action }) => {
      if (action.type === 'action-error') {
        onError({ message: action.message })
        return
      }
      if (action.type === 'response-chunk') {
        onResponseChunk(action)
        return
      }
      if (action.type === 'subagent-response-chunk') {
        onSubagentResponseChunk(action)
        return
      }
      if (action.type === 'prompt-response') {
        handlePromptResponse({
          action,
          resolve,
          onError,
          initialSessionState: sessionState,
          traceSessionId,
        })
        return
      }
      if (action.type === 'prompt-error') {
        handlePromptResponse({
          action,
          resolve,
          onError,
          initialSessionState: sessionState,
          traceSessionId,
        })
        return
      }
    },
    sendSubagentChunk: ({
      userInputId,
      agentId,
      agentType,
      chunk,
      prompt,
      forwardToPrompt = true,
    }) => {
      onSubagentResponseChunk({
        type: 'subagent-response-chunk',
        userInputId,
        agentId,
        agentType,
        chunk,
        prompt,
        forwardToPrompt,
      })
    },
  })

  const promptId = Math.random().toString(36).substring(2, 15)

  // Send input. The lookup rides the run's signal: a socket that never answers here held the run
  // for the whole retry budget with the abort unable to reach it.
  let userId: string | undefined
  if (byok) {
    // BYOK is intentionally auth-free: no Codebuff identity, run ledger,
    // token-count, analytics, or helper request is necessary for inference.
    userId = requestedUserId ?? 'byok-local'
  } else {
    let userInfo: { id: string } | null
    try {
      userInfo = await getUserInfoFromApiKey({
        ...agentRuntimeImpl,
        apiKey,
        fields: ['id'],
        signal,
      })
    } catch (error) {
      if (signal?.aborted) return getCancelledRunState('Run cancelled by user.')
      throw error
    }
    if (!userInfo) return getCancelledRunState('Invalid API key or user not found')
    userId = requestedUserId ?? userInfo.id
  }

  if (signal?.aborted) {
    return getCancelledRunState('Run cancelled by user.')
  }

  if (onStateSnapshot) {
    // The runtime replaces mainAgentState.messageHistory with a new array at
    // each step boundary, so reference identity is a cheap "has anything
    // durable changed" check. Skipping unchanged ticks avoids deep-cloning a
    // potentially multi-MB sessionState every interval while the run is just
    // waiting on a slow LLM call.
    let lastSnapshotHistory: unknown = null
    const emitStateSnapshot = () => {
      if (settled || signal?.aborted) {
        return
      }
      const history = sessionState.mainAgentState.messageHistory
      if (history === lastSnapshotHistory) {
        return
      }
      lastSnapshotHistory = history
      try {
        onStateSnapshot(
          getCancelledRunState(STATE_SNAPSHOT_INTERRUPTION_MESSAGE),
        )
      } catch (error) {
        logger?.debug?.(
          { error: error instanceof Error ? error.message : String(error) },
          'onStateSnapshot handler threw',
        )
      }
    }
    // Emit immediately so the user's prompt is checkpointed as soon as the
    // run starts, then keep checkpointing progress while it is in flight.
    emitStateSnapshot()
    snapshotTimer = setInterval(emitStateSnapshot, STATE_SNAPSHOT_INTERVAL_MS)
    // Don't let the checkpoint timer keep the host process alive.
    if (typeof (snapshotTimer as any).unref === 'function') {
      ;(snapshotTimer as any).unref()
    }
  }

  const report = <T>(callback: ((value: T) => void) | undefined) =>
    callback
      ? (value: T) => {
          try {
            callback(value)
          } catch (error) {
            agentRuntimeImpl.logger.debug?.(
              { error: error instanceof Error ? error.message : String(error) },
              'Run metrics handler threw',
            )
          }
        }
      : undefined
  const reportSignal = (callback: (() => void) | undefined) =>
    callback
      ? () => {
          try {
            callback()
          } catch (error) {
            agentRuntimeImpl.logger.debug?.(
              { error: error instanceof Error ? error.message : String(error) },
              'Run metrics handler threw',
            )
          }
        }
      : undefined

  const repoSnapshot = toRepoSnapshot(sessionState.fileContext?.gitChanges)

  callMainPrompt({
    ...agentRuntimeImpl,
    promptId,
    action: {
      type: 'prompt',
      promptId,
      prompt,
      promptParams: params,
      content,
      fingerprintId: fingerprintId,
      costMode: costMode ?? 'normal',
      sessionState,
      toolResults: extraToolResults ?? [],
      agentId,
    },
    drainSteeringMessages,
    repoUrl: undefined,
    repoId: undefined,
    clientSessionId: promptId,
    userId,
    extraCodebuffMetadata: {
      ...(extraCodebuffMetadata ?? {}),
      trace_session_id: traceSessionId,
      // Aggregate repository scale, collected once per thread by getGitChanges
      // (#2138) and reused on later turns. Sent as the allowlisted projection
      // so the legacy patch-content fields can never ride along.
      ...(repoSnapshot && { repo_snapshot: JSON.stringify(repoSnapshot) }),
    },
    signal: signal ?? new AbortController().signal,
    onAgentUsageReceived: report(onUsage),
    onAgentUsageIncomplete: reportSignal(onUsageIncomplete),
    onCompaction: report(onCompaction),
  }).catch((error) => {
    let errorMessage = isFetchIdleTimeoutError(error)
      ? FETCH_IDLE_TIMEOUT_USER_MESSAGE
      : isTransientNetworkError(error)
        ? TRANSIENT_NETWORK_ERROR_USER_MESSAGE
        : error instanceof Error
          ? error.message
          : String(error ?? '')
    const apiErrorDetails = extractApiErrorDetails(error)
    const statusCode = apiErrorDetails.statusCode ?? getErrorStatusCode(error)
    const {
      countryBlockReason,
      countryCode,
      errorCode,
      ipPrivacySignals,
      message: parsedMessage,
    } = apiErrorDetails
    if (parsedMessage) {
      errorMessage = parsedMessage
    }

    resolve({
      sessionState: getCancelledSessionState(errorMessage),
      traceSessionId,
      output: {
        type: 'error',
        message: errorMessage,
        ...(statusCode !== undefined && { statusCode }),
        ...(errorCode !== undefined && { error: errorCode }),
        ...(countryCode !== undefined && { countryCode }),
        ...(countryBlockReason !== undefined && { countryBlockReason }),
        ...(ipPrivacySignals !== undefined && { ipPrivacySignals }),
      },
    })
  })

  return promise
}

function requireCwd(cwd: string | undefined, toolName: string): string {
  if (!cwd) {
    throw new Error(
      `cwd is required for the ${toolName} tool. Please provide cwd in CodebuffClientOptions or override the ${toolName} tool.`,
    )
  }
  return cwd
}

async function readFiles({
  filePaths,
  fileWindows,
  override,
  fileFilter,
  cwd,
  fs,
  limitContent,
  enforceEnvPolicy = true,
}: {
  filePaths: string[]
  fileWindows?: Record<string, FileReadWindow[]>
  override?: NonNullable<
    Required<CodebuffClientOptions>['overrideTools']['read_files']
  >
  fileFilter?: FileFilter
  cwd?: string
  fs: CodebuffFileSystem
  limitContent?: boolean
  enforceEnvPolicy?: boolean
}) {
  if (override) {
    // Windows are forwarded, not applied here: an override reads from a remote
    // workspace and applies its own output budget, so windowing after it has
    // already truncated a large file would answer an offset past the cut-off
    // with "beyond the end of the file". The override windows before its own
    // limiter, in the same order the local path does.
    if (!enforceEnvPolicy) {
      return await override({
        filePaths,
        ...(fileWindows ? { fileWindows } : {}),
      })
    }

    const result = Object.create(null) as Record<string, string | null>
    const readablePaths: string[] = []
    for (const filePath of filePaths) {
      if (!filePath) continue
      if (isSensitiveEnvFilePath(filePath)) {
        result[filePath] = FILE_READ_STATUS.IGNORED
      } else {
        readablePaths.push(filePath)
      }
    }
    if (readablePaths.length > 0) {
      const loadedFiles = await override({
        filePaths: readablePaths,
        ...(fileWindows ? { fileWindows } : {}),
      })
      if (
        !loadedFiles ||
        typeof loadedFiles !== 'object' ||
        Array.isArray(loadedFiles)
      ) {
        return { ...result }
      }
      for (const [filePath, content] of Object.entries(loadedFiles)) {
        result[filePath] = isSensitiveEnvFilePath(filePath)
          ? FILE_READ_STATUS.IGNORED
          : content
      }
    }
    return { ...result }
  }
  return getFiles({
    filePaths,
    cwd: requireCwd(cwd, 'read_files'),
    fs,
    fileWindows,
    fileFilter,
    limitContent,
    enforceEnvPolicy,
  })
}

async function handleToolCall({
  action,
  overrides,
  customToolDefinitions,
  cwd,
  fs,
  env,
  terminalCommandBroker,
  apiKey,
  byok,
  signal,
}: {
  action: ServerAction<'tool-call-request'>
  overrides: NonNullable<CodebuffClientOptions['overrideTools']>
  customToolDefinitions: Record<string, CustomToolDefinition>
  cwd?: string
  fs: CodebuffFileSystem
  env?: Record<string, string>
  terminalCommandBroker?: TerminalCommandBroker
  apiKey: string
  byok?: ResolvedByokConnection
  signal?: AbortSignal
}): Promise<{ output: ToolResultOutput[] }> {
  const toolName = action.toolName
  const input = action.input

  if (
    byok &&
    ['web_search', 'read_docs', 'gravity_index', 'render_ui'].includes(toolName)
  ) {
    return {
      output: [{ type: 'json', value: { errorMessage: `${toolName} is unavailable in a direct BYOK run` } }],
    }
  }

  if (signal?.aborted) {
    return {
      output: [
        {
          type: 'json',
          value: {
            message: 'Tool call cancelled: the run was aborted by the user.',
          },
        },
      ],
    }
  }

  // Handle MCP tool calls when mcpConfig is present
  if (action.mcpConfig) {
    try {
      const mcpClientId = await getMCPClient(action.mcpConfig)
      const result = await callMCPTool(
        mcpClientId,
        {
          name: toolName,
          arguments: input,
        },
        undefined,
        signal ? { signal } : undefined,
      )
      return { output: result }
    } catch (error) {
      return {
        output: [
          {
            type: 'json',
            value: {
              errorMessage:
                error instanceof Error ? error.message : String(error),
            },
          },
        ],
      }
    }
  }

  let result: ToolResultOutput[]
  if (toolNames.includes(toolName as ToolName)) {
    clientToolCallSchema.parse(action)
  } else {
    const customToolHandler = customToolDefinitions[toolName]

    if (!customToolHandler) {
      throw new Error(
        `Custom tool handler not found for user input ID ${action.userInputId}`,
      )
    }
    return {
      output: await customToolHandler.execute(action.input),
    }
  }

  try {
    let override = overrides[toolName as PublishedClientToolName]
    if (
      !override &&
      (toolName === 'str_replace' || toolName === 'apply_patch')
    ) {
      // Reuse the write_file override for file editing tools.
      override = overrides['write_file']
    }
    if (override) {
      // Note: This type assertion is necessary because TypeScript cannot narrow
      // the union type of all possible tool inputs based on the dynamic toolName.
      // The input has been validated by clientToolCallSchema.parse above.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = await override(input as any)
    } else if (toolName === 'end_turn') {
      result = [{ type: 'json', value: { message: 'Turn ended.' } }]
    } else if (toolName === 'write_file' || toolName === 'str_replace') {
      result = await changeFile({
        parameters: input,
        cwd: requireCwd(cwd, toolName),
        fs,
      })
    } else if (toolName === 'apply_patch') {
      result = await applyPatchTool({
        parameters: input,
        cwd: requireCwd(cwd, toolName),
        fs,
      })
    } else if (toolName === 'run_terminal_command') {
      const resolvedCwd = requireCwd(cwd, 'run_terminal_command')
      result = await runTerminalCommand({
        ...input,
        cwd: path.resolve(resolvedCwd, input.cwd ?? '.'),
        env,
        scrubEnvironmentKeys: byok
          ? [
              'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
              ...(byok.credentialRef.startsWith('env:')
                ? [byok.credentialRef.slice(4)]
                : []),
            ]
          : undefined,
        scrubEnvironmentValues: byok ? [byok.apiKey] : undefined,
        signal,
        terminalCommandBroker,
      } as Parameters<typeof runTerminalCommand>[0])
    } else if (toolName === 'read_url') {
      result = await readUrl({
        ...(input as Parameters<typeof readUrl>[0]),
        signal,
      })
    } else if (toolName === 'code_search') {
      result = await codeSearch({
        projectPath: requireCwd(cwd, 'code_search'),
        ...input,
        signal,
      } as Parameters<typeof codeSearch>[0])
    } else if (toolName === 'list_directory') {
      result = await listDirectory({
        directoryPath: (input as { path: string }).path,
        projectPath: requireCwd(cwd, 'list_directory'),
        fs,
      })
    } else if (toolName === 'glob') {
      const globInput = input as {
        pattern: string
        cwd?: string
        max_results?: number
      }
      result = await glob({
        pattern: globInput.pattern,
        projectPath: requireCwd(cwd, 'glob'),
        cwd: globInput.cwd,
        maxResults: globInput.max_results,
        fs,
      })
    } else if (toolName === 'run_file_change_hooks') {
      // No-op: SDK doesn't run file change hooks
      result = [
        {
          type: 'json',
          value: {
            message: 'File change hooks are not supported in SDK mode',
          },
        },
      ]
    } else if (isComposioMetaToolName(toolName)) {
      if (byok) {
        throw new Error('Composio tools are unavailable in a direct BYOK run')
      }
      result = await executeComposioToolViaServer({
        apiKey,
        toolName,
        input,
      })
    } else {
      throw new Error(
        `Tool not implemented in SDK. Please provide an override or modify your agent to not use this tool: ${toolName}`,
      )
    }
  } catch (error) {
    if (isRunPauseError(error)) {
      throw error
    }

    result = [
      {
        type: 'json',
        value: {
          errorMessage:
            error &&
            typeof error === 'object' &&
            'message' in error &&
            typeof error.message === 'string'
              ? error.message
              : typeof error === 'string'
                ? error
                : 'Unknown error',
        },
      },
    ]
  }
  return {
    output: result,
  }
}

/**
 * Extracts an HTTP status code from an error message string.
 * Parses common error patterns to identify the underlying status code.
 * Returns the status code if found, undefined otherwise.
 */
export const extractStatusCodeFromMessage = (
  errorMessage: string,
): number | undefined => {
  const lowerMessage = errorMessage.toLowerCase()

  // AI SDK's built-in retry error (e.g., "Failed after 4 attempts. Last error: Service Unavailable")
  // The AI SDK already retried 4 times, but we still want our SDK wrapper to retry 3 more times
  if (
    lowerMessage.includes('failed after') &&
    lowerMessage.includes('attempts')
  ) {
    // Extract the underlying error type from the message
    if (lowerMessage.includes('service unavailable')) {
      return 503
    }
    if (lowerMessage.includes('timeout')) {
      return 408
    }
    if (lowerMessage.includes('connection refused')) {
      return 503
    }
    // Default to 500 for other AI SDK retry failures
    return 500
  }

  if (
    errorMessage.includes('503') ||
    lowerMessage.includes('service unavailable')
  ) {
    return 503
  }
  if (errorMessage.includes('504')) {
    return 504
  }
  if (errorMessage.includes('502')) {
    return 502
  }
  if (lowerMessage.includes('timeout') || errorMessage.includes('408')) {
    return 408
  }
  if (
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('connection refused')
  ) {
    return 503
  }
  if (lowerMessage.includes('dns') || lowerMessage.includes('enotfound')) {
    return 503
  }
  if (lowerMessage.includes('server error') || errorMessage.includes('500')) {
    return 500
  }
  if (errorMessage.includes('429') || lowerMessage.includes('rate limit')) {
    return 429
  }
  if (
    lowerMessage.includes('network error') ||
    lowerMessage.includes('fetch failed')
  ) {
    return 503
  }

  return undefined
}

async function handlePromptResponse({
  action,
  resolve,
  onError,
  initialSessionState,
  traceSessionId,
}: {
  action: ServerAction<'prompt-response'> | ServerAction<'prompt-error'>
  resolve: (value: RunReturnType) => any
  onError: (error: { message: string }) => void
  initialSessionState: SessionState
  traceSessionId: string
}) {
  if (action.type === 'prompt-error') {
    onError({ message: action.message })

    const statusCode = extractStatusCodeFromMessage(action.message)
    resolve({
      sessionState: initialSessionState,
      traceSessionId,
      output: {
        type: 'error',
        message: action.message,
        ...(statusCode !== undefined && { statusCode }),
      },
    })
  } else if (action.type === 'prompt-response') {
    // Stop enforcing session state schema! It's a black box we will pass back to the server.
    // Only check the output schema.
    const parsedOutput = AgentOutputSchema.safeParse(action.output)
    if (!parsedOutput.success) {
      const message = [
        'Received invalid prompt response from server:',
        JSON.stringify(parsedOutput.error.issues),
        'If this issues persists, please contact support@codebuff.com',
      ].join('\n')
      onError({ message })
      resolve({
        sessionState: initialSessionState,
        traceSessionId,
        output: {
          type: 'error',
          message,
        },
      })
      return
    }
    const { sessionState, output } = action

    const state: RunState = {
      sessionState,
      traceSessionId,
      output: output ?? {
        type: 'error',
        message: 'No output from agent',
      },
    }
    resolve(state)
  } else {
    action satisfies never
    onError({
      message: 'Internal error: prompt response type not handled',
    })
    resolve({
      sessionState: initialSessionState,
      traceSessionId,
      output: {
        type: 'error',
        message: 'Internal error: prompt response type not handled',
      },
    })
  }
}
