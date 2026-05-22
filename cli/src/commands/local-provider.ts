/**
 * /local slash command — runtime toggle for the custom OpenAI-compatible
 * provider (Ollama, LM Studio, self-hosted).
 *
 * Mutates process.env at runtime. The SDK reads these env vars lazily on
 * every promptAiSdkStream call, so changes take effect immediately for the
 * next request without needing to rebuild the CodebuffClient.
 *
 * Subcommands:
 *   /local                          — show current status
 *   /local on                       — enable with default Ollama URL (model unchanged)
 *   /local on <model>               — enable with default URL + model override
 *   /local on <url>                 — enable with custom URL (model unchanged)
 *   /local on <url> <model>         — enable with URL + model override
 *   /local set <model>              — alias for `/local on <model>`
 *   /local model <model>            — set model override only (URL must already be set)
 *   /local model clear              — clear the model override
 *   /local off                      — disable, return to Codebuff backend
 *   /local status                   — same as `/local`
 *   /local list                     — query the local provider for available models
 *
 * Agent-level providerOptions.baseUrl always wins; /local only affects agents
 * that don't set their own baseUrl. Same for the model override — agents with
 * an explicit providerOptions.baseUrl use their own declared model.
 */

import {
  PROVIDER_API_KEY_ENV_VAR,
  PROVIDER_BASE_URL_ENV_VAR,
  PROVIDER_MODEL_ENV_VAR,
} from '@codebuff/common/constants/custom-provider'

/** Default URL used by `/local on` when the user doesn't specify one. */
export const DEFAULT_LOCAL_BASE_URL = 'http://localhost:11434/v1'

export type LocalCommandAction =
  | { kind: 'status' }
  | { kind: 'enable'; baseUrl: string; model?: string }
  | { kind: 'set-model'; model: string }
  | { kind: 'clear-model' }
  | { kind: 'list' }
  | { kind: 'disable' }
  | { kind: 'invalid'; reason: string }

function looksLikeUrl(token: string): boolean {
  // Anything with a scheme separator — caller validates the actual scheme.
  return token.includes('://')
}

function isLikelyModelTag(token: string): boolean {
  // Ollama-style tags: name[:tag], e.g. "llama3.1:8b", "gemma4:e2b", "qwen2.5".
  // Reject URL-shaped tokens and flags.
  return Boolean(token) && !looksLikeUrl(token) && !token.startsWith('-')
}

/**
 * Parse the args passed to `/local`. Pure function — no side effects.
 * Exported for unit testing.
 */
export function parseLocalArgs(rawArgs: string): LocalCommandAction {
  const trimmed = rawArgs.trim()

  // No args → show status
  if (!trimmed) {
    return { kind: 'status' }
  }

  const tokens = trimmed.split(/\s+/)
  const subcommand = tokens[0]
  const sub = subcommand.toLowerCase()
  const rest = tokens.slice(1)

  if (sub === 'status') {
    return { kind: 'status' }
  }

  if (sub === 'list' || sub === 'models') {
    return { kind: 'list' }
  }

  if (sub === 'off' || sub === 'disable') {
    if (rest.length > 0) {
      return {
        kind: 'invalid',
        reason: `\`/local ${sub}\` does not take arguments. Got: "${rest.join(' ')}"`,
      }
    }
    return { kind: 'disable' }
  }

  if (sub === 'model') {
    if (rest.length === 0) {
      return {
        kind: 'invalid',
        reason: 'Usage: `/local model <model>` or `/local model clear`',
      }
    }
    const value = rest.join(' ')
    if (value === 'clear' || value === 'off' || value === 'none') {
      return { kind: 'clear-model' }
    }
    if (!isLikelyModelTag(rest[0])) {
      return {
        kind: 'invalid',
        reason: `Invalid model name: "${value}". Expected something like "llama3.1:8b".`,
      }
    }
    return { kind: 'set-model', model: value }
  }

  if (sub === 'on' || sub === 'enable' || sub === 'set') {
    return parseEnable(rest)
  }

  // Looks like a bare URL or bare model (e.g. `/local http://...` or `/local llama3.1:8b`)?
  if (looksLikeUrl(subcommand)) {
    return parseEnable([subcommand, ...rest])
  }
  // Bare model shortcut: must contain `:` so we don't silently accept typos
  // like `/local foobar`. Use `/local on <name>` for tagless models.
  if (subcommand.includes(':') && isLikelyModelTag(subcommand) && rest.length === 0) {
    return { kind: 'enable', baseUrl: DEFAULT_LOCAL_BASE_URL, model: subcommand }
  }

  return {
    kind: 'invalid',
    reason: `Unknown /local subcommand: "${subcommand}". Try: on, off, model, status, list.`,
  }
}

/**
 * Parse the tokens after `/local on` / `/local enable` / `/local set`.
 * Supports four shapes:
 *   (empty)        → default URL, no model override
 *   <url>          → URL, no model override
 *   <model>        → default URL + model
 *   <url> <model>  → URL + model
 */
function parseEnable(tokens: string[]): LocalCommandAction {
  if (tokens.length === 0) {
    return { kind: 'enable', baseUrl: DEFAULT_LOCAL_BASE_URL }
  }

  if (tokens.length === 1) {
    const t = tokens[0]
    // URL-shaped tokens go through URL validation regardless of scheme.
    if (looksLikeUrl(t)) {
      const v = validateBaseUrl(t)
      if (!v.ok) return { kind: 'invalid', reason: v.reason }
      return { kind: 'enable', baseUrl: v.url }
    }
    if (isLikelyModelTag(t)) {
      return { kind: 'enable', baseUrl: DEFAULT_LOCAL_BASE_URL, model: t }
    }
    return { kind: 'invalid', reason: `Could not interpret "${t}" as URL or model name.` }
  }

  // Two or more tokens. Pattern: first is URL, rest joined is model.
  const [first, ...rest] = tokens
  if (!looksLikeUrl(first)) {
    return {
      kind: 'invalid',
      reason: `Expected URL or model. Got: "${first}". Usage: /local on [url] [model]`,
    }
  }
  const v = validateBaseUrl(first)
  if (!v.ok) return { kind: 'invalid', reason: v.reason }
  const modelToken = rest.join(' ')
  if (!isLikelyModelTag(rest[0])) {
    return {
      kind: 'invalid',
      reason: `Invalid model name: "${modelToken}".`,
    }
  }
  return { kind: 'enable', baseUrl: v.url, model: modelToken }
}

function validateBaseUrl(
  raw: string,
):
  | { ok: true; url: string }
  | { ok: false; reason: string } {
  if (!raw || !raw.trim()) {
    return { ok: false, reason: 'URL is required.' }
  }
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    return {
      ok: false,
      reason: `URL must start with http:// or https://. Got: "${raw}"`,
    }
  }
  try {
    // eslint-disable-next-line no-new
    new URL(raw)
  } catch {
    return { ok: false, reason: `Invalid URL: "${raw}"` }
  }
  return { ok: true, url: raw }
}

/**
 * Read the currently-active local provider URL (or undefined if disabled).
 * Reads from process.env so it reflects both shell-set values and /local-set values.
 */
export function getActiveLocalBaseUrl(): string | undefined {
  return process.env[PROVIDER_BASE_URL_ENV_VAR]
}

/** Read the currently-active local model override (or undefined). */
export function getActiveLocalModel(): string | undefined {
  return process.env[PROVIDER_MODEL_ENV_VAR]
}

/**
 * Apply an action to process.env. Returns a user-facing message describing what happened.
 * Side effects are isolated to this function for testability.
 *
 * Note: `list` is async because it hits the network. Other actions are sync.
 */
export async function applyLocalAction(
  action: LocalCommandAction,
): Promise<string> {
  if (action.kind === 'invalid') {
    return `❌ ${action.reason}`
  }

  if (action.kind === 'status') {
    return formatStatus()
  }

  if (action.kind === 'list') {
    return listModels()
  }

  if (action.kind === 'enable') {
    process.env[PROVIDER_BASE_URL_ENV_VAR] = action.baseUrl
    if (action.model) {
      process.env[PROVIDER_MODEL_ENV_VAR] = action.model
    } else {
      // Important: an `enable` without an explicit model clears any previous
      // model override, so an old setting doesn't silently apply to a new URL.
      delete process.env[PROVIDER_MODEL_ENV_VAR]
    }
    const lines = [
      'Local provider: ON',
      `  URL: ${action.baseUrl}`,
    ]
    if (action.model) {
      lines.push(`  Model override: ${action.model}`)
      lines.push('')
      lines.push(
        `Agents that would otherwise use a cloud model will use \`${action.model}\` instead.`,
      )
    } else {
      lines.push('')
      lines.push('⚠️  No model override set. Cloud models (e.g.')
      lines.push('  `anthropic/claude-opus-4-7`) will not exist on the local provider.')
      lines.push('  Run `/local model <name>` (e.g. `/local model llama3.1:8b`)')
      lines.push('  or `/local list` to see available models.')
    }
    lines.push('')
    lines.push('Note: agents with their own `providerOptions.baseUrl` still win.')
    lines.push('Disable with: /local off')
    return lines.join('\n')
  }

  if (action.kind === 'set-model') {
    if (!getActiveLocalBaseUrl()) {
      return [
        '❌ Local provider is OFF. Enable it first with `/local on` before setting a model.',
      ].join('\n')
    }
    process.env[PROVIDER_MODEL_ENV_VAR] = action.model
    return [
      `Model override: ${action.model}`,
      '',
      `Local provider remains ON at ${getActiveLocalBaseUrl()}.`,
      `Agents will use \`${action.model}\` for inference.`,
    ].join('\n')
  }

  if (action.kind === 'clear-model') {
    const wasSet = getActiveLocalModel()
    delete process.env[PROVIDER_MODEL_ENV_VAR]
    if (!wasSet) {
      return 'No model override was set. No change.'
    }
    return [
      `Model override cleared (was: ${wasSet}).`,
      '',
      'Warning: without an override, the agent\'s declared cloud model will be sent',
      'to the local provider — likely a "model not found" error. Either set a new',
      'model with `/local model <name>` or turn local mode off with `/local off`.',
    ].join('\n')
  }

  // action.kind === 'disable'
  const wasBaseUrl = getActiveLocalBaseUrl()
  const wasModel = getActiveLocalModel()
  delete process.env[PROVIDER_BASE_URL_ENV_VAR]
  delete process.env[PROVIDER_API_KEY_ENV_VAR]
  delete process.env[PROVIDER_MODEL_ENV_VAR]
  if (!wasBaseUrl && !wasModel) {
    return 'Local provider was already OFF. No change.'
  }
  const lines = ['Local provider: OFF']
  if (wasBaseUrl) lines.push(`  Previously: ${wasBaseUrl}`)
  if (wasModel) lines.push(`  Cleared model override: ${wasModel}`)
  lines.push('')
  lines.push('Routing returns to the Codebuff backend.')
  return lines.join('\n')
}

function formatStatus(): string {
  const url = getActiveLocalBaseUrl()
  const model = getActiveLocalModel()
  if (!url) {
    return [
      'Local provider: OFF',
      '',
      'All agents (without per-agent providerOptions.baseUrl) go through the Codebuff backend.',
      '',
      `Enable with: /local on <model>   (e.g. /local on llama3.1:8b)`,
      `             /local on           (uses ${DEFAULT_LOCAL_BASE_URL}, no model override)`,
      `Discover available local models: /local list`,
    ].join('\n')
  }
  const lines = [
    'Local provider: ON',
    `  URL: ${url}`,
  ]
  if (model) lines.push(`  Model override: ${model}`)
  else
    lines.push(
      '  Model override: (none — agent\'s declared model will be sent as-is)',
    )
  lines.push('')
  lines.push('Agents without their own providerOptions.baseUrl will use this endpoint.')
  lines.push('Commands: /local model <name>, /local off, /local list')
  return lines.join('\n')
}

/**
 * Query the local provider's `/api/tags` endpoint (Ollama-compatible) to list
 * available models. Best-effort — short timeout, friendly fallback.
 */
async function listModels(): Promise<string> {
  const baseUrl = getActiveLocalBaseUrl()
  if (!baseUrl) {
    return [
      '❌ Local provider is OFF. Run `/local on <url>` first, then `/local list`.',
    ].join('\n')
  }
  // /api/tags lives at the root of the Ollama server, not under /v1.
  // Strip a trailing /v1 if present, then append /api/tags.
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  const tagsUrl = `${root}/api/tags`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(tagsUrl, { signal: controller.signal })
    if (!res.ok) {
      return [
        `Could not list models at ${tagsUrl} (HTTP ${res.status}).`,
        '',
        'Note: this only works for Ollama-compatible providers.',
        'For LM Studio or others, set the model manually with `/local model <name>`.',
      ].join('\n')
    }
    const body = (await res.json()) as { models?: Array<{ name?: string }> }
    const names = (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string')
    if (names.length === 0) {
      return [
        `Local provider has no models loaded.`,
        '',
        'Try `ollama pull llama3.1:8b` (or any tag of your choice) and run `/local list` again.',
      ].join('\n')
    }
    const active = getActiveLocalModel()
    const lines = [`Available models at ${root}:`]
    for (const name of names) {
      const marker = name === active ? '  ▶ ' : '    '
      lines.push(`${marker}${name}`)
    }
    lines.push('')
    lines.push(`Use \`/local model <name>\` to pick one.`)
    return lines.join('\n')
  } catch (e) {
    return [
      `Could not reach ${tagsUrl}.`,
      '',
      'Check that the provider is running and the URL is correct.',
      'For non-Ollama providers, set the model manually with `/local model <name>`.',
    ].join('\n')
  } finally {
    clearTimeout(timeout)
  }
}
