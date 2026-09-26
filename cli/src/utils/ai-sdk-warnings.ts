import type { LogWarningsFunction } from 'ai'

/** Keep SDK diagnostics off the terminal while OpenTUI owns its contents. */
export function installAiSdkWarningLogger(log: LogWarningsFunction): () => void {
  const previous = globalThis.AI_SDK_LOG_WARNINGS
  globalThis.AI_SDK_LOG_WARNINGS = log
  return () => {
    if (globalThis.AI_SDK_LOG_WARNINGS === log) {
      globalThis.AI_SDK_LOG_WARNINGS = previous
    }
  }
}
