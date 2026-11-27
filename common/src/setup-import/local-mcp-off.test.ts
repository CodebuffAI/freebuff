import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importedMcpOff, importLocalMcp } from './local-sinks'

// An imported MCP server must not start in the CLI, which runs every server in mcp.json.
test('an imported MCP server is listed off for the CLI; the user\'s own server is not', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mcp-off-')))
  try {
    await mkdir(join(home, '.agents'), { recursive: true })
    await writeFile(
      join(home, '.agents', 'mcp.json'),
      JSON.stringify({ mcpServers: { mine: { command: 'echo', args: ['own'] } } }),
    )
    const prompt = async () => null
    expect(await importLocalMcp(home, 'fresh', { type: 'stdio', command: 'echo', args: [], env: {} }, prompt)).toBe('imported')
    expect(await importedMcpOff(home)).toEqual(['fresh'])
    // Importing over the user's own name never writes it and never switches it off.
    expect(await importLocalMcp(home, 'mine', { type: 'stdio', command: 'echo', args: ['other'], env: {} }, prompt)).toBe('conflict')
    expect(await importedMcpOff(home)).toEqual(['fresh'])
    const servers = JSON.parse(await readFile(join(home, '.agents', 'mcp.json'), 'utf8')).mcpServers
    expect(Object.keys(servers).sort()).toEqual(['fresh', 'mine'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
