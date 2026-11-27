import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MCPConfig } from '@codebuff/common/types/mcp'
import type { SetupImportMcp } from '@codebuff/common/setup-import'
import { regularText } from '@codebuff/common/setup-import/files'
import { mcpConfig, record } from '@codebuff/common/setup-import/formats'
import {
  sameImportedMcp,
  resolveImportedMcp,
} from '@codebuff/common/setup-import/mcp-secrets'

// An agent definition or API request can contain arbitrary MCP config. Hydrate ONLY the exact
// entry the user installed in their own home. The vault verifies the destination again on read.
export async function resolveCliImportedMcp(
  request: MCPConfig,
): Promise<MCPConfig> {
  if (
    request.type === 'sse' ||
    (request.type === 'http' && Object.keys(request.params).length)
  )
    throw new Error('Connector configuration changed.')
  const config: SetupImportMcp =
    request.type === 'stdio'
      ? request
      : { type: 'http', url: request.url, headers: request.headers }
  const raw = await regularText(
    join(homedir(), '.agents', 'mcp.json'),
    1_048_576,
  )
  if (raw) {
    const servers = record(record(JSON.parse(raw)).mcpServers)
    for (const [name, entry] of Object.entries(servers)) {
      let stored: SetupImportMcp
      try {
        stored = mcpConfig(entry, 'claude')
      } catch {
        continue
      }
      if (!sameImportedMcp(stored, config)) continue
      const resolved = await resolveImportedMcp(name, config)
      return resolved.type === 'stdio' ? resolved : { ...resolved, params: {} }
    }
  }
  throw new Error('The imported connector needs review on this computer.')
}
