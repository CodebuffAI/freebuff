import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod/v4'
import { bundleSite, readSiteSecret } from './local-files'

import { SitesClientError } from './errors'
export { SitesClientError } from './errors'
const uuid = z.string().uuid()
const environment = z.enum(['preview', 'production'])
const key = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/)
const name = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
  .refine(
    (s) =>
      ![
        'ASSETS',
        'FREEBUFF_CLIENT_ID',
        'FREEBUFF_ISSUER',
        'APP_ORIGIN',
      ].includes(s),
  )
const target = z.object({ siteId: uuid, environment })
const invalid = (message: string) =>
  new SitesClientError(400, 'invalid_site_request', message)
const IDEMPOTENT_TOOLS = new Set([
  'sites_deploy',
  'sites_add_storage',
  'sites_set_secret',
])

export class SitesClient {
  private context = new AsyncLocalStorage<{
    originProjectId: string
    originProjectType: 'local' | 'cloud'
  }>()
  constructor(
    private options: {
      getToken: () => string | null | undefined
      originApp: 'desktop' | 'web'
      files?: { bundle: typeof bundleSite; secret: typeof readSiteSecret }
      host: string
      fetcher?: (url: string, init: RequestInit) => Promise<Response>
    },
  ) {}
  async request(
    path: string,
    method = 'GET',
    body?: unknown,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = this.options.getToken()
    if (!token)
      throw new SitesClientError(
        401,
        'sites_sign_in_required',
        'Sign in to Freebuff to view and deploy sites.',
      )
    // All callers construct a relative path from validated ids; no redirects may receive the bearer.
    try {
      const response = await (this.options.fetcher ?? fetch)(
        `${this.options.host}/api/v1/sites${path}`,
        {
          method,
          redirect: 'error',
          signal: AbortSignal.any([
            AbortSignal.timeout(120000),
            ...(signal ? [signal] : []),
          ]),
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Freebuff-Product-Context': JSON.stringify({
              originApp: this.options.originApp,
              ...this.context.getStore(),
            }),
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      )
      const data = (await response.json()) as {
        message?: string
        error?: string
        operation?: unknown
      }
      if (!response.ok && !data.operation) {
        const knownErrors: Record<string, string> = {
          sites_usage_limit:
            'Your sites have reached a hosting allowance and are paused. Open Sites to view usage and reset dates. Your data is preserved.',
          sites_usage_unavailable:
            'Hosting usage is being checked. Try again shortly.',
          project_limit:
            'Your free hosting allowance includes 3 sites. You can continue updating your existing sites.',
          binding_limit:
            'Each site environment includes one database and one storage bucket. Reuse the existing binding.',
          variable_limit:
            'This project has reached its limit of 25 environment variables across Preview and Production. Replace or delete an existing variable.',
          deploy_required: 'Deploy this environment before adding variables.',
          binding_exists:
            'That name is already used by a database or storage binding.',
          secret_not_found: 'This variable no longer exists. Refresh the list.',
          environment_busy:
            'An operation is running or needs reconciliation. Refresh deployment activity before trying again.',
        }
        const messages: Record<number, string> = {
          401: 'Sign in to Freebuff to use Sites.',
          403: 'Your account cannot access Sites.',
          404: 'Sites is not enabled on this backend, or this site was not found.',
          409: 'The environment is busy or the request conflicts with an earlier operation.',
          429: 'Sites usage limit reached. Try again later.',
          503: 'Sites is not configured or is temporarily busy.',
        }
        throw new SitesClientError(
          response.status,
          'sites_request_failed',
          knownErrors[data.error ?? ''] ??
            messages[response.status] ??
            'The Sites request failed. Check the deployment manifest and operation status.',
        )
      }
      return data
    } catch (error) {
      if (error instanceof SitesClientError) throw error
      throw new SitesClientError(
        502,
        'sites_connection_failed',
        'Couldn’t reach Sites. Check your connection and try again.',
      )
    }
  }
  async writeSecret(
    siteId: string,
    env: string,
    binding: string,
    method: 'PUT' | 'DELETE',
    raw: unknown,
    requestId: string,
  ) {
    try {
      uuid.parse(siteId)
      environment.parse(env)
      name.parse(binding)
      key.parse(requestId)
      const input =
        method === 'PUT'
          ? z
              .strictObject({
                value: z
                  .string()
                  .min(1)
                  .max(5120)
                  .refine((value) => Buffer.byteLength(value, 'utf8') <= 5120),
              })
              .parse(raw)
          : undefined
      return await this.request(
        `/${siteId}/environments/${env}/secrets/${binding}`,
        method,
        input,
        requestId,
      )
    } catch (error) {
      if (error instanceof SitesClientError) throw error
      throw invalid(
        'Use an uppercase variable name and a non-empty value of at most 5 KB. Platform binding names are reserved.',
      )
    }
  }
  async read(parts: string[], query = new URLSearchParams()) {
    if (parts.length === 0) return this.request('')
    uuid.parse(parts[0])
    if (parts.length === 1) return this.request('/' + parts[0])
    if (parts[1] !== 'environments') throw invalid('Unknown Sites path.')
    environment.parse(parts[2])
    const suffix = parts.slice(3)
    if (
      !(
        suffix.length === 0 ||
        (suffix.length === 1 &&
          ['operations', 'analytics'].includes(suffix[0])) ||
        (suffix.length === 2 &&
          suffix[0] === 'auth' &&
          ['analytics', 'users'].includes(suffix[1])) ||
        (suffix.length === 2 &&
          suffix[0] === 'operations' &&
          uuid.safeParse(suffix[1]).success) ||
        (suffix.length === 3 &&
          suffix[0] === 'storage' &&
          name.safeParse(suffix[1]).success &&
          ['tables', 'rows', 'objects'].includes(suffix[2]))
      )
    )
      throw invalid('Unknown Sites path.')
    const search = new URLSearchParams()
    for (const field of ['table', 'offset', 'cursor', 'q', 'days']) {
      const value = query.get(field)
      if (value !== null && value.length <= 2000) search.set(field, value)
    }
    return this.request(
      '/' +
        parts.map(encodeURIComponent).join('/') +
        (search.size ? '?' + search : ''),
    )
  }
  async runToolWithContext(
    tool: string,
    raw: unknown,
    cwd: string,
    mode: string,
    signal?: AbortSignal,
    context?: { originProjectId: string; originProjectType: 'local' | 'cloud' },
  ) {
    const run = () => this.runTool(tool, raw, cwd, mode, signal)
    return context ? this.context.run(context, run) : run()
  }
  private async runTool(
    tool: string,
    raw: unknown,
    cwd: string,
    mode: string,
    signal?: AbortSignal,
  ) {
    try {
      if (mode === 'plan' && !['sites_list', 'sites_inspect'].includes(tool))
        throw invalid('Sites mutations are unavailable in plan mode.')
      if (tool === 'sites_list')
        return await this.request('', 'GET', undefined, undefined, signal)
      if (tool === 'sites_create') {
        const args = z
          .object({ siteId: uuid, name: z.string().min(1).max(80) })
          .strict()
          .parse(raw)
        return await this.request(
          '',
          'POST',
          { id: args.siteId, name: args.name },
          undefined,
          signal,
        )
      }
      const args = target.passthrough().parse(raw)
      const path = `/${args.siteId}/environments/${args.environment}`
      if (tool === 'sites_inspect') {
        const [environment, activity] = await Promise.all([
          this.request(path, 'GET', undefined, undefined, signal),
          this.request(
            path + '/operations',
            'GET',
            undefined,
            undefined,
            signal,
          ),
        ])
        return { environment, activity }
      }
      if (tool === 'sites_enable_auth') {
        const input = target
          .extend({ localOrigin: z.string().url().optional() })
          .strict()
          .parse(raw)
        return await this.request(
          path + '/auth',
          'POST',
          { localOrigin: input.localOrigin },
          undefined,
          signal,
        )
      }
      const requestId = key.parse(args.requestId)
      if (tool === 'sites_deploy') {
        const manifestPath = z.string().min(1).parse(args.manifestPath)
        const bundle = await (this.options.files?.bundle ?? bundleSite)(
          cwd,
          manifestPath,
        )
        return await this.request(
          path + '/deployments',
          'POST',
          bundle,
          requestId,
          signal,
        )
      }
      if (tool === 'sites_add_storage') {
        const kind = z.enum(['d1', 'r2']).parse(args.kind)
        return await this.request(
          path + '/' + kind,
          'POST',
          { name: name.parse(args.name) },
          requestId,
          signal,
        )
      }
      if (tool === 'sites_set_secret') {
        const binding = name.parse(args.name)
        const value = await (this.options.files?.secret ?? readSiteSecret)(
          cwd,
          z.string().min(1).parse(args.valueFile),
        )
        return await this.request(
          path + '/secrets/' + binding,
          'PUT',
          { value },
          requestId,
          signal,
        )
      }
      throw invalid('Unknown Sites tool.')
    } catch (error) {
      // People read the connection message; an agent also needs to know an
      // unanswered mutation may have landed and is only safe to repeat by key.
      if (error instanceof SitesClientError)
        return {
          error: error.code,
          message:
            error.code === 'sites_connection_failed' &&
            IDEMPOTENT_TOOLS.has(tool)
              ? `${error.message} The operation may still be running: retry with the same requestId.`
              : error.message,
        }
      // Filesystem and validator errors must never echo file contents / secret values.
      return {
        error: 'invalid_site_request',
        message:
          'Could not prepare the Sites request. Check arguments and workspace files.',
      }
    }
  }
}
