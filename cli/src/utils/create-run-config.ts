import path from 'path'

import { MAX_AGENT_STEPS_DEFAULT } from '@codebuff/common/constants/agents'
import { FREEBUFF_BASE3_AGENT_IDS } from '@codebuff/common/constants/free-agents'
import { isSensitiveEnvFilePath } from '@codebuff/common/util/env-file-path'

import {
  createEventHandler,
  createStreamChunkHandler,
} from './sdk-event-handlers'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { EventHandlerState, StreamChunkEvent } from './sdk-event-handlers'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  AgentDefinition,
  ConversationSummary,
  FileFilter,
  MessageContent,
  ResolvedByokConnection,
  RunState,
} from '@codebuff/sdk'

export type CreateRunConfigParams = {
  logger: Logger
  agent: AgentDefinition | string
  prompt: string
  content: MessageContent[] | undefined
  previousRunState: RunState | null
  agentDefinitions: AgentDefinition[]
  eventHandlerState: EventHandlerState
  signal: AbortSignal
  costMode?: 'free' | 'lite' | 'normal' | 'max' | 'experimental' | 'ask'
  /** Runtime-only direct inference credential. Never persist this object. */
  byok?: ResolvedByokConnection
  extraCodebuffMetadata?: Record<string, string>
  /** Periodic in-flight RunState checkpoints (see RunOptions.onStateSnapshot). */
  onStateSnapshot?: (runState: RunState) => void
  /** A background summary finished (see RunOptions.onCompactionSummary). */
  onCompactionSummary?: (summary: ConversationSummary) => void
  /** Mid-turn steering: drained by the agent loop at each step boundary;
   *  returned texts are appended as user prompts and keep the turn going
   *  (see RunOptions.drainSteeringMessages). */
  drainSteeringMessages?: () => string[]
  /** Best-effort native analytics observers, independent of UI projection. */
  observeEvent?: (event: PrintModeEvent) => void
  observeChunk?: (event: StreamChunkEvent) => void
}

const SENSITIVE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.crt',
  '.cer',
])
const SENSITIVE_BASENAMES = new Set([
  '.htpasswd',
  '.netrc',
  'credentials',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'auth.json',
  '.pypirc',
  'terraform.tfvars',
  '.terraformrc',
])

// Pattern matches (grouped by match type)
const SENSITIVE_PATTERNS = {
  prefix: ['id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa'], // SSH private keys
  suffix: ['_credentials'],
  substring: ['kubeconfig', '.tfstate'],
}

const matchesPattern = (str: string) =>
  SENSITIVE_PATTERNS.prefix.some(
    (p) => str.startsWith(p) && !str.endsWith('.pub'),
  ) ||
  SENSITIVE_PATTERNS.suffix.some((s) => str.endsWith(s)) ||
  SENSITIVE_PATTERNS.substring.some((sub) => str.includes(sub))

/**
 * Check if a file is a sensitive file that should be blocked from reading.
 */
export function isSensitiveFile(filePath: string): boolean {
  const basename = path.basename(filePath)
  const basenameLower = basename.toLowerCase()
  const ext = path.extname(filePath).toLowerCase()

  return (
    isSensitiveEnvFilePath(filePath) ||
    SENSITIVE_EXTENSIONS.has(ext) ||
    SENSITIVE_BASENAMES.has(basenameLower) ||
    matchesPattern(basenameLower)
  )
}

export const createRunConfig = (params: CreateRunConfigParams) => {
  const {
    logger,
    agent,
    prompt,
    content,
    previousRunState,
    agentDefinitions,
    eventHandlerState,
    costMode,
    byok,
    extraCodebuffMetadata,
    onStateSnapshot,
    onCompactionSummary,
    drainSteeringMessages,
  } = params

  const handleEvent = createEventHandler(eventHandlerState)
  const handleStreamChunk = createStreamChunkHandler(eventHandlerState)
  return {
    logger,
    agent,
    prompt,
    content,
    previousRun: previousRunState ?? undefined,
    agentDefinitions,
    // A base3 root uses the symbol index only for read_files' referencedBy,
    // which it does without (bench in #7364), so its new chats skip the parse.
    // base2, Codebuff and custom roots keep it; a chat that later switches to
    // one keeps the state it started with.
    skipSymbolIndex: FREEBUFF_BASE3_AGENT_IDS.has(
      typeof agent === 'string' ? agent : agent.id,
    ),
    maxAgentSteps: MAX_AGENT_STEPS_DEFAULT,
    handleStreamChunk: (event: StreamChunkEvent) => {
      handleStreamChunk(event)
      if (eventHandlerState.isActive?.() !== false) {
        try {
          params.observeChunk?.(event)
        } catch {
          // Analytics must not fail a run.
        }
      }
    },
    handleEvent: (event: PrintModeEvent) => {
      handleEvent(event)
      if (eventHandlerState.isActive?.() !== false) {
        try {
          params.observeEvent?.(event)
        } catch {
          // Analytics must not fail a run.
        }
      }
    },
    signal: params.signal,
    costMode,
    byok,
    extraCodebuffMetadata,
    onStateSnapshot,
    onCompactionSummary,
    drainSteeringMessages,
    fileFilter: ((filePath: string) => {
      if (isSensitiveFile(filePath)) return { status: 'blocked' }
      return { status: 'allow' }
    }) satisfies FileFilter,
  }
}
