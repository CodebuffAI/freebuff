import { SitesClientError } from './errors'
import { realtimeWorkerSource } from './realtime-worker'
import { NEXT_WRANGLER_VERSION } from './versions'

const RESULT_PREFIX = 'FREEBUFF_REALTIME_RESULT:'
const ERROR_PREFIX = 'FREEBUFF_REALTIME_ERROR:'
export const REALTIME_LOCAL_WORKER = 'freebuff-sites-realtime-local'
export const REALTIME_LOCAL_BINDING = {
  name: 'REALTIME',
  class_name: 'FreebuffRealtime',
  script_name: REALTIME_LOCAL_WORKER,
} as const

export type RealtimePreparationResult = {
  directory: string
  localWranglerConfigPath: string
  serverModulePath: string
  browserModulePath: string
  readmePath: string
  created: string[]
  preserved: string[]
}

/** These are workspace source files, not a separately published SDK. */
export function realtimePreparationFiles(): Record<string, string> {
  return {
    'worker.js': realtimeWorkerSource(true),
    'wrangler.jsonc':
      JSON.stringify(
        {
          name: REALTIME_LOCAL_WORKER,
          main: 'worker.js',
          compatibility_date: '2026-10-01',
          dev: { ip: '127.0.0.1', port: 8788 },
          durable_objects: {
            bindings: [{ name: 'REALTIME', class_name: 'FreebuffRealtime' }],
          },
          migrations: [{ tag: 'v1', new_sqlite_classes: ['FreebuffRealtime'] }],
        },
        null,
        2,
      ) + '\n',
    'server.js': REALTIME_SERVER_MODULE,
    'browser.js': REALTIME_BROWSER_MODULE,
    'README.md': REALTIME_README,
  }
}

export function realtimePreparationScript(
  options: { projectDirectory?: string } = {},
): string {
  return (
    `const input = ${JSON.stringify({ projectDirectory: options.projectDirectory ?? '.', files: realtimePreparationFiles() })};\n` +
    REALTIME_PREPARATION_PROGRAM
  )
}

export function parseRealtimePreparationOutput(
  stdout: string,
): RealtimePreparationResult {
  const line = stdout
    .split('\n')
    .findLast((line) => line.startsWith(RESULT_PREFIX))
  if (!line)
    throw new Error('Realtime preparation did not return workspace paths.')
  const value = JSON.parse(
    line.slice(RESULT_PREFIX.length),
  ) as RealtimePreparationResult
  if (
    ![
      'directory',
      'localWranglerConfigPath',
      'serverModulePath',
      'browserModulePath',
      'readmePath',
    ].every(
      (key) =>
        typeof value[key as keyof RealtimePreparationResult] === 'string',
    ) ||
    ![value.created, value.preserved].every(
      (paths) =>
        Array.isArray(paths) && paths.every((path) => typeof path === 'string'),
    )
  ) {
    throw new Error('Invalid realtime preparation result.')
  }
  return value
}

export function parseRealtimePreparationError(
  stdout: string,
): string | undefined {
  return stdout
    .split('\n')
    .findLast((line) => line.startsWith(ERROR_PREFIX))
    ?.slice(ERROR_PREFIX.length, ERROR_PREFIX.length + 4096)
    .trim()
}

export async function prepareRealtimeSite(
  cwd: string,
  projectDirectory = '.',
  signal?: AbortSignal,
): Promise<RealtimePreparationResult> {
  // This program comes from stdin, not a file to bundle. Keep the native
  // import at runtime so Turbopack does not trace Node's flags as file paths.
  const { spawn } = await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ 'node:child_process'
  )
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('node', ['--input-type=module', '-'], {
      cwd,
      signal: AbortSignal.any([
        AbortSignal.timeout(30_000),
        ...(signal ? [signal] : []),
      ]),
      // File generation needs no inherited provider credentials or Node hooks.
      env: {
        NODE_ENV: 'development',
        ...Object.fromEntries(
          ['PATH', 'SystemRoot', 'TMPDIR', 'TEMP']
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key]]),
        ),
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let output = ''
    child.stdout.on('data', (data: Buffer) => {
      output = (output + data.toString()).slice(-64 * 1024)
    })
    child.once('error', () =>
      reject(
        new SitesClientError(
          400,
          'realtime_prepare_failed',
          'Realtime preparation needs Node.js in the workspace PATH.',
        ),
      ),
    )
    child.once('close', (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new SitesClientError(
              400,
              'realtime_prepare_failed',
              parseRealtimePreparationError(output) ??
                'Could not prepare realtime files in this workspace.',
            ),
          ),
    )
    // Stream source instead of putting it in argv (Windows caps argv at 32K).
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') return
      child.kill()
      reject(
        new SitesClientError(
          400,
          'realtime_prepare_failed',
          'Could not send the realtime preparation program to Node.js.',
        ),
      )
    })
    child.stdin.end(realtimePreparationScript({ projectDirectory }))
  })
  return parseRealtimePreparationOutput(stdout)
}

const REALTIME_PREPARATION_PROGRAM = String.raw`
import { realpath, mkdir, lstat, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, sep } from 'node:path';
const safeError = (message) => Object.assign(new Error(message), { safe: true });
try {
  const root = await realpath(process.cwd());
  const project = await realpath(resolve(root, input.projectDirectory));
  const rel = relative(root, project);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw safeError('Choose a project directory inside this workspace.');
  const directory = join(project, 'freebuff-realtime');
  try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw safeError('freebuff-realtime must be a regular directory, not a symlink.');
  const created = [], preserved = [];
  for (const [name, content] of Object.entries(input.files)) {
    const path = join(directory, name);
    try { await writeFile(path, content, { flag: 'wx' }); created.push(name); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await lstat(path);
      if (existing.isSymbolicLink() || !existing.isFile()) throw safeError('Existing realtime files must be regular files, not symlinks.');
      preserved.push(name);
    }
  }
  const path = (name) => relative(root, join(directory, name)).split(sep).join('/');
  process.stdout.write('FREEBUFF_REALTIME_RESULT:' + JSON.stringify({ directory: path(''), localWranglerConfigPath: path('wrangler.jsonc'), serverModulePath: path('server.js'), browserModulePath: path('browser.js'), readmePath: path('README.md'), created, preserved }) + '\n');
} catch (error) {
  process.stdout.write('FREEBUFF_REALTIME_ERROR:' + (error?.safe ? error.message : 'Could not prepare realtime files in this workspace.') + '\n');
  process.exitCode = 1;
}
`

const REALTIME_SERVER_MODULE = String.raw`// Import only from server-side Worker code. Authentication and room membership
// must be checked before calling createRealtimeTicket or publishRealtime.
function hub(env) {
  if (!env.REALTIME) throw new Error('Enable realtime in the Sites deploy manifest and configure the local REALTIME binding.');
  return env.REALTIME.get(env.REALTIME.idFromName('hub'));
}
async function call(env, path, body) {
  const response = await hub(env).fetch(new Request('https://realtime' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  if (!response.ok) throw new Error('Realtime request failed (' + response.status + ').');
  return response;
}
export async function createRealtimeTicket(env, { room, userId, origin, publish = false, presence = false }) {
  return (await call(env, '/ticket', { room, userId, origin, publish, presence })).json();
}
export async function publishRealtime(env, { room, event, data }) {
  await call(env, '/publish', { room, event, data });
}
`

const REALTIME_BROWSER_MODULE = String.raw`// No tickets are persisted. Every reconnect reauthorizes through your app API.
export function connectRealtime({ ticketUrl = '/api/realtime/ticket', room, onMessage = () => {}, onStatus = () => {}, websocketUrl = (url) => url }) {
  const endpoint = new URL(ticketUrl, window.location.href);
  if (endpoint.origin !== window.location.origin) throw new Error('The realtime ticket endpoint must be same-origin.');
  let socket, timer, renewal, stopped = false, retry = 0, pending;
  const members = new Map(), encoder = new TextEncoder();
  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024) return false;
    try {
      if (message.type === 'presence' && encoder.encode(JSON.stringify(message.data)).length > 1024) return false;
      const payload = JSON.stringify(message);
      if (encoder.encode(payload).length > 16 * 1024) return false;
      socket.send(payload); return true;
    } catch { return false; }
  }
  const retire = (connection) => {
    clearTimeout(renewal); renewal = undefined;
    if (!connection) return;
    connection.onmessage = connection.onclose = connection.onerror = null;
    if (socket === connection) socket = undefined;
    try { connection.close(1000, 'Authorization renewal'); } catch {}
  };
  const schedule = () => {
    clearTimeout(timer);
    if (stopped) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(retry++, 6)) * (0.5 + Math.random());
    timer = setTimeout(() => { timer = undefined; open(); }, delay);
  };
  async function open() {
    if (stopped || pending) return;
    onStatus('connecting');
    const controller = new AbortController(); pending = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room }), signal: controller.signal });
      if (stopped) return;
      if (response.status === 401 || response.status === 403) { stopped = true; onStatus('unauthorized'); return; }
      if (!response.ok) throw new Error('Ticket request failed.');
      const ticket = await response.json();
      if (stopped) return;
      const connection = new WebSocket(websocketUrl(ticket.websocketUrl));
      socket = connection;
      connection.onmessage = ({ data }) => {
        if (stopped || socket !== connection) return;
        let message; try { message = JSON.parse(data); } catch { return; }
        if (message.type === 'ready') {
          retry = 0; members.clear(); clearTimeout(renewal);
          const expiresInMs = Number.isFinite(message.expiresInMs) ? Math.max(1_000, Math.min(300_000, message.expiresInMs)) : 300_000;
          // Renew shortly before expiry, even if the server's Close handshake
          // lingers. One browser timer replaces heartbeats and server timers.
          const delay = Math.max(250, expiresInMs - 500 - Math.random() * 500);
          renewal = setTimeout(() => {
            if (stopped || socket !== connection) return;
            retire(connection); open();
          }, delay);
          onStatus('connected');
        }
        if (message.type === 'presence') { members.clear(); for (const member of message.members) members.set(member.connectionId, member); }
        if (message.type === 'presence_update') {
          members.set(message.member.connectionId, message.member);
          onMessage({ type: 'presence', members: [...members.values()] }); return;
        }
        onMessage(message);
      };
      connection.onclose = () => {
        if (stopped || socket !== connection) return;
        retire(connection); onStatus('disconnected'); schedule();
      };
      connection.onerror = () => {
        if (stopped || socket !== connection) return;
        retire(connection); onStatus('disconnected'); schedule();
      };
    } catch { if (!stopped) { onStatus('disconnected'); schedule(); } }
    finally { clearTimeout(timeout); if (pending === controller) pending = undefined; }
  }
  open();
  return {
    broadcast(event, data) { return send({ type: 'broadcast', event, data }); },
    presence(data) { return send({ type: 'presence', data }); },
    close() { stopped = true; clearTimeout(timer); pending?.abort(); retire(socket); onStatus('closed'); },
  };
}
`

const REALTIME_README = String.raw`# Freebuff Sites realtime

Room broadcasts and presence use a platform-managed hibernating Cloudflare
Durable Object. Add "realtime": true to your Sites deploy manifest. Each site
environment has its own REALTIME binding; no account keys or npm SDK are needed.
These generated workspace files are never overwritten by preparation. Read and
adapt server.js/browser.js; keep worker.js and wrangler.jsonc for local testing
only. Do not upload that helper Worker as your site's Worker.

## Authorize tickets in an HTTP route

Import createRealtimeTicket from ./freebuff-realtime/server.js on the server.
Implement POST /api/realtime/ticket using @freebuff/auth's documented getUser
and isSameOriginRequest helpers. Require JSON, authenticate the session, validate
room, and query D1 to verify that user.sub is a member of that room. Reject
unauthorized requests with 401/403. Never accept userId, origin, publish or
presence from the browser. Choose capabilities based on the user's permissions:

    const ticket = await createRealtimeTicket(env, {
      room, userId: user.sub, origin: env.APP_ORIGIN,
      publish: false, presence: true,
    });
    return Response.json(ticket, { headers: { 'Cache-Control': 'private, no-store' } });

Use the exact configured application origin, not a Host header. For local tests
use your configured development auth APP_ORIGIN. Production connections use the
canonical Sites origin; a custom-domain app needs deliberate canonical-origin
navigation for this first version. Tickets are single-use and expire in 30s.
Sockets reconnect after 5 minutes, rechecking application access through this
route. Sign-out should close the socket immediately. Membership removal takes
effect on the next ticket request (at most the current socket lifetime).

Next.js: implement a normal HTTP route with @freebuff/auth/next and
getCloudflareContext().env. There is no WebSocket upgrade inside a Next route;
the Sites dispatcher owns /.well-known/freebuff/realtime. Call
sites_prepare_next with realtime:true to include the manifest and local binding.

## Connect in the browser

    import { connectRealtime } from './freebuff-realtime/browser.js';
    const connection = connectRealtime({ room: 'project:123', onMessage(message) {
      if (message.type === 'ready') reloadAuthoritativeSnapshot();
      if (message.type === 'broadcast') applyEvent(message);
      if (message.type === 'presence') renderPresence(message.members);
    }});
    connection.presence({ cursor: { x: 10, y: 20 } });
    // Only if your server issued publish:true (untrusted client events):
    connection.broadcast('cursor', { x: 10, y: 20 });
    // On unmount/sign-out:
    connection.close();

Protocol: ready contains connectionId, userId, room, expiresAt and expiresInMs.
The client uses one renewal timer based on the server's remaining expiresInMs
duration, so a skewed browser clock cannot cause a renewal loop. It obtains a
fresh ticket shortly before expiry and
does not wait for a potentially delayed socket close handshake. broadcast contains event,
data, userId and connectionId. presence contains members [{connectionId,userId,data}].
The wire protocol sends presence_update {member} for individual changes; browser.js
normalizes these deltas into presence snapshots for onMessage. broadcast/presence
return false when disconnected, oversized or the outgoing socket buffer is full;
coalesce transient updates instead of queuing them. Messages are at most 16 KiB;
presence data is at most 1 KiB. A room supports 32 connections, and an environment
supports 128 connections across 32 rooms. These limits are shared across users.
Treat all payloads and presence data as untrusted; render text safely. Broadcasts
are ephemeral, without replay or delivery guarantees. Keep durable state in D1/R2
and refresh a snapshot on every ready event; reconcile concurrent snapshots and
updates using application revisions. Persist critical actions through an
authenticated HTTP mutation and call publishRealtime(env,{room,event,data})
AFTER the database transaction succeeds. These server events are trusted only
when the room's clients cannot publish the same event. The server should own
scores, inventory, money and game rules. Realtime is not automatic D1 changefeed
or a high-frequency authoritative physics engine. Batch/throttle cursor updates;
do not send heartbeats. Limits apply per environment and per connection.

## Local Workers preview

Install Wrangler ${NEXT_WRANGLER_VERSION}, the supported version used by Sites,
with your project package manager (for npm: npm install --save-dev --save-exact
wrangler@${NEXT_WRANGLER_VERSION}). Add this binding to your
application's local Wrangler configuration, preserving its existing bindings:

    "durable_objects": { "bindings": [{
      "name": "REALTIME", "class_name": "FreebuffRealtime",
      "script_name": "freebuff-sites-realtime-local"
    }] }

Start the helper first in one terminal, then the app in a second terminal:

    npx wrangler dev --local -c freebuff-realtime/wrangler.jsonc --inspector-port 9230
    npx wrangler dev --local -c wrangler.jsonc --inspector-port 9229

The helper listens on 8788 and the app normally on 8787. Separate dev processes
connect through Wrangler's local registry on the same machine/user; the app
should show REALTIME as connected. A single multi-config command only exposes
the first Worker's HTTP port, so it cannot serve the helper WebSocket URL.
Use distinct inspector ports as shown, and stop both servers after testing.
For Next.js, replace the app config with freebuff.wrangler.jsonc after
sites_prepare_next({realtime:true}); use this Workers preview to test realtime.
The ordinary next dev preview does not start the helper Worker automatically;
neither preview mode needs an application route that proxies WebSocket upgrades.
No Cloudflare login/credentials are used; storage is local. Open two browser
tabs, verify broadcasts/presence, reject a nonmember, disconnect/reconnect and
verify snapshot recovery. Preview and production are isolated on deploy.
Local helper URLs use ws://127.0.0.1:8788. In a Cloud VM, add --ip 0.0.0.0 to both
commands, expose helper port 8788 using the preview network and pass
websocketUrl: url => { const parsed = new
URL(url); return 'wss://YOUR_HELPER_PREVIEW_HOST' + parsed.pathname + parsed.search; }
to connectRealtime. Never rewrite a production ticket URL to an untrusted host.
Use the exact Cloud application preview origin in the ticket route; do not send
real user data through a publicly exposed development helper. Test hosted auth
on a deployed Sites preview when the provider does not accept the VM origin.

Publishing: deploy the application's prebuilt modules/assets only. Set realtime:
true in the manifest, or retain the local REALTIME binding for automatic Worker
publishing. Sites provisions the managed helper and injects REALTIME. The local
worker source/config and generated SDK files alone do not deploy or publish.
`
