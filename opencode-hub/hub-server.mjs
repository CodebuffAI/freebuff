/**
 * opencode-hub — server halaman (port 3000).
 *
 * Menyajikan:
 *  - halaman dashboard (public/)
 *  - /api/state        : status server opencode + status server data
 *  - /api/resources    : proxy ke server data (port terpisah)
 *  - /api/opencode/sessions : daftar sesi opencode (read-only)
 *
 * Server opencode TIDAK diproksi mentah-mentah: hanya endpoint read-only yang
 * dibutuhkan halaman ini. API opencode memberi kendali penuh atas filesystem
 * dan sesi agen, jadi jangan pernah diekspos publik tanpa OPENCODE_SERVER_PASSWORD.
 */
import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HUB_PORT = Number(process.env.HUB_PORT ?? 3000);
const HUB_HOST = process.env.HUB_HOST ?? "0.0.0.0";
const OPENCODE_URL = (process.env.OPENCODE_URL ?? "http://127.0.0.1:4096").replace(/\/+$/, "");
const OPENCODE_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const DATA_URL = (process.env.DATA_URL ?? "http://127.0.0.1:8788").replace(/\/+$/, "");
const STARTED_AT = new Date();

const PUBLIC_FILES = new Map([
  ["/chat", { file: "chat.html", type: "text/html; charset=utf-8" }],
  ["/hub", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/hub/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
]);

/** Password opencode dipakai hub sendiri, jadi UI di akar origin tidak perlu login. */
const OPENCODE_AUTH = OPENCODE_PASSWORD
  ? `Basic ${Buffer.from(`opencode:${OPENCODE_PASSWORD}`).toString("base64")}`
  : null;

async function getJson(url, timeoutMs = 2500, headers = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text.slice(0, 200);
    }
    return { ok: res.ok, status: res.status, body, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, status: 0, body: null, latencyMs: Date.now() - started, error: error.name };
  }
}

/** opencode accepts the password as a bearer token; basic auth is the fallback. */
function authVariants() {
  if (!OPENCODE_PASSWORD) return [{}];
  return [
    { authorization: `Bearer ${OPENCODE_PASSWORD}` },
    { authorization: `Basic ${Buffer.from(`opencode:${OPENCODE_PASSWORD}`).toString("base64")}` },
  ];
}

async function probeOpencode(path) {
  let last;
  for (const headers of authVariants()) {
    last = await getJson(`${OPENCODE_URL}${path}`, 2500, headers);
    if (last.status !== 401) return last;
  }
  return last;
}

async function buildState() {
  const [health, sessions, dataHealth] = await Promise.all([
    probeOpencode("/global/health"),
    probeOpencode("/session"),
    getJson(`${DATA_URL}/health`),
  ]);

  const sessionList = Array.isArray(sessions.body) ? sessions.body : [];

  return {
    checkedAt: new Date().toISOString(),
    hub: {
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: STARTED_AT.toISOString(),
      port: HUB_PORT,
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

let cache = { at: 0, value: null };
async function state() {
  if (cache.value && Date.now() - cache.at < 2000) return cache.value;
  cache = { at: Date.now(), value: await buildState() };
  return cache.value;
}

/**
 * Pintu /oc: memproksi UI web opencode lewat port hub, supaya bisa dibuka dari satu
 * origin. Browser tetap harus mengirim Basic auth (user "opencode" + password server),
 * dan header itu diteruskan apa adanya ke opencode — password tidak pernah disuntikkan
 * oleh hub, jadi tidak ada jalan masuk tanpa kredensial.
 */
function basicAuthOk(req) {
  if (!OPENCODE_PASSWORD) return true;
  const match = /^Basic (.+)$/i.exec(req.headers.authorization ?? "");
  if (!match) return false;
  const decoded = Buffer.from(match[1], "base64").toString();
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return decoded.slice(0, separator) === "opencode" && decoded.slice(separator + 1) === OPENCODE_PASSWORD;
}

function requireAuth(res) {
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="OpenCode", charset="UTF-8"',
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end("Butuh password server opencode (user: opencode).\n");
}

function proxyOpencode(req, res, upstreamPath) {
  const target = new URL(OPENCODE_URL);
  const headers = { ...req.headers, host: target.host };
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
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    console.error("[hub] proxy opencode gagal", error.message);
    if (!res.headersSent) json(res, 502, { error: "opencode_unreachable", detail: error.message });
    else res.end();
  });
  req.pipe(upstream);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  try {
    if (url.pathname === "/api/state") {
      return json(res, 200, await state());
    }

    if (url.pathname === "/api/resources") {
      const upstream = await getJson(`${DATA_URL}/api/resources`, 3000);
      if (!upstream.ok) {
        return json(res, 502, {
          error: "data_server_unreachable",
          url: DATA_URL,
          detail: upstream.error ?? upstream.status,
        });
      }
      return json(res, 200, upstream.body);
    }

    if (url.pathname === "/api/opencode/sessions") {
      const upstream = await probeOpencode("/session");
      if (!upstream.ok) {
        return json(res, 502, {
          error: "opencode_unreachable",
          url: OPENCODE_URL,
          detail: upstream.error ?? upstream.status,
        });
      }
      const list = (Array.isArray(upstream.body) ? upstream.body : []).slice(0, 20).map((s) => ({
        id: s.id,
        title: s.title ?? "(tanpa judul)",
        updated: s.time?.updated ?? null,
      }));
      return json(res, 200, { url: OPENCODE_URL, count: list.length, sessions: list });
    }

    if (url.pathname === "/api/health") {
      return json(res, 200, { ok: true, service: "opencode-hub", uptimeSeconds: Math.round(process.uptime()) });
    }

    // UI opencode asli dilayani di akar origin.
    if (url.pathname === "/oc" || url.pathname === "/app") {
      res.writeHead(302, { location: "/", "cache-control": "no-store" });
      return res.end();
    }

    const asset = PUBLIC_FILES.get(url.pathname);
    if (asset) {
      const body = await readFile(join(__dirname, "public", asset.file));
      res.writeHead(200, {
        "content-type": asset.type,
        "content-length": body.length,
        "cache-control": "no-store",
      });
      return res.end(body);
    }

    // Sisanya milik opencode: /, /assets/*, /favicon*, /session, /event, dan rute SPA-nya.
    return proxyOpencode(req, res, req.url ?? "/");
  } catch (error) {
    console.error("[hub] request failed", error);
    return json(res, 500, { error: "internal_error" });
  }
});

// WebSocket/upgrade (kalau UI opencode memakainya) ikut diteruskan, tetap dengan auth.
server.on("upgrade", (req, socket, head) => {
  const target = new URL(OPENCODE_URL);
  const upstreamHeaders = { ...req.headers, host: target.host };
  if (OPENCODE_AUTH) upstreamHeaders.authorization = OPENCODE_AUTH;
  const upstream = httpRequest({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 80,
    path: (req.url ?? "/").replace(/^\/oc(?=\/|$)/, "") || "/",
    method: req.method,
    headers: upstreamHeaders,
  });
  upstream.on("upgrade", (up, upSocket, upHead) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\n" + Object.entries(up.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket).pipe(upSocket);
  });
  upstream.on("error", () => socket.destroy());
  upstream.end();
});

server.listen(HUB_PORT, HUB_HOST, () => {
  console.log(`[hub] page on http://${HUB_HOST}:${HUB_PORT} (pid ${process.pid})`);
  console.log(`[hub] opencode target: ${OPENCODE_URL}${OPENCODE_PASSWORD ? " (password set)" : ""}`);
  console.log(`[hub] data   target: ${DATA_URL}`);
  console.log(`[hub] UI opencode asli di / (akar origin)`);
  console.log(`[hub] chat ringkas buatan hub di /chat`);
  console.log(`[hub] dashboard hub di /hub`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[hub] ${signal} -> shutdown`);
    server.close(() => process.exit(0));
  });
}
