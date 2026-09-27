import type { LogWarningsFunction } from 'ai'

type WarningLog = Parameters<LogWarningsFunction>[0]
type Warning = WarningLog['warnings'][number]

/** Distinct warnings remembered per process; past this the set starts over. */
const MAX_REMEMBERED_WARNINGS = 500

/**
 * The AI SDK repeats this on EVERY call to a v2 model, and our providers
 * (`packages/llm-providers`) are v2 by design, so it says nothing new -- as a
 * `warn` it was one shipped log row per LLM step (~350k rows per 12h once
 * 0.1.0 routed these warnings to the logger).
 */
function isV2CompatibilityNotice(warning: Warning): boolean {
  return (
    warning.type === 'compatibility' &&
    warning.feature === 'specificationVersion'
  )
}

/**
 * Wrap a warning logger so it only sees warnings worth a log row: the v2
 * compatibility notice is dropped and every other warning is logged once per
 * process for each provider/model. The SDK reports per call, so a setting a
 * model does not support would otherwise be logged on every step.
 */
export function createAiSdkWarningFilter(
  log: LogWarningsFunction,
): LogWarningsFunction {
  const seen = new Set<string>()
  return (options) => {
    const fresh = options.warnings.filter((warning) => {
      if (isV2CompatibilityNotice(warning)) return false
      const key = JSON.stringify([options.provider, options.model, warning])
      if (seen.has(key)) return false
      if (seen.size >= MAX_REMEMBERED_WARNINGS) seen.clear()
      seen.add(key)
      return true
    })
    if (fresh.length > 0) log({ ...options, warnings: fresh })
  }
}

/** Keep SDK diagnostics off the terminal while OpenTUI owns its contents. */
export function installAiSdkWarningLogger(log: LogWarningsFunction): () => void {
  const previous = globalThis.AI_SDK_LOG_WARNINGS
  const installed = createAiSdkWarningFilter(log)
  globalThis.AI_SDK_LOG_WARNINGS = installed
  return () => {
    if (globalThis.AI_SDK_LOG_WARNINGS === installed) {
      globalThis.AI_SDK_LOG_WARNINGS = previous
    }
  }
}
