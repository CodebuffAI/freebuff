// Defensive Strategy 4a from the prompt-injection hardening guide:
// strip common injection delimiter tags from tool output before it enters the
// model's context. This is a heuristic speed bump, not a security boundary;
// the primary defenses remain least privilege, sandboxing and human
// confirmation. We never mutate the original value (callers pass clones).

// Matches opening/closing delimiter tags commonly used in injection payloads,
// e.g. <system>, </injection>, <ignore>, <important>. Case-insensitive.
const INJECTION_TAG_PATTERN = /<\s*\/?\s*(?:injection|system|ignore|important|assistant|user|tool)\s*>/gi

export function sanitizeInjectionMarkers(text: string): string {
  return text.replace(INJECTION_TAG_PATTERN, '')
}

export function sanitizeToolOutputValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeInjectionMarkers(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolOutputValue(item))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeToolOutputValue(v)
    }
    return out
  }
  return value
}
