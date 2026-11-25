/**
 * opencode-hub — server halaman (port dari service.port()).
 *
 * Ported to Prisma Composer: port from service.port(), config from service.input(),
 * data URL from service.load().data (rawHttp contract).
 */
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import service from './hub-service.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = service.port();
const HOST = '0.0.0.0';

// Lazy-load input and deps at boot
const input = service.input();
const deps = service.load();

const OPENCODE_URL = (input.opencodeUrl).replace(/\/+$/, '');
const OPENCODE_PASSWORD = input.opencodePassword.expose();
const DATA_CLIENT = deps.data;
const DATA_URL = DATA_CLIENT.url.replace(/\/+$/, '');
const STARTED_AT = new Date();

const PUBLIC_FILES = new Map([
  ['/chat', { file: 'chat.html', type: 'text/html; charset=utf-8' }],
  ['/hub', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/hub/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);

const OPENCODE_AUTH = OPENCODE_PASSWORD
  ? `Basic ${Buffer.from(`opencode:${OPENCODE_PASSWORD}`).toString('base64')}`
  : null;

async function getJson(url: string, timeoutMs = 2500, headers: Record<string, string> = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text.slice(0, 200);
    }
    return { ok: res.ok, status: res.status, body, latencyMs: Date.now() - started };
  } catch (error: any) {
    return { ok: false, status: 0, body: null, latencyMs: Date.now() - started, error: error.name };
  }
}

function authVariants() {
  if (!OPENCODE_PASSWORD) return [{}];
  return [
    { authorization: `Bearer ${OPENCODE_PASSWORD}` },
    { authorization: `Basic ${Buffer.from(`opencode:${OPENCODE_PASSWORD}`).toString('base64')}` },
  ];
}

async function probeOpencode(path: string) {
  let last: any;
  for (const headers of authVariants()) {
    last = await getJson(`${OPENCODE_URL}${path}`, 2500, headers as any);
    if (last.status !== 401) return last;
  }
  return last;
}

async function buildState() {
  const [health, sessions, dataHealth] = await Promise.all([
    probeOpencode('/global/health'),
    probeOpencode('/session'),
    getJson(`${DATA_URL}/health`),
  ]);

  const sessionList = Array.isArray(sessions.body) ? sessions.body : [];

  return {
    checkedAt: new Date().toISOString(),
    hub: {
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: STARTED_AT.toISOString(),
      port: PORT,
      node: process.version,
    },
    opencode: {
      url: OPENCODE_URL,
      reachable: health.ok,
      healthy: health.body?.healthy === true,
      version: health.body?.version ?? null,
      passwordProtected: OPENCODE_PASSWORD.length > 0,
      sessionCount: sessionList.length,
      latencyMs: health.latencyMs,
      httpStatus: health.status,
      error: health.error ?? null,
    },
    data: {
      url: DATA_URL,
      reachable: dataHealth.ok,
      uptimeSeconds: dataHealth.body?.uptimeSeconds ?? null,
      groups: dataHealth.body?.groups ?? null,
      resources: dataHealth.body?.resources ?? null,
      latencyMs: dataHealth.latencyMs,
      error: dataHealth.error ?? null,
    },
  };
}

let cache: { at: number; value: any } = { at: 0, value: null };
async function state() {
  if (cache.value && Date.now() - cache.at < 2000) return cache.value;
  cache = { at: Date.now(), value: await buildState() };
  return cache.value;
}

function basicAuthOk(req: any) {
  if (!OPENCODE_PASSWORD) return true;
  const match = /^Basic (.+)$/i.exec(req.headers.authorization ?? '');
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64').toString();
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  return decoded.slice(0, separator) === 'opencode' && decoded.slice(separator + 1) === OPENCODE_PASSWORD;
}

function requireAuth(res: any) {
  res.writeHead(401, {
    'www-authenticate': 'Basic realm="OpenCode", charset="UTF-8"',
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end('Butuh password server opencode (user: opencode).\n');
}

function proxyOpencode(req: any, res: any, upstreamPath: string) {
  const target = new URL(OPENCODE_URL);
  const headers: any = { ...req.headers, host: target.host };
  if (OPENCODE_AUTH) headers.authorization = OPENCODE_AUTH;
  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      path: upstreamPath,
      method: req.method,
      headers,
    },
    (up: any) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (error: any) => {
    console.error('[hub] proxy opencode gagal', error.message);
    if (!res.headersSent) json(res, 502, { error: 'opencode_unreachable', detail: error.message });
    else res.end();
  });
  req.pipe(upstream);
}

function json(res: any, status: number, body: any) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const server = createServer(async (req: any, res: any) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname === '/api/state') {
      return json(res, 200, await state());
    }

    if (url.pathname === '/api/resources') {
      // Use the rawHttp contract's fetch instead of a bare URL
      try {
        const upstream = await DATA_CLIENT.fetch('/api/resources', { method: 'GET' });
        const text = await upstream.text();
        let body: any = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text.slice(0, 200); }
        if (!upstream.ok) {
          return json(res, 502, { error: 'data_server_unreachable', url: DATA_URL, detail: upstream.status });
        }
        return json(res, 200, body);
      } catch (error: any) {
        return json(res, 502, { error: 'data_server_unreachable', url: DATA_URL, detail: error.message });
      }
    }

    if (url.pathname === '/api/opencode/sessions') {
      const upstream = await probeOpencode('/session');
      if (!upstream.ok) {
        return json(res, 502, { error: 'opencode_unreachable', url: OPENCODE_URL, detail: upstream.error ?? upstream.status });
      }
      const list = (Array.isArray(upstream.body) ? upstream.body : []).slice(0, 20).map((s: any) => ({
        id: s.id,
        title: s.title ?? '(tanpa judul)',
        updated: s.time?.updated ?? null,
      }));
      return json(res, 200, { url: OPENCODE_URL, count: list.length, sessions: list });
    }

    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, service: 'opencode-hub', uptimeSeconds: Math.round(process.uptime()) });
    }

    if (url.pathname === '/oc' || url.pathname === '/app') {
      res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
      return res.end();
    }

    const asset = PUBLIC_FILES.get(url.pathname);
    if (asset) {
      const body = await readFile(join(__dirname, 'public', asset.file));
      res.writeHead(200, {
        'content-type': asset.type,
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      return res.end(body);
    }

    return proxyOpencode(req, res, req.url ?? '/');
  } catch (error) {
    console.error('[hub] request failed', error);
    return json(res, 500, { error: 'internal_error' });
  }
});

server.on('upgrade', (req: any, socket: any, head: any) => {
  const target = new URL(OPENCODE_URL);
  const upstreamHeaders: any = { ...req.headers, host: target.host };
  if (OPENCODE_AUTH) upstreamHeaders.authorization = OPENCODE_AUTH;
  const upstream = httpRequest({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 80,
    path: (req.url ?? '/').replace(/^\/oc(?=\/|$)/, '') || '/',
    method: req.method,
    headers: upstreamHeaders,
  });
  upstream.on('upgrade', (up: any, upSocket: any, upHead: any) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(up.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket).pipe(upSocket);
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});

server.listen(PORT, HOST, () => {
  console.log(`[hub] page on http://${HOST}:${PORT} (pid ${process.pid})`);
  console.log(`[hub] opencode target: ${OPENCODE_URL}${OPENCODE_PASSWORD ? ' (password set)' : ''}`);
  console.log(`[hub] data   target: ${DATA_URL}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[hub] ${signal} -> shutdown`);
    server.close(() => process.exit(0));
  });
}
