import type {
  ProjectProfile,
  ProjectProfileReport,
} from '@codebuff/common/constants/project-profile'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { Logger } from '@codebuff/common/types/contracts/logger'

type User = {
  id: string
  email: string
  discord_id: string | null
  stripe_customer_id: string | null
  banned: boolean
  created_at: Date
}
export const userColumns = [
  'id',
  'email',
  'discord_id',
  'stripe_customer_id',
  'banned',
  'created_at',
] as const
export type UserColumn = keyof User
export type GetUserInfoFromApiKeyInput<T extends UserColumn> = {
  apiKey: string
  fields: readonly T[]
  logger: Logger
  /** ends the lookup, including its retries, when the caller's run is aborted */
  signal?: AbortSignal
}
export type GetUserInfoFromApiKeyOutput<T extends UserColumn> = Promise<
  | {
      [K in T]: User[K]
    }
  | null
>
export type GetUserInfoFromApiKeyFn = <T extends UserColumn>(
  params: GetUserInfoFromApiKeyInput<T>,
) => GetUserInfoFromApiKeyOutput<T>

export type GetUserInfoByIdInput<T extends UserColumn> = {
  userId: string
  fields: readonly T[]
}
export type GetUserInfoByIdFn = <T extends UserColumn>(
  params: GetUserInfoByIdInput<T>,
) => GetUserInfoFromApiKeyOutput<T>

type AgentRun = {
  agent_id: string
  ancestor_run_ids: string[]
  status: 'running' | 'completed' | 'failed' | 'cancelled'
}
export type AgentRunColumn = keyof AgentRun
export type GetAgentRunFromIdInput<T extends AgentRunColumn> = {
  runId: string
  userId: string
  fields: readonly T[]
}
export type GetAgentRunFromIdOutput<T extends AgentRunColumn> = Promise<
  | {
      [K in T]: AgentRun[K]
    }
  | null
>
export type GetAgentRunFromIdFn = <T extends AgentRunColumn>(
  params: GetAgentRunFromIdInput<T>,
) => GetAgentRunFromIdOutput<T>

/**
 * Fetch and validate an agent from the database by `publisher/agent-id[@version]` format
 */
export type FetchAgentFromDatabaseFn = (params: {
  apiKey: string
  parsedAgentId: {
    publisherId: string
    agentId: string
    version?: string
  }
  logger: Logger
}) => Promise<AgentTemplate | null>

export type StartAgentRunFn = (params: {
  apiKey: string
  userId?: string
  agentId: string
  ancestorRunIds: string[]
  logger: Logger
  /** ends the request, including its retries, when the caller's run is aborted */
  signal?: AbortSignal
}) => Promise<string | null>

export type FinishAgentRunFn = (params: {
  apiKey: string
  userId: string | undefined
  runId: string
  status: 'completed' | 'failed' | 'cancelled'
  totalSteps: number
  directCredits: number
  totalCredits: number
  errorMessage?: string
  logger: Logger
}) => Promise<void>

export type AddAgentStepFn = (params: {
  apiKey: string
  userId: string | undefined
  agentRunId: string
  stepNumber: number
  credits?: number
  childRunIds?: string[]
  messageId: string | null
  status?: 'running' | 'completed' | 'skipped'
  errorMessage?: string
  startTime: Date
  logger: Logger
}) => Promise<string | null>

export type GetProjectProfileFn = (params: {
  logger: Logger
  signal?: AbortSignal
}) => Promise<{ due: boolean; profile: ProjectProfile | null } | null>

export type ReportProjectProfileFn = (params: {
  report: ProjectProfileReport
  logger: Logger
  signal?: AbortSignal
}) => Promise<boolean>

export type DatabaseAgentCache = Map<string, AgentTemplate | null>
