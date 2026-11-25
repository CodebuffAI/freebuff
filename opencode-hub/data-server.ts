#!/usr/bin/env node
/**
 * opencode-hub — server data (TERPISAH dari server opencode).
 *
 * Ported to Prisma Composer: port from service.port(), config from service.input().
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import service from './data-service.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = service.port();
const HOST = '0.0.0.0';
const STARTED_AT = new Date();

const registry = JSON.parse(
  await readFile(join(__dirname, 'data', 'resources.json'), 'utf8'),
);

let hits = 0;

function json(res: any, status: number, body: any) {
  const payload = JSON.stringify(body, null, 2);
  const input = service.input();
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'access-control-allow-origin': input.allowOrigin,
  });
  res.end(payload);
}

const server = createServer(async (req: any, res: any) => {
  hits += 1;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    const input = service.input();
    res.writeHead(204, {
      'access-control-allow-origin': input.allowOrigin,
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    });
    return res.end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { error: 'method_not_allowed' });
  }

  if (url.pathname === '/health') {
    return json(res, 200, {
      service: 'opencode-hub-data',
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: STARTED_AT.toISOString(),
      pid: process.pid,
      hits,
      groups: registry.groups.length,
      resources: registry.groups.reduce((n: number, g: any) => n + g.items.length, 0),
    });
  }

  if (url.pathname === '/api/resources') {
    const group = url.searchParams.get('group');
    if (!group) return json(res, 200, registry);

    const found = registry.groups.find((g: any) => g.id === group);
    if (!found) return json(res, 404, { error: 'unknown_group', group });
    return json(res, 200, { updated: registry.updated, groups: [found] });
  }

  if (url.pathname === '/') {
    return json(res, 200, {
      service: 'opencode-hub-data',
      endpoints: {
        '/health': 'status server data',
        '/api/resources': 'semua grup tautan',
        '/api/resources?group=opencode': 'filter satu grup',
      },
    });
  }

  return json(res, 404, { error: 'not_found', path: url.pathname });
});

server.listen(PORT, HOST, () => {
  console.log(`[data] listening on http://${HOST}:${PORT} (pid ${process.pid})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[data] ${signal} -> shutdown`);
    server.close(() => process.exit(0));
  });
}
