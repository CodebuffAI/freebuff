import { realpathSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { mcpConfigSchema } from '../types/mcp'
import { isPathInside } from '../util/path'
import { z } from 'zod/v4'

import type { MCPConfig } from '../types/mcp'
import type { PluginReport } from './report'

/**
 * Loads the MCP component of one plugin (spec §7.2): reads `mcp.json` at
 * the plugin root, adapts each server entry onto freebuff's own `MCPConfig`
 * shape, and never touches any alternative path — §7.2 fixes the MCP
 * configuration path at `mcp.json`, so decoy files that merely resemble it
 * are invisible to this walk.
 *
 * Server *shape* is validated by the schemas in `common/src/types/mcp.ts`,
 * never re-declared here; this module owns only the spec-to-freebuff
 * mapping and the §-cited reporting. Where the spec asks for more than
 * those shapes can express — per-entry `cwd` rules (§7.2.1), the remote
 * URL and header constraints (§7.2.1), the §9.2 reserved env names — the
 * freebuff schema is the arbiter, and the gap is recorded for the
 * maintainers rather than re-implemented beside it.
 *
 * Spec: github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md
 */

/** The canonical $schema id of a 1.0.0 MCP configuration (spec §7.2.1). */
const MCP_SCHEMA_1_0_0 =
  'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

/**
 * The spec file's wrapper, distinct from freebuff's `mcpConfigSchema`: the
 * spec's `$schema` key is not part of the freebuff shape, so it is parsed
 * here for version selection and then dropped, never carried onto a
 * server.
 */
const specFileSchema = z.object({
  $schema: z.string(),
  mcpServers: z.record(z.string(), z.unknown()),
})

/**
 * Either the plugin's servers as freebuff configs with any reports, or MCP
 * disabled for this plugin with the reason and a report — a component
 * result, never fatal to the plugin or its other components (§7.2.2).
 */
export type LoadMCPResult =
  | { ok: true; servers: Record<string, MCPConfig>; reports: PluginReport[] }
  | { ok: false; reason: string; reports: PluginReport[] }

/**
 * The remote transport mapping, grounded on the constructors in
 * `common/src/mcp/client.ts` rather than on label similarity: freebuff's
 * `'http'` builds `StreamableHTTPClientTransport` (§7.2.1: "streamable-http
 * selects the current MCP Streamable HTTP transport") and freebuff's `'sse'`
 * builds `SSEClientTransport` ("the deprecated HTTP+SSE transport"). The
 * label match is checked against those constructors, not the strings.
 */
const REMOTE_TYPES: Record<string, 'http' | 'sse'> = {
  'streamable-http': 'http',
  sse: 'sse',
}

/**
 * Loads `<root>/mcp.json` and returns its servers as freebuff configs.
 * Absence and a wrong-kind `mcp.json` are answered with an empty set and
 * no error (§6.2); an unreadable or unrecognizable file disables MCP for
 * the plugin with a report (§7.2.2 rule 2); a server entry the freebuff
 * schema refuses is skipped with a report while its siblings load
 * (§7.2.2 rule 3). An `mcp.json` resolving outside the plugin root is
 * refused under §4.1.1.
 */
export function loadPluginMCP(root: string): LoadMCPResult {
  const read = readMCPJson(root)
  if (!read.ok) {
    if (read.absent) return { ok: true, servers: {}, reports: [] }
    return {
      ok: false,
      reason: read.reason,
      reports: [
        { severity: read.severity, section: '§7.2', message: read.reason },
      ],
    }
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(read.text)
  } catch {
    return disabled('mcp.json is not valid JSON (§7.2.2)')
  }
  const file = specFileSchema.safeParse(parsedJson)
  if (!file.success) {
    return disabled('mcp.json does not satisfy the §7.2.1 file shape')
  }

  const $schema = file.data.$schema
  if ($schema !== MCP_SCHEMA_1_0_0) {
    return disabled(`mcp.json targets an unsupported $schema ${$schema}`)
  }

  const { servers, reports } = Object.entries(file.data.mcpServers).reduce<{
    servers: Record<string, MCPConfig>
    reports: PluginReport[]
  }>(
    (acc, [name, raw]) => {
      const mapped = toFreebuffConfig(raw)
      if (mapped.ok) {
        return { ...acc, servers: { ...acc.servers, [name]: mapped.config } }
      }
      return {
        ...acc,
        reports: [
          ...acc.reports,
          {
            severity: 'warning',
            section: '§7.2.2',
            message: `skipped MCP server "${name}": ${mapped.reason}`,
          },
        ],
      }
    },
    { servers: {}, reports: [] },
  )

  return { ok: true, servers, reports }
}

/**
 * Reads the `mcp.json` text. §4.1.1 is settled on the resolved path before
 * the filesystem kind is classified: a reparse point resolving outside the
 * plugin root is a containment refusal (error report), while an absent or
 * wrong-kind location is a §6.2 absence answered with an empty set and no
 * report (nothing was read to report about).
 */
function readMCPJson(root: string):
  | { ok: true; text: string }
  | {
      ok: false
      absent: boolean
      reason: string
      severity: 'error' | 'warning'
    } {
  const file = path.join(root, 'mcp.json')

  let resolved: string
  try {
    // Follows reparse points, and throws when nothing is there — which is
    // the §6.2 absence, not an error.
    resolved = realpathSync(file)
  } catch {
    return {
      ok: false,
      absent: true,
      reason: 'no mcp.json at the plugin root',
      severity: 'warning',
    }
  }

  if (!isPathInside(realpathSync(root), resolved)) {
    return {
      ok: false,
      absent: false,
      reason: 'mcp.json resolves outside the plugin root (§4.1.1)',
      severity: 'error',
    }
  }

  if (!statSync(resolved).isFile()) {
    return {
      ok: false,
      absent: true,
      reason: 'mcp.json is not a regular file (§6.2)',
      severity: 'warning',
    }
  }

  try {
    return { ok: true, text: readFileSync(resolved, 'utf8') }
  } catch {
    return {
      ok: false,
      absent: false,
      reason: 'mcp.json could not be read (§4.1.1)',
      severity: 'error',
    }
  }
}

/**
 * Maps one spec server entry onto a freebuff config, or returns the reason
 * the freebuff schema refuses it. The mapping itself is the two remote
 * transport labels; every other field check is the freebuff schema's, so a
 * field the freebuff shapes do not carry (the spec's per-entry `cwd`, for
 * one) reaches here only to be refused by them.
 */
function toFreebuffConfig(
  raw: unknown,
): { ok: true; config: MCPConfig } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'server entry is not an object (§7.2.1)' }
  }

  const type = (raw as { type?: unknown }).type
  if (type === 'stdio') {
    return applyFreebuffSchema(raw)
  }

  const remoteType = REMOTE_TYPES[typeof type === 'string' ? type : '']
  if (remoteType === undefined) {
    return { ok: false, reason: `unknown type ${JSON.stringify(type)}` }
  }

  return applyFreebuffSchema({ ...raw, type: remoteType })
}

/**
 * Runs the freebuff schema over a mapped entry: a refused entry never
 * reaches the server map, and an accepted one comes out exactly as the
 * freebuff schema emits it — defaults filled (`headers: {}`, `params: {}`)
 * — so a plugin-provided server is indistinguishable from one the user
 * wrote in `~/.agents/mcp.json` themselves.
 */
function applyFreebuffSchema(
  mapped: unknown,
): { ok: true; config: MCPConfig } | { ok: false; reason: string } {
  const parsed = mcpConfigSchema.safeParse(mapped)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      reason: `${issue?.path.join('.') || 'entry'}: ${issue?.message || 'does not satisfy the freebuff MCP schema'}`,
    }
  }
  return { ok: true, config: parsed.data }
}

/** MCP-disabled-with-report, the §7.2.2 rule 2 outcome. */
function disabled(reason: string): LoadMCPResult {
  return {
    ok: false,
    reason,
    reports: [refusedReport(reason)],
  }
}

function refusedReport(reason: string): PluginReport {
  return { severity: 'warning', section: '§7.2', message: reason }
}
