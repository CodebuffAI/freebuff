import type { Logger } from './logger'

export type MessageRow = {
  id: string
  user_id: string
  finished_at: Date
  created_at: Date
  request: unknown
  reasoning_text: string
  response: string
  output_tokens?: number | null
  reasoning_tokens?: number | null
  cost?: number | null
  upstream_inference_cost?: number | null
  input_tokens?: number | null
  cache_read_input_tokens?: number | null
  /**
   * Lookup columns (COD-753): what the admin trace viewer and the scripts
   * filter on, so they can read the text from BigQuery once Postgres stops
   * holding it. Added by scripts/migrate-bigquery-message-lookup-columns.ts.
   */
  client_request_id?: string | null
  client_id?: string | null
  agent_id?: string | null
  model?: string | null
  surface?: string | null
  provider?: string | null
}

export type InsertMessageBigqueryFn = (params: {
  row: MessageRow
  dataset?: string
  logger: Logger
}) => Promise<boolean>

/** Evidence stored in an assistant response trace's request JSON marker. */
export type ChatCompletionEvidence = {
  finish_reason: string | null
  /** Includes provider error frames and capture data-frame parse failures. */
  transport_status: 'complete' | 'error'
  /** Token usage as the client received it, minus `cost`/`cost_details`
   *  (our billed credits, not the provider's price). */
  usage?: Record<string, unknown>
}

export type ChatCompletionTraceRow = {
  id: string
  user_id: string
  client_id?: string | null
  trace_session_id: string
  trace_lineage_id: string
  run_id: string
  agent_id: string
  created_at: Date
  model: string
  cost_mode?: string | null
  request: unknown
  message_count: number
  message_start_index: number
  message_delta_count: number
  previous_message_count?: number | null
  common_prefix_length: number
  cache_hit: boolean
  full_snapshot: boolean
  messages: unknown[]
  delta_message_hashes: string[]
  tool_count: number
  tools?: unknown[] | null
  tools_omitted: boolean
  repo_snapshot?: unknown | null
  surface?: string | null
}

export type InsertChatCompletionTraceBigqueryFn = (params: {
  row: ChatCompletionTraceRow
  dataset?: string
  logger: Logger
}) => Promise<boolean>
