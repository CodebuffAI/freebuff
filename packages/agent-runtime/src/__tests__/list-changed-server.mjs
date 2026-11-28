// Based on the dependency-free reproducer for #1696:
// https://github.com/CodebuffAI/freebuff/issues/1696#issuecomment-7060897502
// Adds pagination, a filtered tool, and a second change that removes/updates tools.
import { createInterface } from 'node:readline'

let phase = 0
const tool = (name, inputSchema = { type: 'object', properties: {} }) => ({
  name,
  description: name,
  inputSchema,
})
const currentTools = () => [
  ...(phase < 2 ? [tool('ping')] : []),
  tool('add_tool'),
  tool('hidden'),
  ...(phase > 0
    ? [
        tool(
          'third_tool',
          phase < 2
            ? { type: 'object', properties: {} }
            : {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
        ),
      ]
    : []),
]
const send = (msg) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const reply = (id, result) => send({ id, result })
const changed = () => send({ method: 'notifications/tools/list_changed' })
createInterface({ input: process.stdin, terminal: false }).on(
  'line',
  (line) => {
    const msg = JSON.parse(line)
    switch (msg.method) {
      case 'initialize':
        reply(msg.id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'progressive-fixture', version: '0.0.1' },
        })
        break
      case 'tools/list': {
        const start = Number(msg.params?.cursor ?? 0)
        const tools = currentTools()
        reply(msg.id, {
          tools: tools.slice(start, start + 1),
          ...(start + 1 < tools.length && { nextCursor: String(start + 1) }),
        })
        break
      }
      case 'tools/call':
        if (msg.params.name === 'add_tool') {
          phase = 1
          changed()
          changed()
        } else if (msg.params.name === 'third_tool') {
          phase = 2
          changed()
        }
        reply(msg.id, { content: [{ type: 'text', text: 'catalog updated' }] })
        break
    }
  },
)
