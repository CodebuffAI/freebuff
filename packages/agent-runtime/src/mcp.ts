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
            writeTo[mcpName + MCP_TOOL_SEPARATOR + name] = {
              inputSchema: convertJsonSchemaToZod(inputSchema as any) as any,
              endsAgentStep: true,
              description,
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
