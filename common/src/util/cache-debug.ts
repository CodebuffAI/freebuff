import type { JSONValue } from '../types/json'

type SerializableValue = JSONValue

type SerializableRecord = Record<string, SerializableValue>

export type CacheDebugCorrelation = {
  projectRoot: string
  filename: string
  snapshotId: string
}

function normalizeForJson(value: unknown): SerializableValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (value instanceof URL) {
    return value.toString()
  }

  if (value instanceof Uint8Array) {
    return {
      type: 'Uint8Array',
      byteLength: value.byteLength,
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForJson(item))
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        normalizeForJson(entryValue),
      ]),
    )
  }

  return String(value)
}

function summarizeDataUrl(value: string): SerializableValue {
  if (!value.startsWith('data:')) {
    return value
  }
  const firstComma = value.indexOf(',')
  const header = firstComma >= 0 ? value.slice(0, firstComma) : value
  const payload = firstComma >= 0 ? value.slice(firstComma + 1) : ''
  return {
    type: 'data-url',
    mediaType: header.slice(5).split(';')[0] || 'unknown',
    payloadLength: payload.length,
    preview: payload.slice(0, 32),
  }
}

function summarizeLargeValue(value: SerializableValue): SerializableValue {
  if (Array.isArray(value)) {
    return value.map((item) => summarizeLargeValue(item))
  }

  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.startsWith('data:')) {
      return summarizeDataUrl(value)
    }
    return value
  }

  if ('url' in value && typeof value.url === 'string' && value.url.startsWith('data:')) {
    return {
      ...value,
      url: summarizeDataUrl(value.url),
    }
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      if (key === 'file_data' && typeof entryValue === 'string' && entryValue.startsWith('data:')) {
        return [key, summarizeDataUrl(entryValue)]
      }
      if (key === 'arguments' && typeof entryValue === 'string') {
        return [key, entryValue]
      }
      return [
        key,
        entryValue === undefined ? undefined : summarizeLargeValue(entryValue),
      ]
    }),
  )
}

function parseRequestBody(body: unknown): unknown {
  if (typeof body !== 'string') {
    return body
  }

  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

export function serializeCacheDebugCorrelation(
  correlation: CacheDebugCorrelation,
): string {
  return JSON.stringify(correlation)
}

export function parseCacheDebugCorrelation(
  value: unknown,
): CacheDebugCorrelation | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  try {
    const parsed = JSON.parse(value) as Partial<CacheDebugCorrelation>
    if (
      typeof parsed.projectRoot === 'string' &&
      typeof parsed.filename === 'string' &&
      typeof parsed.snapshotId === 'string'
    ) {
      return {
        projectRoot: parsed.projectRoot,
        filename: parsed.filename,
        snapshotId: parsed.snapshotId,
      }
    }
  } catch {
    return undefined
  }

  return undefined
}

export function normalizeProviderRequestBodyForCacheDebug(params: {
  provider: string
  body: unknown
}): SerializableValue {
  const parsed = parseRequestBody(params.body)
  const body = normalizeForJson(parsed)

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body
  }

  const record = body as SerializableRecord
  const normalized: SerializableRecord = {}

  for (const key of ['model', 'messages', 'tools', 'tool_choice', 'response_format', 'reasoning', 'reasoning_effort', 'verbosity', 'provider']) {
    if (key in record) {
      normalized[key] = summarizeLargeValue(record[key])
    }
  }

  if (params.provider === 'openrouter') {
    for (const key of ['models', 'plugins', 'web_search_options', 'include_reasoning']) {
      if (key in record) {
        normalized[key] = summarizeLargeValue(record[key])
      }
    }
  }

  return normalized
}
