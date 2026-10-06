// ===== JSON Types =====
export type JSONValue =
  | null
  | string
  | number
  | boolean
  | JSONObject
  | JSONArray

export type JSONObject = { [key: string]: JSONValue | undefined }

export type JSONArray = JSONValue[]

/**
 * JSON Schema definition (for prompt schema or output schema)
 */
export type JsonSchema = {
  type?:
    | 'object'
    | 'array'
    | 'string'
    | 'number'
    | 'boolean'
    | 'null'
    | 'integer'
  description?: string
  properties?: Record<string, JsonSchema | boolean>
  required?: string[]
  enum?: Array<string | number | boolean | null>
  [k: string]: unknown
}
export type JsonObjectSchema = JsonSchema & { type: 'object' }

// ===== Data Content Types =====
export type DataContent = string | Uint8Array | ArrayBuffer | Buffer

// ===== Provider Metadata Types =====
export type ProviderMetadata = Record<
  string,
  Record<string, JSONValue | undefined>
>

// ===== Content Part Types =====
export type TextPart = {
  type: 'text'
  text: string
  providerOptions?: ProviderMetadata
}

export type ImagePart = {
  type: 'image'
  image: DataContent
  mediaType?: string
  providerOptions?: ProviderMetadata
}

export type FilePart = {
  type: 'file'
  data: DataContent
  filename?: string
  mediaType: string
  providerOptions?: ProviderMetadata
}

export type ReasoningPart = {
  type: 'reasoning'
  text: string
  providerOptions?: ProviderMetadata
}

export type ToolCallPart = {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  providerOptions?: ProviderMetadata
  providerExecuted?: boolean
}

export type ToolResultOutput =
  | {
      type: 'json'
      value: JSONValue
    }
  | {
      type: 'media'
      data: string
      mediaType: string
    }

// ===== Message Types =====
export type AuxiliaryMessageData = {
  providerOptions?: ProviderMetadata
  tags?: string[]

  /**
   * Unix timestamp (ms) when the message was added to history.
   * Used to detect prompt cache expiry (>5 min gap = cache miss).
   * This field is stripped before sending to the LLM.
   */
  sentAt?: number

  /** @deprecated Use tags instead. */
  timeToLive?: 'agentStep' | 'userPrompt'
  /** @deprecated Use tags instead. */
  keepDuringTruncation?: boolean
  /** @deprecated Use tags instead. */
  keepLastTags?: string[]
}

export type SystemMessage = {
  role: 'system'
  content: TextPart[]
} & AuxiliaryMessageData

export type UserMessage = {
  role: 'user'
  content: (TextPart | ImagePart | FilePart)[]
} & AuxiliaryMessageData

export type AssistantMessage = {
  role: 'assistant'
  content: (TextPart | ReasoningPart | ToolCallPart)[]
} & AuxiliaryMessageData

export type ToolMessage = {
  role: 'tool'
  toolCallId: string
  toolName: string
  content: ToolResultOutput[]
} & AuxiliaryMessageData

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage

// ===== MCP Server Types =====

/**
 * MCP server configuration for stdio-based servers.
 *
 * Environment variables in `env` can be:
 * - A plain string value (hardcoded, e.g., `'production'`)
 * - A `$VAR_NAME` reference to read from local environment (e.g., `'$NOTION_TOKEN'`)
 *
 * The `$VAR_NAME` syntax reads from `process.env.VAR_NAME` at agent load time.
 * This keeps secrets out of your agent definitions - store them in `.env.local` instead.
 *
 * @example
 * ```typescript
 * env: {
 *   // Read NOTION_TOKEN from local .env file
 *   NOTION_TOKEN: '$NOTION_TOKEN',
 *   // Read MY_API_KEY from local env, pass as API_KEY to MCP server
 *   API_KEY: '$MY_API_KEY',
 *   // Hardcoded value (non-secret)
 *   NODE_ENV: 'production',
 * }
 * ```
 */
export type MCPConfig =
  | {
      type?: 'stdio'
      command: string
      args?: string[]
      env?: Record<string, string>
    }
  | {
      type?: 'http' | 'sse'
      url: string
      params?: Record<string, string>
      headers?: Record<string, string>
    }

// ============================================================================
// Logger Interface
// ============================================================================
export interface Logger {
  debug: (data: any, msg?: string) => void
  info: (data: any, msg?: string) => void
  warn: (data: any, msg?: string) => void
  error: (data: any, msg?: string) => void
}
