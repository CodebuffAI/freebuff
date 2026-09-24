import { createHash } from 'crypto'

import { getErrorObject } from '@codebuff/common/util/error'
import { convertJsonSchemaToZod } from 'zod-from-json-schema'

import { MCP_TOOL_SEPARATOR } from './mcp-constants'

import type { AgentTemplate } from './templates/types'
import type { RequestMcpToolDataFn } from '@codebuff/common/types/contracts/client'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { OptionalFields } from '@codebuff/common/types/function-params'
import type {
  CustomToolDefinitions,
  ProjectFileContext,
} from '@codebuff/common/util/file'

/** What every provider accepts; OpenAI-compatible APIs also cap it at 64. */
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/
/** Names already valid up to this length are left byte-identical. */
const LEGACY_VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/

/**
 * The tool name the model sees for one MCP tool.
 *
 * `server__tool` exactly as before whenever that is already a legal name, so
 * nothing changes for the common case (no prompt-cache churn). A server key or
 * tool name carrying anything else (`.`, a space, `/`, `:`) used to produce a
 * name every provider rejects — "Invalid 'tools[89].name': string does not
 * match pattern" — failing the whole turn, every turn, for that user. Those are
 * sanitized, truncated with a stable hash when too long, and the caller records
 * the original server/tool on the definition (`mcpOrigin`) for execution.
 */
export function mcpExposedToolName(server: string, tool: string): string {
  const raw = server + MCP_TOOL_SEPARATOR + tool
  if (LEGACY_VALID_TOOL_NAME.test(raw)) return raw
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (VALID_TOOL_NAME.test(cleaned)) return cleaned
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8)
  return `${cleaned.slice(0, 55)}_${hash}`
}

export async function getMCPToolData(
  params: OptionalFields<
    {
      toolNames: AgentTemplate['toolNames']
      mcpServers: AgentTemplate['mcpServers']
      writeTo: ProjectFileContext['customToolDefinitions']
      requestMcpToolData: RequestMcpToolDataFn
      logger?: Logger
    },
    'writeTo'
  >,
): Promise<CustomToolDefinitions> {
  const withDefaults = { writeTo: {}, ...params }
  const { toolNames, mcpServers, writeTo, requestMcpToolData, logger } =
    withDefaults

  // User-facing toolNames use '/' as separator (e.g., 'supabase/list_tables')
  // but internally we use MCP_TOOL_SEPARATOR ('__') for LLM API compatibility
  const USER_INPUT_SEPARATOR = '/'
  const requestedToolsByMcp: Record<string, string[] | undefined> = {}
  for (const t of toolNames) {
    if (!t.includes(USER_INPUT_SEPARATOR)) {
      continue
    }
    const [mcpName, ...remaining] = t.split(USER_INPUT_SEPARATOR)
    const toolName = remaining.join(USER_INPUT_SEPARATOR)
    if (!requestedToolsByMcp[mcpName]) {
      requestedToolsByMcp[mcpName] = []
    }
    requestedToolsByMcp[mcpName].push(toolName)
  }

  const promises: Promise<any>[] = []
  for (const [mcpName, mcpConfig] of Object.entries(mcpServers)) {
    promises.push(
      (async () => {
        try {
          const mcpData = await requestMcpToolData({
            mcpConfig,
            toolNames: requestedToolsByMcp[mcpName] ?? null,
          })

          for (const { name, description, inputSchema } of mcpData) {
            const raw = mcpName + MCP_TOOL_SEPARATOR + name
            let exposed = mcpExposedToolName(mcpName, name)
            if (exposed !== raw && exposed in writeTo) {
              // Two originals sanitized to the same name: keep both callable.
              const hash = createHash('sha256').update(raw).digest('hex')
              exposed = `${exposed.slice(0, 55)}_${hash.slice(0, 8)}`
            }
            writeTo[exposed] = {
              inputSchema: convertJsonSchemaToZod(inputSchema as any) as any,
              endsAgentStep: true,
              description,
              ...(exposed !== raw && {
                mcpOrigin: { server: mcpName, tool: name },
              }),
            }
          }
        } catch (error) {
          // A failed MCP server (e.g. a stdio server that can't be spawned)
          // should disable just its own tools, not abort the whole turn. The
          // error from the client carries the actionable detail (command +
          // captured stderr).
          logger?.warn(
            { error: getErrorObject(error), mcpServer: mcpName },
            `Failed to load tools from MCP server "${mcpName}"; its tools will be unavailable for this step.`,
          )
        }
      })(),
    )
  }
  await Promise.all(promises)

  return writeTo
}
