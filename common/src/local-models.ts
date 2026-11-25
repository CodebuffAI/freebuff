/**
 * Local model runtimes.
 *
 * The agent loop, the tools and "control your device" already exist: a local
 * model reaches them through the same BYOK path as any OpenAI-compatible
 * endpoint. What this module adds is discovery of the runtimes people
 * actually install (Ollama, LM Studio, llama.cpp, vLLM), a loopback-only
 * guarantee, and the connection shape `/local` saves.
 *
 * A local model is not a frontier model. The disclaimer is part of the API
 * because a picker that hides that would be lying about what runs.
 */

export type LocalRuntimeId = 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm'

export type LocalRuntimeDefinition = {
  id: LocalRuntimeId
  label: string
  /** OpenAI-compatible base URL. Loopback only. */
  baseUrl: string
}

/** The default ports each runtime serves its OpenAI-compatible API on. */
export const LOCAL_RUNTIMES: readonly LocalRuntimeDefinition[] = Object.freeze([
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'llamacpp', label: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { id: 'vllm', label: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
])

export type LocalModelInfo = {
  id: string
  /** Reported window, when the runtime reports one. */
  contextWindow?: number
  /** Bytes on disk, when the runtime reports it (Ollama does). */
  sizeBytes?: number
}

export type LocalRuntimeStatus = {
  id: LocalRuntimeId
  label: string
  baseUrl: string
  reachable: boolean
  models: LocalModelInfo[]
  /** A display-safe reason when the probe failed. No URLs with credentials. */
  error?: string
}

export const LOCAL_DISCOVERY_TIMEOUT_MS = 1_500

/**
 * The same rule the BYOK validation uses: a "local" endpoint is loopback.
 * Anything else is a remote provider wearing a local label.
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isInteger(number) && number > 0
    ? number
    : undefined
}

/** The fields the common runtimes use for a model's context window. */
function contextWindowOf(entry: Record<string, unknown>): number | undefined {
  const details =
    entry.details && typeof entry.details === 'object'
      ? (entry.details as Record<string, unknown>)
      : {}
  for (const value of [
    entry.context_length,
    entry.context_window,
    entry.max_model_len,
    entry.max_context_length,
    entry.loaded_context_length,
    details.context_length,
  ]) {
    const window = positiveInteger(value)
    if (window !== undefined) return window
  }
  return undefined
}

/** Parse an OpenAI `/models` body (or Ollama's `/api/tags` shape). */
export function parseLocalModels(body: unknown): LocalModelInfo[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as any).data)
      ? ((body as any).data as unknown[])
      : []
  const models: LocalModelInfo[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id =
      typeof record.id === 'string'
        ? record.id
        : typeof record.model === 'string'
          ? record.model
          : typeof record.name === 'string'
            ? record.name
            : undefined
    if (!id) continue
    const contextWindow = contextWindowOf(record)
    const sizeBytes = positiveInteger(record.size)
    models.push({
      id,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    })
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

async function probeRuntime(input: {
  runtime: LocalRuntimeDefinition
  fetchImpl: typeof fetch
  timeoutMs: number
}): Promise<LocalRuntimeStatus> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  const base = input.runtime.baseUrl.replace(/\/+$/, '')
  try {
    const response = await input.fetchImpl(`${base}/models`, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      return {
        ...input.runtime,
        reachable: false,
        models: [],
        error: `HTTP ${response.status}`,
      }
    }
    const body = await response.json()
    return {
      ...input.runtime,
      reachable: true,
      models: parseLocalModels(body),
    }
  } catch (error) {
    return {
      ...input.runtime,
      reachable: false,
      models: [],
      error:
        error instanceof Error && error.name === 'AbortError'
          ? 'timed out'
          : 'not running',
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe every known runtime in parallel. Never throws: an unreachable runtime
 * is a result with `reachable: false`.
 */
export async function discoverLocalModels(input?: {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  runtimes?: readonly LocalRuntimeDefinition[]
}): Promise<LocalRuntimeStatus[]> {
  const fetchImpl = input?.fetchImpl ?? fetch
  const timeoutMs = input?.timeoutMs ?? LOCAL_DISCOVERY_TIMEOUT_MS
  const runtimes = input?.runtimes ?? LOCAL_RUNTIMES
  return Promise.all(
    runtimes.map((runtime) =>
      isLoopbackBaseUrl(runtime.baseUrl)
        ? probeRuntime({ runtime, fetchImpl, timeoutMs })
        : Promise.resolve({
            ...runtime,
            reachable: false,
            models: [],
            error: 'refused: not a loopback endpoint',
          }),
    ),
  )
}

export type LocalByokInput = {
  name: string
  provider: 'openai-compatible'
  model: string
  baseUrl: string
  /** Local runtimes do not authenticate. A literal placeholder, not a key. */
  apiKey: 'local-device'
  contextWindow?: number
}

/** A connection name that stays readable and fits BYOK's 256-character limit. */
export function localConnectionName(
  runtime: LocalRuntimeId,
  model: string,
): string {
  const slug = model
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `local:${runtime}:${slug || 'model'}`
}

/**
 * The BYOK connection `/local use` saves. Refuses a non-loopback base URL so
 * the word "local" cannot be attached to a remote endpoint.
 */
export function localByokInput(input: {
  runtime: Pick<LocalRuntimeDefinition, 'id' | 'baseUrl'>
  model: string
  modelInfo?: Pick<LocalModelInfo, 'contextWindow'>
  name?: string
}): LocalByokInput {
  if (!isLoopbackBaseUrl(input.runtime.baseUrl)) {
    throw new Error(
      'A local connection must point at a loopback endpoint (localhost or 127.0.0.1).',
    )
  }
  if (!input.model.trim()) throw new Error('Choose a model served by this runtime.')
  return {
    name: input.name ?? localConnectionName(input.runtime.id, input.model),
    provider: 'openai-compatible',
    model: input.model,
    baseUrl: input.runtime.baseUrl.replace(/\/+$/, ''),
    apiKey: 'local-device',
    ...(input.modelInfo?.contextWindow === undefined
      ? {}
      : { contextWindow: input.modelInfo.contextWindow }),
  }
}

/** Rough parameter count from ids such as `qwen2.5-coder:7b`. */
export function parameterBillions(model: string): number | undefined {
  const match = /(?:^|[^0-9])(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/i.exec(model)
  return match ? Number(match[1]) : undefined
}

export type LocalFit = 'comfortable' | 'tight' | 'too-large' | 'unknown'

/**
 * A rough memory fit for a quantized model. 4-bit weights are about 0.7 GB
 * per billion parameters; the agent also needs room for context. This is
 * guidance, not a benchmark, and says so.
 */
export function estimateLocalFit(input: {
  model: string
  totalMemoryBytes: number
}): LocalFit {
  const billions = parameterBillions(input.model)
  if (!billions) return 'unknown'
  const needed = billions * 0.7 * 1024 ** 3
  const usable = input.totalMemoryBytes * 0.6
  if (needed <= usable * 0.7) return 'comfortable'
  if (needed <= usable) return 'tight'
  return 'too-large'
}

export const LOCAL_MODEL_DISCLAIMER =
  'A local model runs on this machine, with no Freebuff server in the path. It will not match the hosted frontier models, especially on CPU-only hardware: expect slower turns and weaker tool use. The tools are the same, so it can still read, edit and run commands in this project.'
