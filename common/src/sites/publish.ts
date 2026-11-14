import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { SitesClientError } from './errors'
import {
  NEXT_WRANGLER_VERSION,
  nextPreparationEnvironment,
} from './next-prepare'
import { SITE_DEPLOY_MANIFEST_FILES } from './project-context'
import type { SitePublishEvent, SitePublishResult } from './publish-events'

/**
 * Deterministic publishing for the chat Publish button: no agent turn. The
 * preparation program builds the project and writes a deploy manifest, then
 * `publishSite` drives the same Sites tools an agent would (create, auth,
 * storage, deploy, publish). Anything it cannot handle is a clear error the
 * UI can hand to the agent instead.
 */
export const SITE_PREPARE_RESULT_PREFIX = 'FREEBUFF_SITE_RESULT:'
export const SITE_PREPARE_ERROR_PREFIX = 'FREEBUFF_SITE_ERROR:'
/** Deployed with the same date Next.js preparation uses. */
export const SITE_COMPATIBILITY_DATE = '2026-10-01'
export const SITE_ALLOWED_COMPATIBILITY_FLAGS = [
  'nodejs_compat',
  'global_fetch_strictly_public',
  'disable_ctx_exports',
] as const

export type SitePreparationResult = {
  kind: 'manifest' | 'worker' | 'static' | 'next'
  /** Absent for Next.js, which `sites_prepare_next` prepares next. */
  manifestPath?: string
  usesAuth: boolean
  storage: { d1: string[]; r2: string[] }
  name?: string
  logPath?: string
}

type Manager = 'npm' | 'pnpm' | 'yarn' | 'bun'
type Invocation = {
  command: string
  args: string[]
  windowsVerbatimArguments: boolean
}

/** Only fixed package-manager words enter cmd.exe; project paths never do. */
export function packageInvocation(
  manager: Manager,
  action: 'install' | 'build' | 'wrangler',
  platform: string,
): Invocation {
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(manager))
    throw new Error('Unsupported package manager')
  const args =
    action === 'install'
      ? ['install']
      : action === 'build'
        ? ['run', 'build']
        : manager === 'npm'
          ? ['install', '--save-dev', '--save-exact', `wrangler@${NEXT_WRANGLER_VERSION}`]
          : manager === 'pnpm'
            ? ['add', '--save-dev', '--save-exact', `wrangler@${NEXT_WRANGLER_VERSION}`]
            : ['add', '--dev', '--exact', `wrangler@${NEXT_WRANGLER_VERSION}`]
  if (platform !== 'win32' || manager === 'bun')
    return { command: manager, args, windowsVerbatimArguments: false }
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `${manager}.cmd ${args.join(' ')}`],
    windowsVerbatimArguments: true,
  }
}

/** The credential-free program that runs in a local workspace and a Cloud VM alike. */
export function sitePreparationScript(): string {
  const managers: Manager[] = ['npm', 'pnpm', 'yarn', 'bun']
  const commands = Object.fromEntries(
    ['win32', 'posix'].map((platform) => [
      platform,
      Object.fromEntries(
        managers.map((manager) => [
          manager,
          Object.fromEntries(
            (['install', 'build', 'wrangler'] as const).map((action) => [
              action,
              packageInvocation(manager, action, platform),
            ]),
          ),
        ]),
      ),
    ]),
  )
  return (
    `const input = ${JSON.stringify({
      commands,
      manifestFiles: SITE_DEPLOY_MANIFEST_FILES,
      compatibilityDate: SITE_COMPATIBILITY_DATE,
      allowedFlags: SITE_ALLOWED_COMPATIBILITY_FLAGS,
    })};\n` + SITE_PREPARATION_PROGRAM
  )
}

export function parseSitePreparationOutput(
  stdout: string,
): SitePreparationResult {
  const line = stdout
    .split('\n')
    .findLast((line) => line.startsWith(SITE_PREPARE_RESULT_PREFIX))
  if (!line) throw new Error('Site preparation did not return a result.')
  const value = JSON.parse(
    line.slice(SITE_PREPARE_RESULT_PREFIX.length),
  ) as SitePreparationResult
  const names = (list: unknown) =>
    Array.isArray(list) &&
    list.every(
      (name) => typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(name),
    )
  if (
    !['manifest', 'worker', 'static', 'next'].includes(value.kind) ||
    (value.kind !== 'next' && typeof value.manifestPath !== 'string') ||
    typeof value.usesAuth !== 'boolean' ||
    !names(value.storage?.d1) ||
    !names(value.storage?.r2)
  )
    throw new Error('Invalid site preparation result.')
  return value
}

/** Only the bounded, program-generated message may reach the user. */
export function parseSitePreparationError(output: string): string | undefined {
  return output
    .split('\n')
    .findLast((line) => line.startsWith(SITE_PREPARE_ERROR_PREFIX))
    ?.slice(
      SITE_PREPARE_ERROR_PREFIX.length,
      SITE_PREPARE_ERROR_PREFIX.length + 4096,
    )
    .trim()
}

const preparationFailed = (message?: string) =>
  new SitesClientError(
    400,
    'site_prepare_failed',
    message ??
      'The site build failed. Inspect freebuff-sites-build/build.log in the project.',
  )

/** Run the preparation program in a local workspace, as `prepareNextSite` does. */
export async function prepareSiteLocally(
  cwd: string,
  signal?: AbortSignal,
): Promise<SitePreparationResult> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const buildSignal = AbortSignal.any([
      AbortSignal.timeout(15 * 60 * 1000),
      ...(signal ? [signal] : []),
    ])
    const child = spawn(
      'node',
      ['--input-type=module', '-e', sitePreparationScript()],
      {
        cwd,
        signal: buildSignal,
        detached: process.platform !== 'win32',
        env: nextPreparationEnvironment(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const stop = () => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          /* Already exited. */
        }
      }
    }
    buildSignal.addEventListener('abort', stop, { once: true })
    let output = ''
    child.stdout.on('data', (data: Buffer) => {
      output = (output + data.toString()).slice(-64 * 1024)
    })
    child.stderr.on('data', () => {})
    child.once('error', () =>
      reject(
        preparationFailed(
          buildSignal.aborted
            ? 'Publishing was cancelled or the build exceeded its 15-minute limit.'
            : 'Publishing needs Node.js 20.19 or newer in the workspace PATH.',
        ),
      ),
    )
    child.once('close', (code) => {
      buildSignal.removeEventListener('abort', stop)
      if (code === 0) resolve(output)
      else reject(preparationFailed(parseSitePreparationError(output)))
    })
  })
  try {
    return parseSitePreparationOutput(stdout)
  } catch {
    throw preparationFailed()
  }
}

type ToolRefusal = { error: string; message?: string }
function refusal(value: unknown): ToolRefusal | null {
  const error = (value as { error?: unknown } | null)?.error
  return typeof error === 'string' ? (value as ToolRefusal) : null
}
type Operation = {
  id: string
  state: 'running' | 'succeeded' | 'failed' | 'unknown'
  result?: {
    url?: string
    error?: string
    provider?: { codes?: number[]; stage?: string; status?: number }
  } | null
}
type SiteEnvironment = {
  url: string
  published?: boolean
  deployed_at?: string | null
  unpublished_at?: string | null
  auth?: unknown
  bindings?: { name: string; kind: string }[]
}

// Older backends have the timestamps but no explicit publication field.
function isPublished(environment: SiteEnvironment): boolean {
  return (
    environment.published ??
    Boolean(environment.deployed_at && !environment.unpublished_at)
  )
}

/** Receipts keep only codes; say what each means without vendor prose. */
export function operationFailureMessage(operation: Operation): string {
  const result = operation.result
  if (operation.state === 'unknown')
    return 'Cloudflare did not confirm the deployment. Publish again in 10 minutes: Freebuff first checks with Cloudflare whether this one landed.'
  // Settled later from Cloudflare's state (web reconcile.ts) without landing.
  if (result?.error === 'cloudflare_outcome_unknown')
    return 'Cloudflare did not confirm the deployment. Publish again.'
  // The server stopped before recording a result, then settled it the same way.
  if (result?.error === 'request_interrupted')
    return 'Freebuff was interrupted before it recorded the deployment. Publish again.'
  // No upload starts 15 minutes into a deployment (web reconcile.ts).
  if (result?.error === 'operation_deadline')
    return 'The deployment ran out of time and was stopped before it went live. Publish again.'
  const provider = result?.provider
  if (provider?.stage === 'worker_upload' && provider.codes?.includes(10021))
    return 'Cloudflare could not start the built Worker: it failed startup validation. This usually means code that cannot run on Workers, such as a Node.js-only module.'
  if (provider?.status === 429)
    return 'Cloudflare is rate limiting deployments. Try again in a minute.'
  if (result?.error === 'opennext_manifest_required')
    return 'This environment hosts a Next.js app. Publish the Next.js project to it.'
  return 'Cloudflare rejected the deployment.'
}

export async function publishSite(options: {
  environment: 'preview' | 'production'
  /** The site to update; absent creates one for this project. */
  siteId?: string
  siteName?: string
  /** Runs one Sites tool with the caller's credentials and workspace. */
  tool: (name: string, args: Record<string, unknown>) => Promise<unknown>
  prepare: () => Promise<SitePreparationResult>
  onEvent: (event: SitePublishEvent) => void
  id?: () => string
  /** Waits between polls of a deployment still running. */
  sleep?: (ms: number) => Promise<void>
  /** A caller's own user-facing errors (Cloud workspace states); others stay generic. */
  errorMessage?: (error: unknown) => string | undefined
}): Promise<SitePublishResult> {
  const id = options.id ?? randomUUID
  const { environment } = options
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const fail = (message: string) => {
    const event = { type: 'error' as const, message }
    options.onEvent(event)
    return event
  }
  const call = async <T>(name: string, args: Record<string, unknown>) => {
    const value = await options.tool(name, args)
    const refused = refusal(value)
    if (refused)
      throw new SitesClientError(
        400,
        refused.error,
        refused.message ?? 'The Sites request failed.',
      )
    return value as T
  }
  try {
    options.onEvent({ type: 'stage', stage: 'building' })
    const prepared = await options.prepare()
    let manifestPath = prepared.manifestPath
    if (prepared.kind === 'next')
      manifestPath = (
        await call<{ manifestPath: string }>('sites_prepare_next', {})
      ).manifestPath
    if (!manifestPath) return fail('The build did not produce a deployment.')

    options.onEvent({ type: 'stage', stage: 'deploying' })
    let siteId = options.siteId
    if (!siteId) {
      siteId = id()
      const name =
        (options.siteName ?? prepared.name ?? '').trim().slice(0, 80) ||
        'My site'
      await call('sites_create', { siteId, name })
    }
    const target = { siteId, environment }
    const inspect = () =>
      call<{ environment: SiteEnvironment }>('sites_inspect', target)
    const inspected = await inspect()
    const details = inspected.environment
    if (prepared.usesAuth && !details.auth)
      await call('sites_enable_auth', target)
    const existing = new Set((details.bindings ?? []).map((b) => b.name))
    for (const kind of ['d1', 'r2'] as const)
      for (const name of prepared.storage[kind]) {
        if (existing.has(name)) continue
        const added = await call<{ operation?: Operation }>(
          'sites_add_storage',
          { ...target, requestId: id(), kind, name },
        )
        if (added.operation && added.operation.state !== 'succeeded')
          return fail(
            `Could not create the ${kind === 'd1' ? 'database' : 'storage bucket'} ${name}. Check deployment activity in Manage site.`,
          )
      }

    const requestId = id()
    let operation = (
      await call<{ operation: Operation }>('sites_deploy', {
        ...target,
        requestId,
        manifestPath,
      })
    ).operation
    // Deployments normally settle in the request; a slow one is polled by key.
    for (let i = 0; operation.state === 'running' && i < 30; i++) {
      await sleep(2000)
      const activity = (
        await call<{
          activity?: { operations?: Operation[] }
        }>('sites_inspect', target)
      ).activity
      operation =
        activity?.operations?.find((op) => op.id === operation.id) ?? operation
    }
    if (operation.state === 'running')
      return fail(
        'The deployment is still running. Check deployment activity in Manage site.',
      )
    if (operation.state !== 'succeeded')
      return fail(operationFailureMessage(operation))

    // A successful upload is not publication. Republish only when this request
    // started with an unpublished environment; preserve a newer Unpublish.
    let current = (await inspect()).environment
    if (!isPublished(current) && details.unpublished_at) {
      options.onEvent({ type: 'stage', stage: 'publishing' })
      const publication = await call<{ operation: Operation }>(
        'sites_set_published',
        {
          ...target,
          published: true,
          requestId: id(),
        },
      )
      if (publication.operation.state !== 'succeeded')
        return fail(
          'Publication was not confirmed. Check deployment activity in Manage site.',
        )
      current = (await inspect()).environment
    }
    if (!isPublished(current))
      return fail(
        'The deployment succeeded, but this environment is unpublished. Check Publication in Manage site.',
      )
    const event = {
      type: 'done' as const,
      siteId,
      environment,
      url: operation.result?.url ?? details.url,
    }
    options.onEvent(event)
    return event
  } catch (error) {
    return fail(
      error instanceof SitesClientError
        ? error.message
        : (options.errorMessage?.(error) ??
            'Publishing failed. Try again, or ask the agent to publish.'),
    )
  }
}

// Plain JavaScript deliberately: Cloud executes this program without the host's
// TypeScript loader, dependencies, filesystem or credentials. It mirrors the
// Next.js preparation program's output directory, log and safety rules.
const SITE_PREPARATION_PROGRAM = String.raw`
import { readFile, writeFile, mkdir, readdir, realpath, lstat, copyFile, open, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, relative, join, dirname, basename, isAbsolute, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

let stage = 'checking the project';
let logPath = 'freebuff-sites-build/build.log';
let log;
const safeError = (message) => Object.assign(new Error(message), { safe: true });
const within = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const exists = async (path) => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const slash = (path) => path.split(sep).join('/');
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const bindingName = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const privateName = (part) => part.startsWith('.') || part === 'node_modules' || part === 'freebuff-sites-build' || part === 'freebuff-realtime' || /\.(map|pem|key|p12|pfx)$/i.test(part);
try {
  const root = await realpath(process.cwd());
  const project = root;
  const pkgPath = join(project, 'package.json');
  const pkg = await exists(pkgPath) ? await json(pkgPath) : null;
  const deps = { ...record(pkg?.dependencies), ...record(pkg?.devDependencies) };
  const has = (name) => typeof deps[name] === 'string';
  const scripts = record(pkg?.scripts);
  const build = typeof scripts.build === 'string' ? scripts.build : '';
  const usesAuth = has('@freebuff/auth');
  const first = async (names) => { for (const name of names) if (await exists(join(project, name))) return name; return null; };
  const manifestFile = await first(input.manifestFiles);
  const wranglerFile = await first(['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']);
  const nextApp = !!pkg && has('next') && [build, scripts.dev].some((command) => typeof command === 'string' && /(?:^|[\s;&])next\s+(?:build|dev)(?:\s|$)/.test(command));
  const adapter = !!build && ['@opennextjs/cloudflare', '@sveltejs/adapter-cloudflare', '@astrojs/cloudflare', '@cloudflare/vite-plugin'].some(has);
  const viteBuild = has('vite') && /(?:^|\s)vite\s+build(?:\s|$)/.test(build);
  const staticSite = await exists(join(project, 'index.html')) && (!pkg || viteBuild);
  const kind = manifestFile ? 'manifest' : nextApp ? 'next' : wranglerFile || adapter ? 'worker' : staticSite ? 'static' : null;
  if (!kind) throw safeError('Freebuff could not find a supported website in this project. Publish supports static sites, Vite apps, Next.js and Cloudflare Workers projects.');

  // Binding names only, from the user's own config; never provider ids or secrets.
  const declaredStorage = async () => {
    const storage = { d1: [], r2: [] };
    if (!wranglerFile) return storage;
    const text = await readFile(join(project, wranglerFile), 'utf8');
    if (wranglerFile.endsWith('.toml')) {
      for (const [section, list] of [['d1_databases', storage.d1], ['r2_buckets', storage.r2]]) {
        const blocks = text.split(/^\s*\[\[/m).filter((block) => block.startsWith(section + ']]'));
        for (const block of blocks) { const match = /^\s*binding\s*=\s*["']([A-Z][A-Z0-9_]{0,63})["']/m.exec(block); if (match) list.push(match[1]); }
      }
      return storage;
    }
    let config = {};
    try { config = JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|("(?:\\.|[^"\\])*")|\/\/[^\n]*/g, (match, string) => string ?? '').replace(/,(\s*[}\]])/g, '$1')); } catch { return storage; }
    storage.d1 = (Array.isArray(config.d1_databases) ? config.d1_databases : []).map((b) => b?.binding).filter(bindingName);
    storage.r2 = (Array.isArray(config.r2_buckets) ? config.r2_buckets : []).map((b) => b?.binding).filter((name) => bindingName(name) && name !== 'NEXT_INC_CACHE_R2_BUCKET');
    return storage;
  };
  const emit = (result) => process.stdout.write('FREEBUFF_SITE_RESULT:' + JSON.stringify({ usesAuth, name: typeof pkg?.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : undefined, ...result }) + '\n');
  // Next.js is built next by sites_prepare_next; only its hints are needed here.
  if (kind === 'next') emit({ kind, storage: await declaredStorage() });
  else {

  const out = join(project, 'freebuff-sites-build');
  if (await exists(out)) {
    if ((await lstat(out)).isSymbolicLink() || !await exists(join(out, '.freebuff-generated'))) throw safeError('freebuff-sites-build already contains files not created by Freebuff. Rename that directory before publishing.');
  } else {
    await mkdir(out);
    await writeFile(join(out, '.freebuff-generated'), 'Freebuff Sites build output\n', { flag: 'wx' });
  }
  logPath = slash(relative(root, join(out, 'build.log')));
  log = await open(join(out, 'build.log'), 'w', 0o600);
  const ignorePath = join(project, '.gitignore');
  if (await exists(ignorePath) && (await lstat(ignorePath)).isSymbolicLink()) throw safeError('The project .gitignore must be a regular file.');
  const ignore = await exists(ignorePath) ? await readFile(ignorePath, 'utf8') : '';
  if (!ignore.split(/\r?\n/).includes('/freebuff-sites-build/')) await writeFile(ignorePath, ignore + (ignore.endsWith('\n') || !ignore ? '' : '\n') + '/freebuff-sites-build/\n');

  const childEnv = Object.fromEntries(['PATH','HOME','USERPROFILE','USER','LOGNAME','SHELL','TMPDIR','TMP','TEMP','SystemRoot','ComSpec','PATHEXT','PNPM_HOME','BUN_INSTALL'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  Object.assign(childEnv, { CI: '1', NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' });
  const run = (command, args, windowsVerbatimArguments = false) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: project, env: childEnv, windowsVerbatimArguments, stdio: ['ignore', log.fd, log.fd] });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('command failed')));
  });
  let manager = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
  if (!manager) for (const [lock, name] of [['bun.lock','bun'], ['bun.lockb','bun'], ['pnpm-lock.yaml','pnpm'], ['yarn.lock','yarn'], ['package-lock.json','npm']]) if (await exists(join(project, lock))) { manager = name; break; }
  manager ||= 'npm';
  if (pkg && !['bun','npm','pnpm','yarn'].includes(manager)) throw safeError('Use npm, Bun, pnpm or Yarn to install this project.');
  const packageManager = (action) => {
    const invocation = input.commands[process.platform === 'win32' ? 'win32' : 'posix'][manager][action];
    return run(invocation.command === 'cmd.exe' ? (childEnv.ComSpec || 'cmd.exe') : invocation.command, invocation.args, invocation.windowsVerbatimArguments);
  };
  if (pkg && !await exists(join(project, 'node_modules'))) { stage = 'installing dependencies'; await packageManager('install'); }
  if (build) { stage = 'running the build script'; await packageManager('build'); }

  const copyPublic = async (source, target) => {
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    let count = 0;
    const walk = async (folder, depth) => {
      if (depth > 20) throw safeError('The site files are nested too deeply.');
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (privateName(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
        if (!entry.isFile()) continue;
        if (++count > 1000) throw safeError('A site may contain at most 1,000 files.');
        const destination = join(target, relative(source, path));
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(path, destination);
      }
    };
    await walk(source, 0);
    if (!count) throw safeError('The build produced no website files.');
  };
  const staticWorker = async (assetsSource, spa) => {
    stage = 'collecting the website files';
    await copyPublic(assetsSource, join(out, 'assets'));
    await writeFile(join(out, 'worker.js'), 'export default { fetch(request, env) { return env.ASSETS.fetch(request); } };\n');
    return { entrypoint: 'worker.js', compatibilityDate: input.compatibilityDate, compatibilityFlags: [], modules: [{ name: 'worker.js', type: 'esm', path: 'worker.js' }], assetsDirectory: 'assets', spa };
  };
  const writeManifest = async (manifest) => {
    await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return slash(relative(root, join(out, 'manifest.json')));
  };

  if (kind === 'manifest') {
    await log.close(); log = undefined;
    emit({ kind, manifestPath: manifestFile, storage: await declaredStorage(), logPath });
  } else if (kind === 'static') {
    const source = pkg ? join(project, 'dist') : project;
    if (!await exists(join(source, 'index.html'))) throw safeError('The build did not produce dist/index.html. Freebuff publishes the default Vite output directory.');
    const manifestPath = await writeManifest(await staticWorker(source, !!pkg));
    await log.close(); log = undefined;
    emit({ kind, manifestPath, storage: { d1: [], r2: [] }, logPath });
  } else {
    stage = 'reading the Wrangler configuration';
    const requireFrom = () => createRequire(pkg ? pkgPath : join(project, 'package.json'));
    const packageRoot = (name) => {
      let directory = dirname(requireFrom().resolve(name));
      while (dirname(directory) !== directory) {
        try { if (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name === name) return directory; } catch {}
        directory = dirname(directory);
      }
      throw new Error('Package not found');
    };
    const installed = (name) => { try { return packageRoot(name); } catch { return null; } };
    if (!installed('wrangler')) {
      if (!pkg) throw safeError('Add a package.json to this Workers project so Freebuff can install Wrangler.');
      stage = 'installing Wrangler';
      await packageManager('wrangler');
    }
    const wranglerRoot = packageRoot('wrangler');
    const { unstable_readConfig } = await import(pathToFileURL(requireFrom().resolve('wrangler')).href);
    const config = await unstable_readConfig(wranglerFile ? { config: join(project, wranglerFile) } : {});
    const configDir = config.configPath ? dirname(config.configPath) : project;
    const count = (value) => Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 0;
    const unsupported = [
      ['kv_namespaces', 'KV namespaces'], ['queues', 'Queues'], ['services', 'service bindings'],
      ['analytics_engine_datasets', 'Analytics Engine'], ['vectorize', 'Vectorize'], ['hyperdrive', 'Hyperdrive'],
      ['workflows', 'Workflows'], ['dispatch_namespaces', 'dispatch namespaces'], ['mtls_certificates', 'mTLS certificates'],
      ['send_email', 'Email'], ['pipelines', 'Pipelines'], ['secrets_store_secrets', 'Secrets Store'], ['tail_consumers', 'tail consumers'],
    ].filter(([key]) => key === 'queues' ? count(config.queues?.producers) + count(config.queues?.consumers) > 0 : count(config[key]) > 0).map(([, label]) => label);
    const durableBindings = config.durable_objects?.bindings || [];
    const realtime = durableBindings.some((binding) => binding.name === 'REALTIME');
    if (durableBindings.some((binding) => binding.name !== 'REALTIME' || binding.class_name !== 'FreebuffRealtime' || binding.script_name !== 'freebuff-sites-realtime-local') || durableBindings.length > 1 || count(config.migrations) > 0) unsupported.push('custom Durable Objects (only the platform REALTIME binding is supported)');
    for (const [key, label] of [['ai', 'Workers AI'], ['browser', 'Browser Rendering'], ['images', 'Images'], ['version_metadata', 'version metadata']]) if (config[key]) unsupported.push(label);
    if (unsupported.length) throw safeError('This Worker uses ' + unsupported.join(', ') + ', which Freebuff Sites does not provide. Ask the agent to adapt it before publishing.');
    if (count(config.vars) > 0) throw safeError('This Worker sets Wrangler vars, which Freebuff Sites does not deploy. Move them to Sites variables (Manage site → Variables) and remove them from the Wrangler configuration.');
    const databases = (config.d1_databases || []).map((b) => b.binding);
    const buckets = (config.r2_buckets || []).map((b) => b.binding).filter((name) => name !== 'NEXT_INC_CACHE_R2_BUCKET');
    if (databases.length > 1 || buckets.length > 1) throw safeError('Freebuff Sites supports one database and one file bucket per environment. Consolidate the Wrangler bindings before publishing.');
    if (![...databases, ...buckets].every(bindingName)) throw safeError('Name Wrangler database and bucket bindings in UPPER_SNAKE_CASE before publishing.');
    const flags = config.compatibility_flags || [];
    const rejected = flags.filter((flag) => !input.allowedFlags.includes(flag));
    if (rejected.length) throw safeError('Freebuff Sites does not support the compatibility flags ' + rejected.join(', ') + '. Supported: ' + input.allowedFlags.join(', ') + '.');
    const compatibilityDate = /^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date || '') && config.compatibility_date <= new Date().toISOString().slice(0, 10) ? config.compatibility_date : input.compatibilityDate;
    const assetsDirectory = config.assets?.directory ? resolve(configDir, config.assets.directory) : null;
    if (assetsDirectory && !within(root, assetsDirectory)) throw safeError('The Worker static assets directory must be inside this project.');
    if (config.assets?.binding && config.assets.binding !== 'ASSETS') throw safeError('Name the Worker assets binding ASSETS before publishing.');
    const spa = config.assets?.not_found_handling === 'single-page-application';
    let manifest;
    if (!config.main) {
      if (!assetsDirectory) throw safeError('The Wrangler configuration has neither a main script nor static assets.');
      manifest = await staticWorker(assetsDirectory, spa);
    } else {
      stage = 'bundling the Worker with Wrangler';
      const workerDir = join(out, 'worker');
      await rm(workerDir, { recursive: true, force: true });
      await run(process.execPath, [join(wranglerRoot, 'bin/wrangler.js'), 'deploy', '--dry-run', '--outdir', workerDir, ...(wranglerFile ? ['--config', join(project, wranglerFile)] : [])]);
      const modules = [];
      const walk = async (folder, prefix) => {
        for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const name = prefix ? prefix + '/' + entry.name : entry.name;
          if (entry.isDirectory()) { await walk(join(folder, entry.name), name); continue; }
          if (name.endsWith('.map') || name === 'README.md') continue;
          const type = /\.m?js$/.test(name) ? 'esm' : name.endsWith('.wasm') ? 'wasm' : /\.(txt|json|html)$/.test(name) ? 'text' : null;
          if (!type) throw safeError('Wrangler produced an unsupported Worker module. Inspect ' + logPath + '.');
          modules.push({ name, type, path: 'worker/' + name });
        }
      };
      await walk(workerDir, '');
      const expected = basename(config.main).replace(/\.[cm]?[jt]sx?$/, '.js');
      const entry = modules.find((module) => module.name === expected) ?? (modules.filter((module) => module.type === 'esm').length === 1 ? modules.find((module) => module.type === 'esm') : null);
      if (!entry) throw safeError('Wrangler did not produce the Worker entrypoint. Inspect ' + logPath + '.');
      if (modules.length > 100) throw safeError('The Worker bundle has more than 100 modules.');
      manifest = { entrypoint: entry.name, compatibilityDate, compatibilityFlags: flags, modules, spa };
      if (assetsDirectory) {
        stage = 'collecting the static assets';
        await copyPublic(assetsDirectory, join(out, 'assets'));
        manifest.assetsDirectory = 'assets';
      }
    }
    if (realtime) manifest.realtime = true;
    const manifestPath = await writeManifest(manifest);
    await log.close(); log = undefined;
    emit({ kind, manifestPath, storage: { d1: databases, r2: buckets }, logPath });
  }
  }
} catch (error) {
  if (log) { await log.write('\nPublishing failed at ' + stage + '\n'); await log.close(); }
  const message = (error?.safe ? error.message : 'Publishing failed while ' + stage + '. Inspect ' + logPath + ' for the build error.').slice(0, 4096);
  process.stdout.write('FREEBUFF_SITE_ERROR:' + message + '\n');
  process.exitCode = 1;
}
`
