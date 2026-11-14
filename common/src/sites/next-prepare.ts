import { SitesClientError } from './errors'
import {
  REALTIME_LOCAL_BINDING,
  realtimePreparationFiles,
} from './realtime-prepare'
import { NEXT_ADAPTER_VERSION, NEXT_WRANGLER_VERSION } from './versions'

/** Keep this adapter/Wrangler pair together: the generated cache format is versioned. */
export { NEXT_ADAPTER_VERSION, NEXT_WRANGLER_VERSION } from './versions'
export const NEXT_RESULT_PREFIX = 'FREEBUFF_NEXT_RESULT:'
export const NEXT_ERROR_PREFIX = 'FREEBUFF_NEXT_ERROR:'
export type NextPreparationResult = {
  manifestPath: string
  localWranglerConfigPath: string
  logPath: string
  runtime: 'opennext'
  nextVersion: string
  adapterVersion: string
  realtimeWranglerConfigPath?: string
}

/** Only fixed package-manager commands enter cmd.exe; project paths never do. */
export function nextInstallInvocation(manager: string, platform: string) {
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(manager))
    throw new Error('Unsupported package manager')
  const packages = [
    `@opennextjs/cloudflare@${NEXT_ADAPTER_VERSION}`,
    `wrangler@${NEXT_WRANGLER_VERSION}`,
  ]
  const args =
    manager === 'npm'
      ? ['install', '--save-dev', '--save-exact', ...packages]
      : ['yarn', 'bun'].includes(manager)
        ? ['add', '--dev', '--exact', ...packages]
        : ['add', '--save-dev', '--save-exact', ...packages]
  if (platform !== 'win32' || manager === 'bun')
    return { command: manager, args, windowsVerbatimArguments: false }
  // Node cannot launch npm/pnpm/yarn's .cmd shims directly. These allowlisted
  // words contain no whitespace or shell metacharacters, so no customer data
  // participates in the command line parsed by cmd.exe.
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `${manager}.cmd ${args.join(' ')}`],
    windowsVerbatimArguments: true,
  }
}

export function parseNextPreparationOutput(
  stdout: string,
): NextPreparationResult {
  const line = stdout
    .split('\n')
    .findLast((line) => line.startsWith(NEXT_RESULT_PREFIX))
  if (!line)
    throw new Error('Next.js preparation did not return a build manifest.')
  const value = JSON.parse(
    line.slice(NEXT_RESULT_PREFIX.length),
  ) as NextPreparationResult
  if (
    value.runtime !== 'opennext' ||
    (value.realtimeWranglerConfigPath !== undefined &&
      typeof value.realtimeWranglerConfigPath !== 'string') ||
    ![
      'manifestPath',
      'localWranglerConfigPath',
      'logPath',
      'nextVersion',
      'adapterVersion',
    ].every(
      (key) => typeof value[key as keyof NextPreparationResult] === 'string',
    )
  )
    throw new Error('Invalid Next.js preparation result.')
  return value
}

/** Only the bounded, program-generated message belongs in a tool response. */
export function parseNextPreparationError(output: string): string | undefined {
  return output
    .split('\n')
    .findLast((line) => line.startsWith(NEXT_ERROR_PREFIX))
    ?.slice(NEXT_ERROR_PREFIX.length, NEXT_ERROR_PREFIX.length + 4096)
    .trim()
}

/**
 * Exactly the same credential-free preparation program runs in a local workspace
 * and in a Cloud VM. Child build output goes to a private local log, never into
 * the tool response. No Cloudflare API or account credentials are used here.
 */
export function nextPreparationScript(
  options: { projectDirectory?: string; realtime?: true } = {},
): string {
  const installCommands = Object.fromEntries(
    ['win32', 'posix'].map((platform) => [
      platform,
      Object.fromEntries(
        ['npm', 'pnpm', 'yarn', 'bun'].map((manager) => [
          manager,
          nextInstallInvocation(manager, platform),
        ]),
      ),
    ]),
  )
  return (
    `const input = ${JSON.stringify({ projectDirectory: options.projectDirectory ?? '.', realtime: options.realtime, realtimeFiles: realtimePreparationFiles(), realtimeBinding: REALTIME_LOCAL_BINDING, adapterVersion: NEXT_ADAPTER_VERSION, wranglerVersion: NEXT_WRANGLER_VERSION, installCommands })};\n` +
    NEXT_PREPARATION_PROGRAM
  )
}

export async function prepareNextSite(
  cwd: string,
  projectDirectory = '.',
  signal?: AbortSignal,
  options: { realtime?: true } = {},
): Promise<NextPreparationResult> {
  // This program comes from stdin, not a file to bundle. Keep the native
  // import at runtime so Turbopack does not trace Node's flags as file paths.
  const { spawn } = await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ 'node:child_process'
  )
  const stdout = await new Promise<string>((resolve, reject) => {
    const buildSignal = AbortSignal.any([
      AbortSignal.timeout(15 * 60 * 1000),
      ...(signal ? [signal] : []),
    ])
    const child = spawn('node', ['--input-type=module', '-'], {
      cwd,
      signal: buildSignal,
      detached: process.platform !== 'win32',
      env: nextPreparationEnvironment(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
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
    let errorOutput = ''
    child.stdout.on('data', (data: Buffer) => {
      output = (output + data.toString()).slice(-64 * 1024)
    })
    child.stderr.on('data', (data: Buffer) => {
      errorOutput = (errorOutput + data.toString()).slice(-4096)
    })
    child.once('error', () =>
      reject(
        new SitesClientError(
          400,
          'next_prepare_failed',
          buildSignal.aborted
            ? 'Next.js preparation was cancelled or exceeded its 15-minute limit.'
            : 'Next.js preparation needs Node.js 20.19 or newer in the workspace PATH.',
        ),
      ),
    )
    child.once('close', (code) => {
      buildSignal.removeEventListener('abort', stop)
      code === 0
        ? resolve(output)
        : reject(
            new SitesClientError(
              400,
              'next_prepare_failed',
              parseNextPreparationError(errorOutput) ??
                'Next.js preparation failed. Inspect freebuff-sites-build/build.log in the project.',
            ),
          )
    })
    // The generated program exceeds Windows' command-line limit. Stream it to
    // Node instead; a child that exits/aborts before reading reports via close.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') return
      child.kill()
      reject(
        new SitesClientError(
          400,
          'next_prepare_failed',
          'Could not send the Next.js preparation program to Node.js.',
        ),
      )
    })
    child.stdin.end(nextPreparationScript({ projectDirectory, ...options }))
  })
  return parseNextPreparationOutput(stdout)
}

/** Build children must not inherit the signed-in platform's credentials. */
export function nextPreparationEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
    'PNPM_HOME',
    'BUN_INSTALL',
  ]
  return {
    ...Object.fromEntries(
      allowed
        .filter((key) => environment[key] !== undefined)
        .map((key) => [key, environment[key]]),
    ),
    CI: '1',
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    WRANGLER_SEND_METRICS: 'false',
  }
}

// Plain JavaScript deliberately: Cloud executes this program without the host's
// TypeScript loader, dependencies, filesystem or credentials.
const NEXT_PREPARATION_PROGRAM = String.raw`
import { readFile, writeFile, mkdir, readdir, realpath, lstat, copyFile, open, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, relative, join, dirname, extname, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
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
const marker = '// Generated by Freebuff Sites. Changes are regenerated when publishing.\n';
try {
  const root = await realpath(process.cwd());
  const project = await realpath(resolve(root, input.projectDirectory));
  if (!within(root, project)) throw safeError('Choose a Next.js project directory inside this workspace.');
  const version = process.versions.node.split('.').map(Number);
  if (version[0] < 20 || (version[0] === 20 && version[1] < 19)) throw safeError('OpenNext needs Node.js 20.19 or newer.');
  const pkgPath = join(project, 'package.json');
  const pkg = await json(pkgPath);
  if (!pkg.dependencies?.next && !pkg.devDependencies?.next) throw safeError('The selected directory is not a Next.js project.');
  const out = join(project, 'freebuff-sites-build');
  if (await exists(out)) {
    if ((await lstat(out)).isSymbolicLink() || !await exists(join(out, '.freebuff-generated'))) throw safeError('freebuff-sites-build already contains files not created by Freebuff. Rename that directory before preparing this project.');
  } else {
    await mkdir(out);
    await writeFile(join(out, '.freebuff-generated'), 'Freebuff Sites build output\n', { flag: 'wx' });
  }
  logPath = slash(relative(root, join(out, 'build.log')));
  log = await open(join(out, 'build.log'), 'w', 0o600);
  const childEnv = Object.fromEntries(['PATH','HOME','USERPROFILE','USER','LOGNAME','SHELL','TMPDIR','TMP','TEMP','SystemRoot','ComSpec','PATHEXT','PNPM_HOME','BUN_INSTALL'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  Object.assign(childEnv, { CI: '1', NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' });
  const run = (command, args, windowsVerbatimArguments=false) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: project, env: childEnv, windowsVerbatimArguments, stdio: ['ignore', log.fd, log.fd] });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('command failed')));
  });
  const projectRequire = createRequire(pkgPath);
  const packageRoot = (name) => {
    let directory = dirname(projectRequire.resolve(name));
    while (dirname(directory) !== directory) {
      try { if (JSON.parse(readFileSync(join(directory,'package.json'),'utf8')).name === name) return directory; } catch {}
      directory = dirname(directory);
    }
    throw new Error('Package not found');
  };
  const installed = (name) => { try { return JSON.parse(readFileSync(join(packageRoot(name),'package.json'),'utf8')).version; } catch { return null; } };
  const assertSupportedNext = (version) => {
    const parts=(version||'').split('.').map(Number);
    if (!((parts[0] === 15 && (parts[1] > 5 || parts[1] === 5 && parts[2] >= 28)) || (parts[0] === 16 && (parts[1] > 4 || parts[1] === 4 && parts[2] >= 1)))) {
      throw safeError('This OpenNext adapter supports Next.js 15.5.28+ (15.x) and 16.4.1+ (16.x). Update Next.js, test the app, then prepare it again. Freebuff did not change your Next.js version.');
    }
  };
  if(installed('next')) assertSupportedNext(installed('next'));
  let manager = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
  if (!manager) {
    for (let directory=project;within(root,directory);directory=dirname(directory)) {
      const ancestorPackage=await exists(join(directory,'package.json'))?await json(join(directory,'package.json')):{};
      if(typeof ancestorPackage.packageManager==='string')manager=ancestorPackage.packageManager.split('@')[0];
      for (const [lock, name] of [['bun.lock','bun'], ['bun.lockb','bun'], ['pnpm-lock.yaml','pnpm'], ['yarn.lock','yarn'], ['package-lock.json','npm']]) {
        if (!manager&&await exists(join(directory, lock))) { manager = name; break; }
      }
      if(manager||directory===root)break;
    }
  }
  manager ||= 'npm';
  if (!['bun','npm','pnpm','yarn'].includes(manager)) throw safeError('Use npm, Bun, pnpm or Yarn to install this Next.js project.');
  stage = 'installing the OpenNext adapter';
  if (installed('@opennextjs/cloudflare') !== input.adapterVersion || installed('wrangler') !== input.wranglerVersion || !installed('next')) {
    const invocation=input.installCommands[process.platform==='win32'?'win32':'posix'][manager];
    const command=invocation.command==='cmd.exe'?(childEnv.ComSpec||'cmd.exe'):invocation.command;
    await run(command, invocation.args, invocation.windowsVerbatimArguments);
  }
  const currentPackage = await json(pkgPath);
  if (!currentPackage.scripts?.build) {
    currentPackage.scripts = {...currentPackage.scripts, build:'next build'};
    await writeFile(pkgPath,JSON.stringify(currentPackage,null,2)+'\n');
  }
  const nextVersion = installed('next');
  assertSupportedNext(nextVersion);
  const generated = async (name, content) => {
    const path = join(project, name);
    if (await exists(path)) {
      if ((await lstat(path)).isSymbolicLink() || !(await readFile(path, 'utf8')).startsWith(marker)) throw safeError(name + ' already exists and is not generated by Freebuff. Rename it before preparing the project.');
    }
    await writeFile(path, marker + content);
  };
  let userConfig;
  for (const name of ['open-next.config.ts','open-next.config.js','open-next.config.mjs']) if (await exists(join(project, name))) { userConfig = name; break; }
  const config = [
    'import { defineCloudflareConfig } from "@opennextjs/cloudflare";',
    'import r2 from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";',
    'import queue from "@opennextjs/cloudflare/overrides/queue/do-queue";',
    'import tags from "@opennextjs/cloudflare/overrides/tag-cache/do-sharded-tag-cache";',
    userConfig ? 'import rawUserConfig from ' + JSON.stringify('./' + userConfig) + '; const user = rawUserConfig as Record<string, any>;' : 'const user: Record<string, any> = {};',
    'const managed = defineCloudflareConfig({incrementalCache:r2,queue,tagCache:tags({baseShardSize:4})});',
    'export default {...user,...managed,default:{...user.default,...managed.default},cloudflare:{...user.cloudflare,...managed.cloudflare}};',
  ].join('\n');
  await generated('freebuff.open-next.config.ts', config + '\n');
  const flags = ['nodejs_compat','global_fetch_strictly_public','enable_ctx_exports'];
  const hostedFlags = ['nodejs_compat','global_fetch_strictly_public','disable_ctx_exports'];
  // Reuse the project's binding names and local public variables without ever
  // inheriting remote provider IDs, remote=true, accounts, services or secrets.
  // Prefer the prior generated preview config so local auth setup survives a build.
  let previous = {};
  for (const name of ['freebuff.wrangler.jsonc','wrangler.jsonc','wrangler.json','wrangler.toml']) {
    if (await exists(join(project,name))) {
      const {unstable_readConfig}=await import(pathToFileURL(projectRequire.resolve('wrangler')).href);
      previous=await unstable_readConfig({config:join(project,name)});
      break;
    }
  }
  const bindingName = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
  const realtime = input.realtime === true || (previous.durable_objects?.bindings || []).some((binding) => binding.name === 'REALTIME');
  if (realtime) {
    const directory = join(project, 'freebuff-realtime');
    if (!await exists(directory)) await mkdir(directory);
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw safeError('freebuff-realtime must be a regular directory, not a symlink.');
    for (const [name, content] of Object.entries(input.realtimeFiles)) {
      const path = join(directory, name);
      if (await exists(path)) {
        const existing = await lstat(path);
        if (existing.isSymbolicLink() || !existing.isFile()) throw safeError('Existing realtime files must be regular files, not symlinks.');
      } else await writeFile(path, content, { flag: 'wx' });
    }
  }
  const databases = (previous.d1_databases || []).filter((binding) => bindingName(binding.binding));
  const buckets = (previous.r2_buckets || []).filter((binding) => bindingName(binding.binding) && binding.binding !== 'NEXT_INC_CACHE_R2_BUCKET');
  if (databases.length > 1 || buckets.length > 1) throw safeError('Freebuff Sites supports one application database and one file bucket per environment. Consolidate the Wrangler application bindings before publishing.');
  const localConfig = {
    name: 'freebuff-next-local', main: 'freebuff-sites-build/entry.js', compatibility_date: '2026-10-01', compatibility_flags: flags,
    assets: { directory: '.open-next/assets', binding: 'ASSETS', run_worker_first: true },
    vars: previous.vars || {},
    d1_databases: (databases.length ? databases : [{binding:'DB'}]).map((binding) => ({binding:binding.binding,database_name:'freebuff-next-db-local',database_id:'00000000-0000-0000-0000-000000000001',...(typeof binding.migrations_dir === 'string' ? {migrations_dir:binding.migrations_dir} : {})})),
    r2_buckets: [{binding:'NEXT_INC_CACHE_R2_BUCKET',bucket_name:'freebuff-next-cache-local'},...(buckets.length ? buckets : [{binding:'FILES'}]).map((binding) => ({binding:binding.binding,bucket_name:'freebuff-next-files-local'}))],
    durable_objects: {bindings: [{name:'NEXT_CACHE_DO_QUEUE',class_name:'DOQueueHandler'},{name:'NEXT_TAG_CACHE_DO_SHARDED',class_name:'DOShardedTagCache'},...(realtime?[input.realtimeBinding]:[])]},
    migrations: [{tag:'freebuff-next-v1',new_sqlite_classes:['DOQueueHandler','DOShardedTagCache']}],
  };
  // JSONC keeps the ownership marker while remaining readable by Wrangler.
  await generated('freebuff.wrangler.jsonc', JSON.stringify(localConfig, null, 2) + '\n');
  const ignorePath = join(project, '.gitignore');
  if (await exists(ignorePath) && (await lstat(ignorePath)).isSymbolicLink()) throw safeError('The project .gitignore must be a regular file.');
  const ignore = await exists(ignorePath) ? await readFile(ignorePath, 'utf8') : '';
  const missingIgnores = ['/freebuff-sites-build/','/.open-next/','/.wrangler/'].filter((line) => !ignore.split(/\r?\n/).includes(line));
  if (missingIgnores.length) await writeFile(ignorePath, ignore + (ignore.endsWith('\n') || !ignore ? '' : '\n') + missingIgnores.join('\n') + '\n');
  stage = 'building Next.js for Workers';
  const adapterCli = join(packageRoot('@opennextjs/cloudflare'), 'dist/cli/index.js');
  await run(process.execPath, [adapterCli,'build','--config','freebuff.wrangler.jsonc','--openNextConfigPath','freebuff.open-next.config.ts']);
  stage = 'preparing the Worker and public assets';
  const walk = async (folder, fn, prefix = '', depth = 0) => {
    if (depth > 20) throw safeError('The Next.js build output is nested too deeply.');
    for (const entry of (await readdir(folder,{withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw safeError('Next.js build output cannot contain symlinks.');
      const path = join(folder,entry.name), name = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await walk(path,fn,name,depth+1); else if (entry.isFile()) await fn(path,name); else throw safeError('Next.js build output must contain regular files.');
    }
  };
  const assets = [];
  const publicDir = join(out,'assets');
  await rm(publicDir,{recursive:true,force:true});
  await mkdir(publicDir);
  await walk(join(project,'.open-next/assets'), async (path,name) => {
    if (name.endsWith('.map')) return;
    if (name.split('/').some((part) => part.startsWith('.') || part === 'node_modules' || /\.(pem|key|p12|pfx)$/i.test(part))) throw safeError('Next.js static output contains a private or hidden file. Remove it from public/ before publishing.');
    if (assets.length >= 1000) throw safeError('A site may contain at most 1,000 static assets.');
    await mkdir(dirname(join(publicDir,name)),{recursive:true});
    await copyFile(path,join(publicDir,name));
    assets.push('/' + name);
  });
  if (!assets.includes('/_headers')) {
    if (assets.length >= 1000) throw safeError('A site may contain at most 1,000 static assets, including its asset headers configuration.');
    await writeFile(join(publicDir,'_headers'),'/_next/static/*\n  Cache-Control: public,max-age=31536000,immutable\n');
    assets.push('/_headers');
  }
  const buildId=(await readFile(join(project,'.next/BUILD_ID'),'utf8')).trim();
  const previewModeId=(await json(join(project,'.next/prerender-manifest.json'))).preview?.previewModeId;
  if(!/^[A-Za-z0-9_-]{1,200}$/.test(buildId)||typeof previewModeId!=='string'||!/^[a-f0-9]{32}$/.test(previewModeId))throw safeError('Next.js did not produce valid revalidation metadata.');
  // Worker-first routing must preserve OpenNext's ordinary asset-first semantics.
  // Ask ASSETS first so native redirects, headers and HTML normalization work.
  // Only an unmatched asset 404 falls through to Next; no SPA fallback is set.
  const entry = (local) => [
    'import next from "../.open-next/worker.js";',
    'const assets = new Set(' + JSON.stringify(assets.filter((path) => !['/_headers','/_redirects'].includes(path))) + ');',
    'const nextMetadata='+JSON.stringify({buildId,previewModeId})+';',
    'const environments=new WeakMap();',
    'function runtimeEnv(env,ctx){let target=environments.get(env);if(!target){const queue=env.NEXT_CACHE_DO_QUEUE;target={...env,NEXT_CACHE_DO_QUEUE:{idFromName(name){return queue.idFromName(name)},get(id,options){const stub=queue.get(id,options);return {revalidate(message){return stub.revalidate({...message,freebuffNext:nextMetadata})}}}}};environments.set(env,target)}'+(local?'target.WORKER_SELF_REFERENCE=ctx.exports.default;':'')+'return target}',
    'export default {async fetch(request,env,ctx){',
    'const url=new URL(request.url);',
    'let pathname;try{pathname=decodeURI(url.pathname)}catch{return new Response("Bad request",{status:400})}',
    'if(request.method==="GET"||request.method==="HEAD"){const asset=await env.ASSETS.fetch(request);if(asset.status!==404||assets.has(pathname))return asset;await asset.body?.cancel()}',
    'return next.fetch(request,runtimeEnv(env,ctx),ctx);}};',
  ].join('\n');
  await writeFile(join(out,'entry.js'),entry(true)+'\nexport {DOQueueHandler,DOShardedTagCache} from "../.open-next/worker.js";\n');
  await writeFile(join(out,'deploy-entry.js'),entry(false));
  // Point the final local preview at the exact staged assets sent to Sites.
  localConfig.assets.directory = 'freebuff-sites-build/assets';
  await generated('freebuff.wrangler.jsonc',JSON.stringify(localConfig,null,2)+'\n');
  const workerDir = join(out,'worker');
  await rm(workerDir,{recursive:true,force:true});
  stage = 'validating and bundling the Worker with Wrangler';
  const wranglerCli = join(packageRoot('wrangler'),'bin/wrangler.js');
  const deployConfig={...localConfig,main:join(out,'deploy-entry.js'),assets:{...localConfig.assets,directory:publicDir},compatibility_flags:hostedFlags};
  delete deployConfig.durable_objects;delete deployConfig.migrations;
  const deployConfigPath=join(out,'deploy.wrangler.json');
  await writeFile(deployConfigPath,JSON.stringify(deployConfig,null,2));
  await run(process.execPath,[wranglerCli,'deploy','--dry-run','--config',deployConfigPath,'--outdir',workerDir]);
  const modules = [];
  await walk(workerDir,async (path,name) => {
    if (name.endsWith('.map') || name === 'README.md') return;
    const type = ['.js','.mjs'].includes(extname(name)) ? 'esm' : extname(name) === '.wasm' ? 'wasm' : ['.txt','.json','.html'].includes(extname(name)) ? 'text' : null;
    if (!type) throw safeError('Wrangler produced an unsupported Worker module. Inspect the local build log.');
    modules.push({name,type,path:'worker/'+name});
  });
  if (!modules.some((module) => module.name === 'deploy-entry.js')) throw safeError('Wrangler did not produce the expected Worker entrypoint.');
  const cacheDir = join(out,'cache');
  await rm(cacheDir,{recursive:true,force:true});
  await mkdir(cacheDir);
  const cache = [];
  await walk(join(project,'.open-next/cache'),async (path,name) => {
    const parts=name.split('/'), isFetch=parts[0]==='__fetch';
    if(isFetch) parts.shift();
    const buildId=parts.shift();
    if(!buildId || !/^[A-Za-z0-9_-]+$/.test(buildId) || !parts.length || (!isFetch && !name.endsWith('.cache'))) throw safeError('OpenNext produced an unsupported cache entry.');
    const route='/' + parts.join('/').replace(isFetch ? /$^/ : /\.cache$/,'');
    const hash=createHash('sha256').update(route).digest('hex');
    const key='incremental-cache/'+buildId+'/'+hash+(isFetch?'.fetch':'.cache');
    const file=cache.length+'.json';
    await copyFile(path,join(cacheDir,file));
    cache.push({key,path:'cache/'+file});
  });
  const manifest={runtime:'opennext',...(realtime?{realtime:true}:{}),entrypoint:'deploy-entry.js',compatibilityDate:localConfig.compatibility_date,compatibilityFlags:hostedFlags,modules,assetsDirectory:'assets',cache,spa:false};
  await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  stage = 'seeding the local preview cache';
  await run(process.execPath,[adapterCli,'populateCache','local','--config','freebuff.wrangler.jsonc']);
  await log.close(); log=undefined;
  process.stdout.write('FREEBUFF_NEXT_RESULT:'+JSON.stringify({runtime:'opennext',manifestPath:slash(relative(root,join(out,'manifest.json'))),localWranglerConfigPath:slash(relative(root,join(project,'freebuff.wrangler.jsonc'))),...(realtime?{realtimeWranglerConfigPath:slash(relative(root,join(project,'freebuff-realtime/wrangler.jsonc')))}:{}),logPath,nextVersion,adapterVersion:input.adapterVersion})+'\n');
} catch(error) {
  if(log) { await log.write('\nPreparation failed at '+stage+'\n'); await log.close(); }
  const message=(error?.safe?error.message:'Next.js preparation failed while '+stage+'. Inspect '+logPath+' for the build error.').slice(0,4096);
  const errorLine='FREEBUFF_NEXT_ERROR:'+message+'\n';
  process.stderr.write(errorLine);
  process.stdout.write(errorLine);
  process.exitCode=1;
}
`
