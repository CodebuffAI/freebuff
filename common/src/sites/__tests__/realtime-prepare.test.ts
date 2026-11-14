import { afterEach, expect, test } from 'bun:test'
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseRealtimePreparationOutput,
  prepareRealtimeSite,
} from '../realtime-prepare'
import { NEXT_WRANGLER_VERSION } from '../versions'
import { withNodeStdinProbe } from './node-transport-fixture'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'realtime-prepare-'))
  roots.push(root)
  return root
}

test.skipIf(process.platform === 'win32')(
  'realtime preparation streams the full generated worker and SDK through Node stdin',
  async () => {
    const root = await fixture()
    const { result, records } = await withNodeStdinProbe(root, () =>
      prepareRealtimeSite(root),
    )
    expect(records).toHaveLength(1)
    expect(records[0].args).toEqual(['--input-type=module', '-'])
    expect(records[0].bytes).toBeGreaterThan(20_000)
    expect(
      await readFile(join(root, result.serverModulePath), 'utf8'),
    ).toContain('createRealtimeTicket')
  },
)

test('preparation generates local helper and server/client modules without replacing existing project files', async () => {
  const root = await fixture()
  await mkdir(join(root, 'app'))
  await writeFile(join(root, 'app/wrangler.jsonc'), '{"name":"existing"}')
  const result = await prepareRealtimeSite(root, 'app')
  expect(result.created.sort()).toEqual([
    'README.md',
    'browser.js',
    'server.js',
    'worker.js',
    'wrangler.jsonc',
  ])
  expect(result.preserved).toEqual([])
  expect(await readFile(join(root, result.readmePath), 'utf8')).toContain(
    `wrangler@${NEXT_WRANGLER_VERSION}`,
  )
  const local = JSON.parse(
    await readFile(join(root, result.localWranglerConfigPath), 'utf8'),
  )
  expect(local.dev.port).toBe(8788)
  expect(local.durable_objects.bindings).toEqual([
    { name: 'REALTIME', class_name: 'FreebuffRealtime' },
  ])
  expect(local.migrations[0].new_sqlite_classes).toEqual(['FreebuffRealtime'])
  expect(await readFile(join(root, 'app/wrangler.jsonc'), 'utf8')).toBe(
    '{"name":"existing"}',
  )
  await writeFile(
    join(root, result.browserModulePath),
    '// customized client\n',
  )
  const repeated = await prepareRealtimeSite(root, 'app')
  expect(repeated.created).toEqual([])
  expect(repeated.preserved).toHaveLength(5)
  expect(await readFile(join(root, result.browserModulePath), 'utf8')).toBe(
    '// customized client\n',
  )
})

test('preparation refuses workspace escape and symlink destinations', async () => {
  const root = await fixture()
  const outside = await fixture()
  await expect(prepareRealtimeSite(root, outside)).rejects.toThrow(
    'inside this workspace',
  )
  await symlink(outside, join(root, 'freebuff-realtime'))
  await expect(prepareRealtimeSite(root)).rejects.toThrow('symlink')
  await rm(join(root, 'freebuff-realtime'))
  await mkdir(join(root, 'freebuff-realtime'))
  await writeFile(join(outside, 'worker.js'), 'untouched')
  await symlink(
    join(outside, 'worker.js'),
    join(root, 'freebuff-realtime/worker.js'),
  )
  await expect(prepareRealtimeSite(root)).rejects.toThrow('symlink')
  expect(await readFile(join(outside, 'worker.js'), 'utf8')).toBe('untouched')
})

test('generated server helper uses the canonical hub and denies missing binding/provider failures', async () => {
  const root = await fixture()
  const result = await prepareRealtimeSite(root)
  const helpers = await import(
    pathToFileURL(join(root, result.serverModulePath)).href
  )
  const calls: { name: string; path: string; body: unknown }[] = []
  let status = 200
  const env = {
    REALTIME: {
      idFromName(name: string) {
        return name
      },
      get(name: string) {
        return {
          async fetch(request: Request) {
            calls.push({
              name,
              path: new URL(request.url).pathname,
              body: await request.json(),
            })
            return Response.json(
              {
                websocketUrl: 'wss://example.invalid',
                ticket: 'opaque',
                expiresAt: 100,
              },
              { status },
            )
          },
        }
      },
    },
  }
  const ticket = await helpers.createRealtimeTicket(env, {
    room: 'r',
    userId: 'u',
    origin: 'https://example.invalid',
  })
  expect(ticket.ticket).toBe('opaque')
  expect(calls[0]).toEqual({
    name: 'hub',
    path: '/ticket',
    body: {
      room: 'r',
      userId: 'u',
      origin: 'https://example.invalid',
      publish: false,
      presence: false,
    },
  })
  await helpers.publishRealtime(env, {
    room: 'r',
    event: 'updated',
    data: { revision: 2 },
  })
  expect(calls[1]).toMatchObject({ name: 'hub', path: '/publish' })
  status = 429
  await expect(
    helpers.createRealtimeTicket(env, {
      room: 'r',
      userId: 'u',
      origin: 'https://example.invalid',
    }),
  ).rejects.toThrow('429')
  await expect(helpers.createRealtimeTicket({}, {})).rejects.toThrow(
    'Enable realtime',
  )
})

test('preparation result parsing rejects malformed untrusted output', () => {
  expect(() => parseRealtimePreparationOutput('no output')).toThrow()
  expect(() =>
    parseRealtimePreparationOutput('FREEBUFF_REALTIME_RESULT:{}'),
  ).toThrow()
})

test('generated browser client reconnects with fresh tickets, normalizes presence and bounds sends', async () => {
  const root = await fixture()
  const result = await prepareRealtimeSite(root)
  const source = await readFile(join(root, result.browserModulePath), 'utf8')
  const sockets: FakeSocket[] = []
  class FakeSocket {
    static OPEN = 1
    readyState = 1
    bufferedAmount = 0
    sent: string[] = []
    onmessage?: (message: { data: string }) => void
    onclose?: () => void
    constructor(public url: string) {
      sockets.push(this)
    }
    send(value: string) {
      this.sent.push(value)
    }
    close() {
      this.readyState = 3
      this.onclose?.()
    }
    message(value: unknown) {
      this.onmessage?.({ data: JSON.stringify(value) })
    }
  }
  let timerId = 0,
    tickets = 0,
    status = 200
  const timers = new Map<number, () => void>()
  const connect = new Function(
    'window',
    'fetch',
    'WebSocket',
    'setTimeout',
    'clearTimeout',
    source.replace(
      'export function connectRealtime',
      'return function connectRealtime',
    ),
  )(
    {
      location: {
        href: 'https://app.example/path',
        origin: 'https://app.example',
      },
    },
    async () =>
      Response.json(
        { websocketUrl: 'wss://app.example/socket?ticket=' + ++tickets },
        { status },
      ),
    FakeSocket,
    (callback: () => void) => {
      timers.set(++timerId, callback)
      return timerId
    },
    (id: number) => timers.delete(id),
  )
  const messages: any[] = [],
    statuses: string[] = []
  const connection = connect({
    room: 'r',
    onMessage: (message: unknown) => messages.push(message),
    onStatus: (value: string) => statuses.push(value),
  })
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
  await tick()
  expect(tickets).toBe(1)
  sockets[0].message({
    type: 'ready',
    connectionId: 'one',
    userId: 'u',
    room: 'r',
    expiresInMs: 300_000,
  })
  sockets[0].message({
    type: 'presence',
    members: [{ connectionId: 'one', userId: 'u', data: null }],
  })
  sockets[0].message({
    type: 'presence_update',
    member: { connectionId: 'one', userId: 'u', data: { x: 2 } },
  })
  expect(messages.at(-1)).toEqual({
    type: 'presence',
    members: [{ connectionId: 'one', userId: 'u', data: { x: 2 } }],
  })
  expect(connection.broadcast('cursor', { x: 2 })).toBe(true)
  expect(connection.presence('x'.repeat(1025))).toBe(false)
  expect(connection.broadcast('huge', 'x'.repeat(16384))).toBe(false)
  sockets[0].bufferedAmount = 65537
  expect(connection.presence({ x: 3 })).toBe(false)
  expect(sockets[0].sent).toHaveLength(1)
  sockets[0].close()
  const reconnect = [...timers.values()][0]
  timers.clear()
  reconnect()
  await tick()
  expect(tickets).toBe(2)
  expect(sockets[1].url).not.toBe(sockets[0].url)
  status = 403
  sockets[1].close()
  const retry = [...timers.values()][0]
  timers.clear()
  retry()
  await tick()
  expect(statuses.at(-1)).toBe('unauthorized')
  expect(timers.size).toBe(0)
  connection.close()
  expect(timers.size).toBe(0)
  expect(() =>
    connect({ room: 'r', ticketUrl: 'https://other.example/ticket' }),
  ).toThrow('same-origin')
})

test('browser renews before expiry without waiting for a closing socket and cancels timers on teardown', async () => {
  const root = await fixture()
  const result = await prepareRealtimeSite(root)
  const source = await readFile(join(root, result.browserModulePath), 'utf8')
  const sockets: LingeringSocket[] = []
  class LingeringSocket {
    static OPEN = 1
    readyState = 1
    bufferedAmount = 0
    onmessage?: ((message: { data: string }) => void) | null
    onclose?: (() => void) | null
    onerror?: (() => void) | null
    constructor(public url: string) {
      sockets.push(this)
    }
    close() {
      this.readyState = 2
    } // No onclose: emulate a lingering handshake.
    message(value: unknown) {
      this.onmessage?.({ data: JSON.stringify(value) })
    }
  }
  let tickets = 0,
    timerId = 0
  const now = 1_000_000
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const connect = new Function(
    'window',
    'fetch',
    'WebSocket',
    'setTimeout',
    'clearTimeout',
    'Date',
    source.replace(
      'export function connectRealtime',
      'return function connectRealtime',
    ),
  )(
    {
      location: { href: 'https://app.example/', origin: 'https://app.example' },
    },
    async () =>
      Response.json({
        websocketUrl: 'wss://app.example/socket?ticket=' + ++tickets,
      }),
    LingeringSocket,
    (callback: () => void, delay: number) => {
      timers.set(++timerId, { callback, delay })
      return timerId
    },
    (id: number) => timers.delete(id),
    { now: () => now },
  )
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
  const connection = connect({ room: 'r' })
  await tick()
  // A browser clock ten minutes ahead must not turn expiry into a zero-delay loop.
  sockets[0].message({
    type: 'ready',
    expiresAt: now - 600_000,
    expiresInMs: 5_000,
  })
  const staleClose = sockets[0].onclose!
  expect(timers.size).toBe(1)
  const [renewalId, renewal] = [...timers.entries()][0]
  expect(renewal.delay).toBeGreaterThanOrEqual(4_000)
  expect(renewal.delay).toBeLessThan(5_000)
  timers.delete(renewalId)
  renewal.callback()
  await tick()
  expect(tickets).toBe(2)
  expect(sockets[0].readyState).toBe(2)
  expect(sockets[0].onmessage).toBeNull()
  expect(sockets[0].onclose).toBeNull()
  expect(sockets[1].url).not.toBe(sockets[0].url)
  staleClose() // A callback already queued by the browser must not reconnect.
  await tick()
  expect(tickets).toBe(2)
  expect(timers.size).toBe(0)
  sockets[1].message({
    type: 'ready',
    expiresAt: now - 600_000,
    expiresInMs: 5_000,
  })
  expect(timers.size).toBe(1)
  const staleRenewal = [...timers.values()][0].callback
  connection.close()
  expect(timers.size).toBe(0)
  expect(sockets[1].onclose).toBeNull()
  staleRenewal()
  await tick()
  expect(tickets).toBe(2)
})
