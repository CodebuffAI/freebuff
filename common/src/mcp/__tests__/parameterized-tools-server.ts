/**
 * Stdio MCP server fixture shaped like the Roblox Studio MCP server built into
 * Roblox Studio: one zero-argument discovery tool, and tools whose arguments
 * are all required. Studio adds a required `studio_id` (and, for datamodel
 * tools, an enum `datamodel_type`) to every tool but `list_roblox_studios`.
 *
 * Schemas are served as raw JSON Schema through the low-level `Server` so the
 * client receives exactly these bytes. Each call echoes the arguments it
 * received, which is what a test asserts on.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const studioId = {
  type: 'string',
  description:
    'Selects Roblox Studio instance, use the list_roblox_studios tool to get available instances',
}

const tools = [
  {
    name: 'list_roblox_studios',
    description: 'Lists all connected Studio instances.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_studio_state',
    description: 'Gets the current play state and available datamodel types.',
    inputSchema: {
      type: 'object',
      properties: { studio_id: studioId },
      required: ['studio_id'],
    },
  },
  {
    name: 'execute_luau',
    description: 'Runs Luau code in Studio.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The Luau code to run.' },
        datamodel_type: {
          type: 'string',
          enum: ['Edit', 'Client', 'Server'],
          description: 'The target datamodel to operate on.',
        },
        studio_id: studioId,
      },
      required: ['code', 'datamodel_type', 'studio_id'],
    },
  },
]

const server = new Server(
  { name: 'parameterized-tools-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        tool: request.params.name,
        received: request.params.arguments ?? null,
      }),
    },
  ],
}))

await server.connect(new StdioServerTransport())
