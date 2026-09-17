import z from 'zod/v4'

import { toolParams } from '../tools/list'

/**
 * Test fixtures shaped like the `tools` array our clients actually put on the
 * wire, so the detector's schema check sees what production sees.
 *
 * `wireTool(name)` serialises the Zod schema in `toolParams` the way the AI
 * SDK does (`z.toJSONSchema`, forwarded verbatim as `function.parameters`).
 * A name outside `toolParams` — a spawnable agent exposed as a tool, a custom
 * tool registered at runtime — gets a generic non-empty object schema, which
 * is what those carry in production. `stubTool` is the other side: a bare
 * name, optionally over an arbitrary schema, for foreign harnesses and for the
 * hollow definitions the resale proxies inject.
 */
export type WireTool = {
  type: 'function'
  function: { name: string; description?: string; parameters?: unknown }
}

export function wireTool(name: string): WireTool {
  const params = (
    toolParams as Record<
      string,
      { inputSchema?: z.ZodType; description?: string } | undefined
    >
  )[name]
  if (params?.inputSchema) {
    const parameters = z.toJSONSchema(params.inputSchema, { io: 'input' })
    return {
      type: 'function',
      function: { name, description: params.description, parameters },
    }
  }
  return {
    type: 'function',
    function: {
      name,
      description: `Spawn the ${name} agent`,
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
      },
    },
  }
}

export function wireTools(...names: string[]): WireTool[] {
  return names.map(wireTool)
}

export function stubTool(
  name: string,
  parameters?: unknown,
  description?: string,
): WireTool {
  return {
    type: 'function',
    function: {
      name,
      ...(description !== undefined && { description }),
      ...(parameters !== undefined && { parameters }),
    },
  }
}

export function stubTools(...names: string[]): WireTool[] {
  return names.map((name) =>
    stubTool(name, {
      type: 'object',
      properties: { input: { type: 'string' } },
    }),
  )
}

/**
 * The exact definition every public resale proxy appends to a foreign
 * toolset (freebuff2api and forks, trefeon/freebuff-proxy, 9router's freebuff
 * executor, all read 2026-09-17). Kept byte-for-byte so a regression here is a
 * regression against the real thing.
 */
export const PROXY_HOLLOW_END_TURN: WireTool = {
  type: 'function',
  function: {
    name: 'end_turn',
    description: 'Signal the end of the current task.',
    parameters: { type: 'object', properties: {} },
  },
}

/** Claude Code's core toolset as it reaches us through an Anthropic→OpenAI
 *  bridge, with each tool's real parameter names. */
export const CLAUDE_CODE_TOOLS: WireTool[] = [
  stubTool('Agent', obj('description', 'prompt', 'subagent_type')),
  stubTool('AskUserQuestion', obj('questions')),
  stubTool(
    'Bash',
    obj('command', 'timeout', 'description', 'run_in_background'),
  ),
  stubTool('Edit', obj('file_path', 'old_string', 'new_string', 'replace_all')),
  stubTool('Glob', obj('pattern', 'path')),
  stubTool('Grep', obj('pattern', 'path', 'glob', 'output_mode')),
  stubTool('Read', obj('file_path', 'offset', 'limit')),
  stubTool('Write', obj('file_path', 'content')),
  stubTool('WebFetch', obj('url', 'prompt')),
  stubTool('WebSearch', obj('query', 'allowed_domains')),
  stubTool('TodoWrite', obj('todos')),
  stubTool('Skill', obj('skill', 'args')),
]

function obj(...keys: string[]) {
  return {
    type: 'object',
    properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])),
  }
}
