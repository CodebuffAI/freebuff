/** The platform owns this source. Never upload a customer's Durable Object class.
 * Local preparation uses the same implementation, with only the serving/origin
 * check replaced for local workerd. Hosted deployments always use the default.
 */
export function realtimeWorkerSource(local = false): string {
  return REALTIME_WORKER_SOURCE.replace(
    'const LOCAL = false;',
    `const LOCAL = ${local};`,
  )
}

export const REALTIME_WORKER_SOURCE = String.raw`
import { DurableObject } from 'cloudflare:workers';
const LOCAL = false;
const PATH = '/.well-known/freebuff/realtime';
const MAX_CONNECTIONS = 128,
  MAX_ROOM_CONNECTIONS = 32,
  MAX_ROOMS = 32;
const MAX_MESSAGE = 16384,
  MAX_PRESENCE = 1024,
  MAX_TICKETS = 256;
const TICKET_MS = 30000,
  SESSION_MS = 300000;
const encoder = new TextEncoder();
const validName = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_:./-]{0,95}$/.test(value);
const validUser = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  encoder.encode(value).length <= 256 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const json = (value, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const reject = (code, status = 400) => json({ error: code }, status);
function origin(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
async function digest(value) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(value)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
function token() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
async function input(request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  let timer;
  const read = async () => {
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_MESSAGE) return null;
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      const value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
    } catch {
      return null;
    }
  };
  try {
    return await Promise.race([
      read(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
// Token buckets need no timers. Socket buckets live in hibernation attachments.
function spend(bucket, amount, rate, capacity, now = Date.now()) {
  bucket.tokens = Math.min(
    capacity,
    bucket.tokens + (Math.max(0, now - bucket.at) * rate) / 1000,
  );
  bucket.at = now;
  if (bucket.tokens < amount) return false;
  bucket.tokens -= amount;
  return true;
}
const bucket = (capacity) => ({ tokens: capacity, at: Date.now() });

export class FreebuffRealtime extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // A namespace binding must not let tenant code multiply its free limits by
    // choosing arbitrary object IDs. Invalid objects never touch storage/alarm.
    this.valid = ctx.id.equals(env.REALTIME.idFromName('hub'));
    this.observation = null;
    this.checking = null;
    this.initialized = false;
    this.pendingInputs = 0;
    this.deliveries = bucket(1024);
    this.bytes = bucket(2 * 1024 * 1024);
    this.tickets = bucket(20);
    if (this.valid)
      ctx.blockConcurrencyWhile(async () => {
        // Public probes must not create stored data before deployment measures
        // the empty namespace. Only private ticket minting initializes storage.
        this.initialized = (await ctx.storage.get('initialized')) === true;
      });
  }
  async #allowed(fresh = false) {
    if (LOCAL) return 'local';
    if (!fresh && this.observation?.until > Date.now())
      return this.observation.origin;
    if (this.checking) return this.checking;
    this.observation = null;
    this.checking = (async () => {
      try {
        const response = await fetch(this.env.FREEBUFF_SERVING_URL, {
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          await response.body?.cancel();
          return null;
        }
        const value = await response.json();
        const hostname =
          value.canonicalHostname ??
          new URL(this.env.FREEBUFF_SERVING_URL).searchParams.get('hostname');
        if (
          value.allowed !== true ||
          value.worker !== this.env.FREEBUFF_SITE_WORKER ||
          typeof hostname !== 'string' ||
          !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(hostname)
        )
          return null;
        const result = 'https://' + hostname;
        this.observation = { origin: result, until: Date.now() + 5000 };
        return result;
      } catch {
        return null;
      }
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }
  #sockets(room) {
    return (
      room === undefined
        ? this.ctx.getWebSockets()
        : this.ctx.getWebSockets(room)
    ).filter((ws) => ws.readyState === 1);
  }
  #close(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {}
  }
  #stop() {
    for (const ws of this.#sockets()) this.#close(ws, 1013, 'Site unavailable');
  }
  #expire() {
    const rooms = new Set();
    for (const ws of this.#sockets()) {
      const meta = ws.deserializeAttachment();
      if (!meta || meta.expiresAt <= Date.now()) {
        if (meta) rooms.add(meta.room);
        this.#close(ws, 4001, 'Authorization expired');
      }
    }
    return rooms;
  }
  async #schedule() {
    const ticket = this.ctx.storage.sql
      .exec('SELECT MIN(expiresAt) AS at FROM tickets')
      .one().at;
    let next = ticket ?? Infinity;
    for (const ws of this.#sockets())
      next = Math.min(next, ws.deserializeAttachment().expiresAt);
    if (next !== Infinity) {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current <= Date.now() || current > next)
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
    } else if ((await this.ctx.storage.getAlarm()) !== null)
      await this.ctx.storage.deleteAlarm();
  }
  // Bound aggregate amplification as well as messages per sender. Events are
  // ephemeral: an overloaded room returns an explicit refusal, never queues.
  #fanout(room, value) {
    const encoded = JSON.stringify(value),
      sockets = this.#sockets(room);
    const bytes = encoder.encode(encoded).length * sockets.length;
    if (
      !spend(this.deliveries, sockets.length, 512, 1024) ||
      !spend(this.bytes, bytes, 1024 * 1024, 2 * 1024 * 1024)
    )
      return false;
    for (const ws of sockets) {
      try {
        ws.send(encoded);
      } catch {
        this.#close(ws, 1011, 'Delivery failed');
      }
    }
    return true;
  }
  #presence(room) {
    const sent = this.#fanout(room, {
      type: 'presence',
      members: this.#sockets(room).map((ws) => {
        const meta = ws.deserializeAttachment();
        return {
          connectionId: meta.connectionId,
          userId: meta.userId,
          data: meta.data,
        };
      }),
    });
    // A dropped membership update would leave clients silently stale. Closing
    // forces a fresh authorization and snapshot, with client reconnect backoff.
    if (!sent)
      for (const ws of this.#sockets(room))
        this.#close(ws, 1013, 'Presence resync required');
    return sent;
  }
  async fetch(request) {
    if (!this.valid) return reject('invalid_instance', 403);
    const url = new URL(request.url);
    if (
      request.method === 'POST' &&
      (url.pathname === '/ticket' || url.pathname === '/publish')
    ) {
      if (this.pendingInputs >= 16 || !spend(this.tickets, 1, 10, 20))
        return reject('rate_limited', 429);
      this.pendingInputs++;
      let value;
      try {
        value = await input(request);
      } finally {
        this.pendingInputs--;
      }
      if (!value || !validName(value.room)) return reject('invalid_request');
      const canonical = await this.#allowed();
      if (!canonical) {
        this.#stop();
        return reject('site_unavailable', 503);
      }
      this.#expire();
      if (url.pathname === '/publish') {
        if (!validName(value.event) || !Object.hasOwn(value, 'data'))
          return reject('invalid_event');
        if (
          !this.#fanout(value.room, {
            type: 'broadcast',
            event: value.event,
            data: value.data,
            userId: null,
            connectionId: null,
          })
        )
          return reject('rate_limited', 429);
        return json({ ok: true });
      }
      if (
        !validUser(value.userId) ||
        !origin(value.origin) ||
        (!LOCAL && value.origin !== canonical) ||
        (value.publish !== undefined && typeof value.publish !== 'boolean') ||
        (value.presence !== undefined && typeof value.presence !== 'boolean') ||
        (value.ttlSeconds !== undefined &&
          (!Number.isInteger(value.ttlSeconds) ||
            value.ttlSeconds < 1 ||
            value.ttlSeconds > 300))
      )
        return reject('invalid_authorization', 403);
      if (!this.initialized)
        await this.ctx.blockConcurrencyWhile(async () => {
          this.ctx.storage.sql.exec(
            'CREATE TABLE IF NOT EXISTS tickets (token TEXT PRIMARY KEY, room TEXT NOT NULL, userId TEXT NOT NULL, origin TEXT NOT NULL, canPublish INTEGER NOT NULL, canPresence INTEGER NOT NULL, expiresAt INTEGER NOT NULL, sessionExpiresAt INTEGER NOT NULL)',
          );
          await this.ctx.storage.put('initialized', true);
          this.initialized = true;
        });
      const raw = token(),
        hashed = await digest(raw),
        now = Date.now();
      this.ctx.storage.sql.exec(
        'DELETE FROM tickets WHERE expiresAt <= ?',
        now,
      );
      if (
        this.ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM tickets').one()
          .count >= MAX_TICKETS
      )
        return reject('too_many_tickets', 429);
      const expiresAt = now + TICKET_MS;
      const sessionExpiresAt =
        now +
        (value.ttlSeconds === undefined ? SESSION_MS : value.ttlSeconds * 1000);
      this.ctx.storage.sql.exec(
        'INSERT INTO tickets VALUES (?,?,?,?,?,?,?,?)',
        hashed,
        value.room,
        value.userId,
        value.origin,
        value.publish === true ? 1 : 0,
        value.presence === true ? 1 : 0,
        Math.min(expiresAt, sessionExpiresAt),
        sessionExpiresAt,
      );
      await this.#schedule();
      const socketUrl = new URL(
        PATH,
        LOCAL ? 'http://127.0.0.1:8788' : canonical,
      );
      socketUrl.protocol = LOCAL ? 'ws:' : 'wss:';
      socketUrl.searchParams.set('ticket', raw);
      return json({
        ticket: raw,
        expiresAt: Math.min(expiresAt, sessionExpiresAt),
        websocketUrl: socketUrl.href,
      });
    }
    if (url.pathname !== PATH) return reject('not_found', 404);
    if (
      request.method !== 'GET' ||
      request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
    )
      return reject('websocket_required', 426);
    const raw = url.searchParams.get('ticket');
    if (!this.initialized || !raw || !/^[a-f0-9]{64}$/.test(raw))
      return reject('invalid_ticket', 401);
    const canonical = await this.#allowed();
    if (!canonical) {
      this.#stop();
      return reject('site_unavailable', 503);
    }
    const hashed = await digest(raw);
    // After all asynchronous work: consume the one-use ticket and allocate the
    // socket synchronously, so concurrent upgrades cannot exceed a cap/replay.
    const saved = this.ctx.storage.sql
      .exec('SELECT * FROM tickets WHERE token = ?', hashed)
      .toArray()[0];
    if (!saved || saved.expiresAt <= Date.now())
      return reject('invalid_ticket', 401);
    if (
      request.headers.get('Origin') !== saved.origin ||
      (!LOCAL && (saved.origin !== canonical || url.origin !== canonical))
    )
      return reject('origin_denied', 403);
    this.#expire();
    const all = this.#sockets(),
      room = this.#sockets(saved.room);
    const rooms = new Set(all.map((ws) => ws.deserializeAttachment().room));
    if (
      all.length >= MAX_CONNECTIONS ||
      room.length >= MAX_ROOM_CONNECTIONS ||
      (!rooms.has(saved.room) && rooms.size >= MAX_ROOMS)
    )
      return reject('room_capacity', 429);
    this.ctx.storage.sql.exec('DELETE FROM tickets WHERE token = ?', hashed);
    const pair = new WebSocketPair(),
      client = pair[0],
      server = pair[1];
    const meta = {
      room: saved.room,
      userId: saved.userId,
      connectionId: crypto.randomUUID(),
      publish: saved.canPublish === 1,
      presence: saved.canPresence === 1,
      expiresAt: saved.sessionExpiresAt,
      data: null,
      rate: bucket(40),
    };
    server.serializeAttachment(meta);
    this.ctx.acceptWebSocket(server, [saved.room]);
    server.send(
      JSON.stringify({
        type: 'ready',
        room: saved.room,
        userId: saved.userId,
        connectionId: meta.connectionId,
        expiresAt: meta.expiresAt,
        expiresInMs: Math.max(0, meta.expiresAt - Date.now()),
      }),
    );
    this.#presence(saved.room);
    // The ticket alarm is already earlier than this socket's auth expiration.
    // It will prune unused tickets then schedule the next real expiration.
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) {
    const meta = ws.deserializeAttachment();
    if (!meta || meta.expiresAt <= Date.now()) {
      this.#close(ws, 4001, 'Authorization expired');
      return;
    }
    if (
      typeof message !== 'string' ||
      encoder.encode(message).length > MAX_MESSAGE
    ) {
      this.#close(ws, 1009, 'Message too large');
      return;
    }
    if (!spend(meta.rate, 1, 20, 40)) {
      this.#close(ws, 1008, 'Rate limited');
      return;
    }
    // Save before awaiting I/O; concurrent events cannot reuse the old bucket.
    ws.serializeAttachment(meta);
    let value;
    try {
      value = JSON.parse(message);
    } catch {
      this.#close(ws, 1008, 'Invalid message');
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.#close(ws, 1008, 'Invalid message');
      return;
    }
    const canonical = await this.#allowed();
    if (!canonical) {
      this.#stop();
      return;
    }
    this.#expire();
    if (ws.readyState !== 1) return;
    if (
      value.type === 'broadcast' &&
      meta.publish &&
      validName(value.event) &&
      Object.hasOwn(value, 'data')
    ) {
      if (
        !this.#fanout(meta.room, {
          type: 'broadcast',
          event: value.event,
          data: value.data,
          userId: meta.userId,
          connectionId: meta.connectionId,
        })
      )
        this.#close(ws, 1013, 'Room rate limited');
    } else if (
      value.type === 'presence' &&
      meta.presence &&
      Object.hasOwn(value, 'data') &&
      encoder.encode(JSON.stringify(value.data)).length <= MAX_PRESENCE
    ) {
      // Fetch current attachment again after awaiting the serving check.
      const current = ws.deserializeAttachment();
      current.data = value.data;
      ws.serializeAttachment(current);
      if (
        !this.#fanout(meta.room, {
          type: 'presence_update',
          member: {
            connectionId: current.connectionId,
            userId: current.userId,
            data: current.data,
          },
        })
      )
        this.#close(ws, 1013, 'Room rate limited');
    } else this.#close(ws, 1008, 'Message not permitted');
  }
  async webSocketClose(ws, code) {
    const meta = ws.deserializeAttachment();
    this.#close(ws, code === 1005 ? 1000 : code, '');
    if (meta && (await this.#allowed())) {
      this.#expire();
      this.#presence(meta.room);
    } else this.#stop();
  }
  async webSocketError(ws) {
    this.#close(ws, 1011, 'Connection failed');
  }
  async alarm() {
    if (!this.valid || !this.initialized) return;
    this.ctx.storage.sql.exec(
      'DELETE FROM tickets WHERE expiresAt <= ?',
      Date.now(),
    );
    const changed = this.#expire();
    if (this.#sockets().length) {
      if (!(await this.#allowed(true))) this.#stop();
      else for (const room of changed) this.#presence(room);
    }
    await this.#schedule();
  }
}
// The dispatcher can reach only the browser upgrade endpoint. Server ticket
// minting/publishing is available exclusively via the tenant's scoped binding.
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.pathname !== PATH ||
      request.method !== 'GET' ||
      request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
    )
      return reject('not_found', 404);
    return env.REALTIME.get(env.REALTIME.idFromName('hub')).fetch(request);
  },
};
`
