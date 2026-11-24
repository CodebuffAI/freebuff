import { resolveRoute, type Provider } from './config'
import { recordUsage, type ApiKeyRow } from './keys'
import type { Env } from './types'

type Usage = { prompt_tokens?: number; completion_tokens?: number }

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function upstreamHeaders(provider: Provider): HeadersInit {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${provider.apiKey}`,
  }
  if (provider.id === 'openrouter') {
    headers['http-referer'] = 'https://opencode.ai'
    headers['x-title'] = 'opencode-server'
  }
  return headers
}

/** Pulls token counts out of a non-streaming response body. */
function usageFromJson(text: string): Usage {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && 'usage' in parsed) {
      const usage = (parsed as { usage?: Usage }).usage
      if (usage) return usage
    }
  } catch {
    // Not JSON: no usage to report.
  }
  return {}
}

/** Pulls the last `usage` object out of an SSE stream. */
async function usageFromStream(stream: ReadableStream<Uint8Array>): Promise<Usage> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let usage: Usage = {}
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim()
        if (payload.length > 0 && payload !== '[DONE]') {
          const candidate = usageFromJson(payload)
          if (candidate.completion_tokens !== undefined) usage = candidate
        }
      }
      newline = buffer.indexOf('\n')
    }
  }
  return usage
}

const PASSTHROUGH_HEADERS = ['content-type', 'cache-control', 'x-request-id']

/**
 * Proxies any POST /v1/<path> to the resolved upstream, recording usage.
 * Streaming responses are teed so the client keeps its SSE stream while the
 * gateway reads the trailing usage chunk.
 */
export async function forward(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  key: ApiKeyRow,
  upstreamPath: string,
  providers: Provider[],
): Promise<Response> {
  const startedAt = Date.now()

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return jsonResponse({ error: { message: 'Request body must be JSON.', type: 'invalid_request_error' } }, 400)
  }

  const requestedModel = typeof body.model === 'string' ? body.model : ''
  if (!requestedModel) {
    return jsonResponse(
      { error: { message: 'Missing required field: model.', type: 'invalid_request_error' } },
      400,
    )
  }

  const route = resolveRoute(providers, requestedModel, env.DEFAULT_PROVIDER)
  if ('error' in route) {
    return jsonResponse({ error: { message: route.error, type: 'configuration_error' } }, 500)
  }

  const streaming = body.stream === true
  const upstreamUrl = `${route.provider.baseUrl}/${upstreamPath}`
  const upstreamBody = JSON.stringify({ ...body, model: route.model })

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders(route.provider),
      body: upstreamBody,
    })
  } catch (error) {
    ctx.waitUntil(
      recordUsage(env.DB, {
        keyId: key.id,
        provider: route.provider.id,
        model: route.model,
        promptTokens: 0,
        completionTokens: 0,
        status: 502,
        latencyMs: Date.now() - startedAt,
      }),
    )
    return jsonResponse(
      {
        error: {
          message: `Upstream ${route.provider.id} is unreachable: ${String(error)}`,
          type: 'upstream_error',
        },
      },
      502,
    )
  }

  const headers = new Headers()
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (streaming) headers.set('cache-control', 'no-cache')

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text()
    ctx.waitUntil(
      recordUsage(env.DB, {
        keyId: key.id,
        provider: route.provider.id,
        model: route.model,
        promptTokens: 0,
        completionTokens: 0,
        status: upstream.status,
        latencyMs: Date.now() - startedAt,
      }),
    )
    return new Response(text, { status: upstream.status, headers })
  }

  if (streaming) {
    const [clientStream, meterStream] = upstream.body.tee()
    ctx.waitUntil(
      (async () => {
        const usage = await usageFromStream(meterStream)
        await recordUsage(env.DB, {
          keyId: key.id,
          provider: route.provider.id,
          model: route.model,
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          status: upstream.status,
          latencyMs: Date.now() - startedAt,
        })
      })(),
    )
    return new Response(clientStream, { status: upstream.status, headers })
  }

  const text = await upstream.text()
  const usage = usageFromJson(text)
  ctx.waitUntil(
    recordUsage(env.DB, {
      keyId: key.id,
      provider: route.provider.id,
      model: route.model,
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      status: upstream.status,
      latencyMs: Date.now() - startedAt,
    }),
  )
  return new Response(text, { status: upstream.status, headers })
}
