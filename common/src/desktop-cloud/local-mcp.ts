import { z } from 'zod/v4'

/**
 * Local MCP servers: stdio commands and localhost URLs that run on one of the account's computers.
 * Desktop owns their configuration (`~/.agents/mcp.json`); Cloud only ever sees each computer's
 * published tool list, and reaches a tool through that computer's device connection
 * (docs/mcp-desktop/04-local-mcp-everywhere.md).
 */

export const LOCAL_MCP_SERVER_LIMIT = 30
export const LOCAL_MCP_TOOL_LIMIT = 200
/** Published lists larger than this are trimmed by Desktop, tool by tool, before they are sent. */
export const LOCAL_MCP_MANIFEST_BYTES = 256 * 1024
/** Desktop republishes well inside this; a computer that stops is forgotten after it. */
export const LOCAL_MCP_MANIFEST_TTL_MS = 3 * 60_000
export const LOCAL_MCP_REPUBLISH_MS = 60_000

/** `device:<deviceId>:<name>`: the id the agent passes back to call a local server's tool. */
export const LOCAL_MCP_SERVER_ID = /^device:([0-9a-f-]{36}):(.{1,80})$/

export const localMcpServerName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N} _.@-]+$/u, 'Use letters, numbers, spaces, dots, dashes or underscores')

export const localMcpTool = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(4000),
    inputSchema: z.record(z.string(), z.unknown()),
    annotations: z
      .object({
        readOnlyHint: z.boolean().optional(),
        destructiveHint: z.boolean().optional(),
      })
      .optional(),
  })
  .strip()
export type LocalMcpTool = z.infer<typeof localMcpTool>

export const localMcpManifest = z
  .object({
    servers: z
      .array(
        z
          .object({
            name: localMcpServerName,
            transport: z.enum(['stdio', 'http']),
            tools: z.array(localMcpTool).max(LOCAL_MCP_TOOL_LIMIT),
          })
          .strict(),
      )
      .max(LOCAL_MCP_SERVER_LIMIT),
  })
  .strict()
export type LocalMcpManifest = z.infer<typeof localMcpManifest>

/** One computer's servers, as Cloud lists them to the agent and to Integrations. */
export type LocalMcpDevice = {
  deviceId: string
  deviceName: string
  servers: LocalMcpManifest['servers']
}

/** Cloud asks a computer to run one of its local MCP tools. */
export const deviceLocalMcpCallRequest = z
  .object({
    method: z.literal('local_mcp_call'),
    server: localMcpServerName,
    tool: z.string().min(1).max(200),
    arguments: z.record(z.string(), z.unknown()),
    mode: z.enum(['plan', 'build']),
  })
  .strict()
export type DeviceLocalMcpCallRequest = z.infer<typeof deviceLocalMcpCallRequest>

/** What Integrations sends Desktop to add a server on this computer. */
export const localMcpAddInput = z
  .object({
    name: localMcpServerName,
    /** A command line (`npx -y @org/server --flag`) or a URL on this computer (`http://localhost:3845/mcp`). */
    target: z.string().trim().min(1).max(4096),
    /** `KEY=value` lines for a command's environment: the API keys most servers need. */
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192)).optional(),
  })
  .strict()
export type LocalMcpAddInput = z.infer<typeof localMcpAddInput>

/** A server on this computer, as Desktop shows it in Integrations. Never carries env values. */
export type LocalMcpServerView = {
  id: string
  name: string
  transport: 'stdio' | 'http'
  /** The command line or URL, for display. */
  target: string
  enabled: boolean
  status: 'connected' | 'connecting' | 'disconnected' | 'disabled' | 'error' | 'auth_required'
  toolCount: number
  error: string | null
}
