/** These hints offer publishing; the Publish button's build (publish.ts) is the real check. */
export const SITE_DETECTION_MAX_BYTES = 64 * 1024
export const SITE_DEPLOY_MANIFEST_FILES = [
  'freebuff-site.json',
  'sites.manifest.json',
  'deploy.json',
] as const

export type SiteCompatibility = { compatible: boolean; reason?: string }

function objectJson(
  content: string | undefined,
): Record<string, unknown> | null {
  if (
    !content ||
    content.length > SITE_DETECTION_MAX_BYTES ||
    new TextEncoder().encode(content).byteLength > SITE_DETECTION_MAX_BYTES
  )
    return null
  try {
    const parsed: unknown = JSON.parse(content)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Inspect only root metadata supplied by the existing workspace files API.
 * Never execute config/scripts or search child projects; a monorepo dependency
 * alone does not establish that the current workspace is a deployable app.
 */
export function detectSiteCompatibility(input: {
  files: readonly { path: string; kind?: string }[]
  packageJson?: string
  manifestJson?: string
}): SiteCompatibility {
  const names = new Set(
    input.files
      .slice(0, 1000)
      .filter((file) => file.kind !== 'directory' && !/[\\/]/.test(file.path))
      .map((file) => file.path),
  )
  const manifest = objectJson(input.manifestJson)
  if (
    manifest &&
    typeof manifest.entrypoint === 'string' &&
    typeof manifest.compatibilityDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(manifest.compatibilityDate) &&
    Array.isArray(manifest.modules) &&
    manifest.modules.length > 0 &&
    manifest.modules.length <= 100 &&
    manifest.modules.some((module: unknown) => {
      const value = record(module)
      return (
        value.type === 'esm' &&
        value.name === manifest.entrypoint &&
        typeof value.path === 'string' &&
        value.path.length > 0
      )
    })
  )
    return { compatible: true, reason: 'Freebuff Sites deployment manifest' }

  if (
    ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'].some((name) =>
      names.has(name),
    )
  )
    return { compatible: true, reason: 'Cloudflare Workers configuration' }

  const pkg = objectJson(input.packageJson)
  const dependencies = {
    ...record(pkg?.dependencies),
    ...record(pkg?.devDependencies),
  }
  const has = (name: string) => typeof dependencies[name] === 'string'
  const scripts = record(pkg?.scripts)
  const build = typeof scripts.build === 'string' ? scripts.build : ''
  // Next is prepared by sites_prepare_next before upload. Requiring a real root
  // package plus its Next build/dev command avoids lighting up monorepo tooling
  // packages which merely depend on Next.
  if (
    names.has('package.json') &&
    has('next') &&
    [build, scripts.dev].some(
      (command) =>
        typeof command === 'string' &&
        /(?:^|[\s;&])next\s+(?:build|dev)(?:\s|$)/.test(command),
    )
  )
    return { compatible: true, reason: 'Next.js with automatic OpenNext setup' }
  const workerAdapter = [
    '@opennextjs/cloudflare',
    '@sveltejs/adapter-cloudflare',
    '@astrojs/cloudflare',
    '@cloudflare/vite-plugin',
  ].some(has)
  if (workerAdapter && build)
    return { compatible: true, reason: 'Workers build adapter' }

  // Ordinary SSR builds and server frameworks need a real Workers adapter.
  if (
    [
      'next',
      '@sveltejs/kit',
      'nuxt',
      'express',
      'fastify',
      '@nestjs/core',
    ].some(has)
  )
    return { compatible: false }

  if (
    names.has('index.html') &&
    (!names.has('package.json') ||
      (has('vite') && /(?:^|\s)vite\s+build(?:\s|$)/.test(build)))
  )
    return {
      compatible: true,
      reason: has('vite') ? 'Vite static frontend' : 'Static website',
    }

  return { compatible: false }
}

/** Owner-filtered catalog only. Attribution is an exact link, never a name guess. */
export function sitesForProject<
  T extends { analytics?: { originProjectId?: string } | null },
>(sites: readonly T[], projectId: string | null | undefined): T[] {
  if (!projectId) return []
  return sites.filter((site) => site.analytics?.originProjectId === projectId)
}
