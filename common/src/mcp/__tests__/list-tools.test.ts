import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'

import { getMCPClient, listAllTools, listMCPTools } from '../client'
import { listAllMcpTools } from '../list-tools'

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

const tool = (name: string) => ({
  name,
  inputSchema: { type: 'object' as const },
})

/** An MCP client whose `tools/list` answers with `page(cursor, call)`; `call` counts from 0. */
function fakeClient(
  page: (
    cursor: string | undefined,
    call: number,
  ) => { names: string[]; nextCursor?: string },
) {
  const cursors: (string | undefined)[] = []
  const client = {
    async listTools(params?: { cursor?: string }) {
      cursors.push(params?.cursor)
      const { names, nextCursor } = page(params?.cursor, cursors.length - 1)
      return { tools: names.map(tool), nextCursor }
    },
  }
  return { client: client as unknown as Pick<Client, 'listTools'>, cursors }
}

describe('listing a server whose tools/list is paginated', () => {
  test('the CLI and SDK client follows nextCursor and returns every page', async () => {
    const { client, cursors } = fakeClient((cursor) =>
      cursor === 'page-2'
        ? { names: ['c'] }
        : { names: ['a', 'b'], nextCursor: 'page-2' },
    )

    const result = await listAllTools(client)

    expect(result.tools.map((t) => t.name)).toEqual(['a', 'b', 'c'])
    expect(result.nextCursor).toBeUndefined()
    expect(cursors).toEqual([undefined, 'page-2'])
  })

  test('a server that names a cursor it already sent is not asked again', async () => {
    // Each answer brings a new tool, so only the cursor check can end this.
    const { client, cursors } = fakeClient((_cursor, call) => ({
      names: [`tool-${call}`],
      nextCursor: 'again',
    }))

    const result = await listAllTools(client)

    expect(result.tools.map((t) => t.name)).toEqual(['tool-0', 'tool-1'])
    expect(cursors).toEqual([undefined, 'again'])
  })

  test('later pages stop at the cap, but a first page over it is kept whole', async () => {
    const names = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${prefix}${i}`)
    const paged = await listAllMcpTools(
      async (cursor) =>
        cursor
          ? { tools: names(cursor, 3).map(tool), nextCursor: `${cursor}+` }
          : { tools: names('first', 2).map(tool), nextCursor: 'p' },
      { maxTools: 4 },
    )
    expect(paged.map((t) => t.name)).toEqual(['first0', 'first1', 'p0', 'p1'])

    // One unpaginated page used to be returned whole, so it still is.
    const single = await listAllMcpTools(
      async () => ({ tools: names('t', 6).map(tool), nextCursor: 'p' }),
      { maxTools: 4 },
    )
    expect(single).toHaveLength(6)
  })
})

test('a failed listing is not cached, so the next call asks the server again', async () => {
  const clientId = await getMCPClient({
    type: 'stdio',
    command: 'bun',
    args: [join(dirname(import.meta.path), 'flaky-list-tools-server.ts')],
    env: process.env as Record<string, string>,
  })

  await expect(listMCPTools(clientId)).rejects.toThrow(/not ready yet/)
  const result = await listMCPTools(clientId)
  expect(result.tools.map((t) => t.name)).toEqual(['ready'])
})
