import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { getErrorObject } from '../util/error'

import type { MCPConfig } from '../types/mcp'
import type { ToolResultOutput } from '../types/messages/content-part'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  BlobResourceContents,
  CallToolResult,
  TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js'

// Cap on how much of a failed stdio server's stderr we retain for the error
// message — enough to show the real failure without unbounded growth.
const STDERR_BUFFER_CAP = 8192

const runningClients: Record<string, Client> = {}
const listToolsCache: Record<
  string,
  ReturnType<typeof Client.prototype.listTools>
> = {}

/**
 * Synchronously populated map from client ID to tool count, updated when
 * listMCPTools resolves. Used by the status API to avoid awaiting a promise
 * that may already be cached.
 */
const resolvedToolCounts: Record<string, number> = {}

/**
 * Maps client config hashes to sanitized error messages when a connection
 * attempt fails. Cleared on the next successful connection for that key.
 * Used by the /mcp CLI command to surface failures without reconnecting.
 */
const connectionErrors: Record<string, string> = {}

/**
 * Substitutes environment variable references ($VAR_NAME) in a string with their values.
 * Supports both simple replacement ("$VAR_NAME") and interpolation ("Bearer $VAR_NAME").
 */
function substituteEnvInValue(value: string): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, varName) => {
    const envValue = process.env[varName]
    if (envValue === undefined) {
      // Return original if env var not found
      return match
    }
    return envValue
  })
}

/**
 * Substitutes environment variable references in all values of a record.
 */
function substituteEnvInRecord(
  record: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = substituteEnvInValue(value)
  }
  return result
}

function hashConfig(config: MCPConfig): string {
  if (config.type === 'stdio') {
    return JSON.stringify({
      command: config.command,
      args: config.args,
      env: config.env,
    })
  }
  if (config.type === 'http') {
    return JSON.stringify({
      type: 'http',
      url: config.url,
      params: config.params,
    })
  }
  if (config.type === 'sse') {
    return JSON.stringify({
      type: 'sse',
      url: config.url,
      params: config.params,
    })
  }
  config.type satisfies never
  throw new Error(
    `Internal error in hashConfig: invalid MCP config type ${config.type}`,
  )
}

// Patterns whose presence in an error string indicates a credential/token
// value that should be redacted.
//
// This is intentionally conservative — patterns known to be safe are
// excluded; everything else that looks like a credential is replaced.
// URL regex for sanitizing user:password@host patterns
const URL_CREDENTIALS_PATTERN = /https?:\/\/[A-Za-z0-9_.~-]+:[A-Za-z0-9_.~!@#$%^&*()_+\-={}[\]\\|;:',.<>/?]+@/g

const SENSITIVE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI-style secret keys (sk-proj-xxx, sk-user-xxx)
  /ghp_[A-Za-z0-9]{36,}/g, // GitHub personal access tokens
  /gho_[A-Za-z0-9]{36,}/g, // GitHub OAuth tokens
  /github_pat_[A-Za-z0-9]{50,}/g, // GitHub fine-grained PATs
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, // Bearer tokens in headers
  /(^|\n)\s*Authorization['"]?\s*[:=]\s*.+/gi, // Authorization header lines
  /Basic\s+[A-Za-z0-9+/=]{8,}/g, // Basic auth tokens
  /api[_-]?key['"]?\s*[:=]\s*['"]?[A-Za-z0-9_/-]{16,}/gi, // api_key=... patterns
  /access_token['"]?\s*[:=]\s*['"]?[A-Za-z0-9_./-]{8,}/gi, // access_token patterns
  /refresh_token['"]?\s*[:=]\s*['"]?[A-Za-z0-9_./-]{8,}/gi, // refresh_token patterns
  /client_secret['"]?\s*[:=]\s*['"]?[A-Za-z0-9_./-]{8,}/gi, // client_secret patterns
  /token['"]?\s*[:=]\s*['"]?[A-Za-z0-9_./-]{8,}/gi, // token=... patterns
  /secret['"]?\s*[:=]\s*['"]?[A-Za-z0-9_./-]{8,}/gi, // secret=... patterns
  /password['"]?\s*[:=]\s*['"]?[A-Za-z0-9_@!$%&*+-]{4,}/gi, // password=... patterns
  /passwd['"]?\s*[:=]\s*['"]?[A-Za-z0-9_@!$%&*+-]{4,}/gi, // passwd=... patterns
  URL_CREDENTIALS_PATTERN, // https://user:pass@host URLs
]

export const REDACTED_PLACEHOLDER = '<REDACTED>'

/**
 * Sanitize a string for display by redacting any value that matches a
 * known credential pattern. Safe to call on user-facing error messages
 * and config values.
 *
 * This is a best-effort heuristic, not a cryptographic guarantee. If no
 * pattern matches, the value passes through unchanged.
 */
export function sanitizeErrorForDisplay(input: string): string {
  let result = input
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, REDACTED_PLACEHOLDER)
  }
  return result
}

/**
 * Truncate a string at the last safe boundary before `maxLength` chars.
 * Appends a truncation indicator.
 */
export const TRUNCATION_INDICATOR = '… (truncated)'

export function truncateError(
  input: string,
  maxLength: number = 2000,
): string {
  if (input.length <= maxLength) return input
  // Try to break at a newline or space boundary before maxLength
  const cutoff = input.lastIndexOf('\n', maxLength)
  const breakAt = cutoff > 0 ? cutoff : input.lastIndexOf(' ', maxLength)
  const endAt = breakAt > 0 ? breakAt : maxLength
  return input.slice(0, endAt) + '\n' + TRUNCATION_INDICATOR
}

export async function getMCPClient(config: MCPConfig): Promise<string> {
  let key = hashConfig(config)
  if (key in runningClients) {
    return key
  }

  let transport: Transport
  // Buffer the child process's stderr so that a server which crashes during
  // startup produces an actionable error instead of the opaque MCP SDK message
  // "MCP error -32000: Connection closed".
  let stderrBuffer = ''
  if (config.type === 'stdio') {
    const stdioTransport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: substituteEnvInRecord(config.env),
      stderr: 'pipe',
    })
    // When stderr is 'pipe' the SDK exposes a PassThrough immediately (before
    // the process is spawned), so attaching here captures even early output
    // from a child that dies during the connection handshake.
    stdioTransport.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBuffer.length < STDERR_BUFFER_CAP) {
        stderrBuffer += chunk.toString('utf8')
      }
    })
    transport = stdioTransport
  } else {
    const url = new URL(config.url)
    for (const [key, value] of Object.entries(config.params)) {
      url.searchParams.set(key, value)
    }
    const headers = substituteEnvInRecord(config.headers)
    if (config.type === 'http') {
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers,
        },
      })
    } else if (config.type === 'sse') {
      transport = new SSEClientTransport(url, {
        requestInit: {
          headers,
        },
      })
    } else {
      config.type satisfies never
      throw new Error(`Internal error: invalid MCP config type ${config.type}`)
    }
  }

  const client = new Client({
    name: 'codebuff',
    version: '1.0.0',
  })

  try {
    await client.connect(transport)
  } catch (error) {
    const baseMessage = getErrorObject(error).message
    const enrichedError = (() => {
      if (config.type === 'stdio') {
        const commandStr = [config.command, ...(config.args ?? [])].join(' ')
        const detail = stderrBuffer.trim()
        return new Error(
          `${baseMessage}. Failed to start MCP server via \`${commandStr}\`. ` +
            `Ensure the command is installed and runnable (e.g. an up-to-date ` +
            `node/npm/npx, or python/uvx) and that any required env vars are set.` +
            (detail ? `\nServer stderr:\n${detail}` : ''),
        )
      }
      return new Error(
        `${baseMessage}. Failed to connect to MCP server at ${config.url}.`,
      )
    })()

    // Store a sanitized version for the /mcp status command without
    // breaking the existing throw contract
    connectionErrors[key] = sanitizeErrorForDisplay(enrichedError.message)
    throw enrichedError
  }
  runningClients[key] = client

  return key
}

export function listMCPTools(
  clientId: string,
  ...args: Parameters<typeof Client.prototype.listTools>
): ReturnType<typeof Client.prototype.listTools> {
  const client = runningClients[clientId]
  if (!client) {
    throw new Error(`listTools: client not found with id: ${clientId}`)
  }
  if (!listToolsCache[clientId]) {
    const promise = client.listTools(...args)
    listToolsCache[clientId] = promise.then((result) => {
      resolvedToolCounts[clientId] = result.tools.length
      return result
    })
  }
  return listToolsCache[clientId]
}

function getResourceData(
  resource: TextResourceContents | BlobResourceContents,
): string {
  if ('text' in resource) return resource.text as string
  if ('blob' in resource) return resource.blob as string
  return ''
}

export async function callMCPTool(
  clientId: string,
  ...args: Parameters<typeof Client.prototype.callTool>
): Promise<ToolResultOutput[]> {
  const client = runningClients[clientId]
  if (!client) {
    throw new Error(`callTool: client not found with id: ${clientId}`)
  }
  const callResult = await client.callTool(...args)
  const result = callResult as CallToolResult
  const content = result.content

  return content.map((c: (typeof content)[number]) => {
    if (c.type === 'text') {
      return {
        type: 'json',
        value: c.text,
      } satisfies ToolResultOutput
    }
    if (c.type === 'audio') {
      return {
        type: 'media',
        data: c.data,
        mediaType: c.mimeType,
      } satisfies ToolResultOutput
    }
    if (c.type === 'image') {
      return {
        type: 'media',
        data: c.data,
        mediaType: c.mimeType,
      } satisfies ToolResultOutput
    }
    if (c.type === 'resource') {
      return {
        type: 'media',
        data: getResourceData(c.resource),
        mediaType: c.resource.mimeType ?? 'text/plain',
      } satisfies ToolResultOutput
    }
    const fallbackValue =
      'uri' in c && typeof (c as { uri: unknown }).uri === 'string'
        ? (c as { uri: string }).uri
        : JSON.stringify(c)
    return {
      type: 'json',
      value: fallbackValue,
    } satisfies ToolResultOutput
  })
}

// ---------------------------------------------------------------------------
// Public status API — used by the /mcp CLI command
// ---------------------------------------------------------------------------

/**
 * Runtime status snapshot for a single MCP server config.
 *
 * All fields are derived from module-level state that was already populated
 * by normal agent operation — no new connections are initiated.
 */
export type McpClientConnectionInfo = {
  /** Whether the client is currently connected */
  connected: boolean
  /** Number of discovered tools, or null if the tool list hasn't resolved yet */
  toolCount: number | null
  /** Sanitized error message from the last failed connection, or null */
  errorLabel: string | null
}

/**
 * Returns a readonly snapshot of the connection status for a single MCP
 * server configuration, without initiating any new connection.
 *
 * - `connected` — checked against the live `runningClients` map
 * - `toolCount` — populated lazily from the resolved `listTools` cache
 * - `errorLabel` — populated from the last failed `getMCPClient` attempt
 *
 * The returned object is a plain value type. Callers cannot mutate internal
 * module state through it.
 */
export function getMCPClientConnectionInfo(config: MCPConfig): McpClientConnectionInfo {
  const key = hashConfig(config)
  const connected = key in runningClients
  const toolCount = key in resolvedToolCounts ? resolvedToolCounts[key] : null
  const errorLabel = connected ? null : (key in connectionErrors ? connectionErrors[key] : null)
  return { connected, toolCount, errorLabel }
}
