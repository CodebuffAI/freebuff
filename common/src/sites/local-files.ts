import { realpath, readdir, open } from 'node:fs/promises'
import { isAbsolute, relative, resolve, dirname, extname, sep } from 'node:path'
import { z } from 'zod/v4'
import { SitesClientError } from './errors'

const manifestSchema = z
  .object({
    runtime: z.literal('opennext').optional(),
    realtime: z.literal(true).optional(),
    entrypoint: z.string(),
    compatibilityDate: z.string(),
    compatibilityFlags: z.array(z.string()).optional(),
    modules: z
      .array(
        z.object({
          name: z.string(),
          type: z.enum(['esm', 'text', 'wasm']),
          path: z.string(),
        }),
      )
      .min(1)
      .max(100),
    assetsDirectory: z.string().optional(),
    cache: z
      .array(
        z
          .object({
            key: z
              .string()
              .regex(
                /^incremental-cache\/[A-Za-z0-9_-]{1,200}\/[a-f0-9]{64}\.(?:cache|fetch)$/,
              ),
            path: z.string(),
          })
          .strict(),
      )
      .max(1000)
      .optional(),
    spa: z.boolean().optional(),
  })
  .strict()
  .refine(
    (manifest) =>
      manifest.cache === undefined || manifest.runtime === 'opennext',
    {
      message: 'Only OpenNext deployments contain private build cache entries.',
    },
  )
  .refine(
    (manifest) =>
      manifest.modules.some(
        (module) =>
          module.name === manifest.entrypoint && module.type === 'esm',
      ),
    { message: 'Entrypoint must match the name of an ESM module.' },
  )
const invalid = (message: string) =>
  new SitesClientError(400, 'invalid_site_request', message)

const outside = (rel: string) =>
  !rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT' ||
  (error as NodeJS.ErrnoException)?.code === 'ENOTDIR'

async function localPath(root: string, path: string) {
  const requested = resolve(root, path)
  const absolute = await realpath(requested).catch((error: unknown) => {
    // realpath fails before containment can be checked. Name only a path
    // inside the workspace, relative, so the agent can fix it.
    const rel = relative(root, requested)
    if (!missing(error)) throw error
    if (outside(rel))
      throw invalid('Site files must be inside this thread’s workspace.')
    throw invalid(
      `Site file not found in this chat’s workspace: ${rel.split(sep).join('/')}`,
    )
  })
  if (outside(relative(root, absolute)))
    throw invalid('Site files must be inside this thread’s workspace.')
  return absolute
}
async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit)
      throw invalid(
        'Site file exceeds the upload limit or is not a regular file.',
      )
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        used,
        buffer.length - used,
        null,
      )
      if (!bytesRead) break
      used += bytesRead
    }
    if (used > limit || used > stat.size)
      throw invalid('Site file changed during upload. Rebuild and retry.')
    return buffer.subarray(0, used)
  } finally {
    await file.close()
  }
}
const unsafeAsset = (part: string) =>
  part.startsWith('.') ||
  /\.(?:pem|key|p12|pfx|map)$/i.test(part) ||
  part === 'node_modules'

export async function bundleSite(cwd: string, manifestPath: string) {
  const root = await realpath(cwd)
  const path = await localPath(root, manifestPath)
  const parsed = manifestSchema.safeParse(
    JSON.parse((await readBounded(path, 512 * 1024)).toString('utf8')),
  )
  if (!parsed.success)
    throw invalid(
      'Invalid deploy manifest. entrypoint must match an ESM module name (not its local path). Supply compatibilityDate and modules with name/type/path; optional assetsDirectory and spa.',
    )
  const manifest = parsed.data
  let remaining = (manifest.runtime === 'opennext' ? 32 : 10) * 1024 * 1024
  const read = async (file: string) => {
    const data = await readBounded(file, remaining)
    remaining -= data.length
    return data.toString('base64')
  }
  const modules = []
  for (const module of manifest.modules) {
    const file = await localPath(root, resolve(dirname(path), module.path))
    if (
      relative(root, file).split(/[\\/]/).some(unsafeAsset) ||
      !['.js', '.mjs', '.txt', '.json', '.html', '.wasm'].includes(
        extname(file),
      )
    )
      throw invalid(
        'Only built JS, text, JSON and WASM modules may be uploaded.',
      )
    modules.push({
      name: module.name,
      type: module.type,
      contentBase64: await read(file),
    })
  }
  let assets: { path: string; contentBase64: string }[] | undefined
  if (manifest.assetsDirectory !== undefined) {
    const directory = await localPath(
      root,
      resolve(dirname(path), manifest.assetsDirectory),
    )
    if (relative(root, directory).split(/[\\/]/).some(unsafeAsset))
      throw invalid(
        'Use a dedicated public build directory, not a hidden or private directory.',
      )
    assets = []
    const walk = async (
      folder: string,
      prefix: string,
      depth = 0,
    ): Promise<void> => {
      if (depth > 20) throw invalid('Static assets are nested too deeply.')
      // Name order, like Cloud's bundler (`sorted(os.listdir())` in
      // web/src/server/desktop-cloud/sites-files.ts): readdir's order is the
      // filesystem's, so the same build could otherwise bundle differently.
      const entries = (await readdir(folder, { withFileTypes: true })).sort(
        (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      )
      for (const entry of entries) {
        if (unsafeAsset(entry.name) || entry.isSymbolicLink())
          throw invalid(
            'Assets must contain only public build output: no hidden files, source maps, private keys, dependencies, or symlinks.',
          )
        const file = await localPath(root, resolve(folder, entry.name))
        const assetPath = `${prefix}/${entry.name}`
        if (entry.isDirectory()) await walk(file, assetPath, depth + 1)
        else {
          if (assets!.length >= 1000)
            throw invalid('A deployment may have at most 1,000 assets.')
          assets!.push({ path: assetPath, contentBase64: await read(file) })
        }
      }
    }
    await walk(directory, '')
  }
  const cache = manifest.cache
    ? ([] as { key: string; contentBase64: string }[])
    : undefined
  for (const entry of manifest.cache ?? []) {
    const file = await localPath(root, resolve(dirname(path), entry.path))
    if (
      relative(root, file).split(/[\\/]/).some(unsafeAsset) ||
      extname(file) !== '.json'
    )
      throw invalid(
        'OpenNext cache entries must be dedicated private build JSON files.',
      )
    cache!.push({ key: entry.key, contentBase64: await read(file) })
  }
  return {
    ...(manifest.runtime ? { runtime: manifest.runtime } : {}),
    ...(manifest.realtime ? { realtime: true as const } : {}),
    entrypoint: manifest.entrypoint,
    compatibilityDate: manifest.compatibilityDate,
    compatibilityFlags: manifest.compatibilityFlags ?? [],
    modules,
    ...(assets !== undefined ? { assets } : {}),
    ...(cache !== undefined ? { cache } : {}),
    spa: manifest.spa ?? false,
  }
}

export async function readSiteSecret(cwd: string, path: string) {
  const root = await realpath(cwd)
  const file = await localPath(root, path)
  const value = (await readBounded(file, 5120))
    .toString('utf8')
    .replace(/\r?\n$/, '')
  if (!value) throw invalid('Secret file is empty.')
  return value
}
