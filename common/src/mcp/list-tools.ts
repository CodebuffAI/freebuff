/**
 * `tools/list` is paginated in MCP: a server may return its tools a page at a time, each page naming
 * the cursor for the next. A client that reads one page sees only the first page's tools.
 */

/**
 * Later pages are fetched only while fewer tools than this are held. Cloud's custom MCP refuses a
 * server listing more, and Desktop publishes at most `LOCAL_MCP_TOOL_LIMIT` (also 200) of a local
 * server's tools to chats.
 */
export const MCP_LIST_TOOLS_MAX = 200
/** A backstop for a server whose pages keep naming a fresh cursor. */
export const MCP_LIST_TOOLS_MAX_PAGES = 20

export interface McpToolsPage<T> {
  tools: T[]
  nextCursor?: string
}

/**
 * Every tool a server lists, following `nextCursor`. The first page is returned whole, as the single
 * `tools/list` call this replaces returned it, so a server that does not paginate sees no change.
 * Later pages fill the list up to `maxTools`. Fetching stops at a cursor already followed, at a page
 * that adds no tool name not already held, or after `maxPages`; a name a later page repeats is dropped.
 */
export async function listAllMcpTools<T extends { name: string }>(
  listPage: (cursor: string | undefined) => Promise<McpToolsPage<T>>,
  {
    maxTools = MCP_LIST_TOOLS_MAX,
    maxPages = MCP_LIST_TOOLS_MAX_PAGES,
  }: { maxTools?: number; maxPages?: number } = {},
): Promise<T[]> {
  const first = await listPage(undefined)
  const tools = [...(first.tools ?? [])]
  const names = new Set(tools.map((tool) => tool.name))
  const followed = new Set<string>()
  let cursor = first.nextCursor
  for (let page = 1; page < maxPages; page++) {
    if (!cursor || followed.has(cursor) || tools.length >= maxTools) break
    followed.add(cursor)
    const next = await listPage(cursor)
    let added = 0
    for (const tool of next.tools ?? []) {
      if (names.has(tool.name)) continue
      names.add(tool.name)
      tools.push(tool)
      added++
    }
    if (added === 0) break
    cursor = next.nextCursor
  }
  return tools.slice(0, Math.max(first.tools?.length ?? 0, maxTools))
}
