import { z } from 'zod/v4'

/**
 * Claude Code and Codex running inside a Cloud chat's VM (docs/freebuff-desktop-cloud.md,
 * "Claude Code and Codex in Cloud"). A run request names one with `agent`; without it the
 * run is the Freebuff agent, as before.
 *
 * The CLI runs in the VM, but no credential does: it calls the Cloud API's agent proxy with
 * a token that is valid only while its run is running, and the proxy adds the account's own
 * credential. Codex uses the account's Sign in with ChatGPT; Claude Code uses a key saved
 * for it here (an Anthropic API key or a `claude setup-token` token).
 */
export const CLOUD_CLI_AGENTS = ['claude-code', 'codex'] as const
export type CloudCliAgent = (typeof CLOUD_CLI_AGENTS)[number]
export const cloudCliAgentSchema = z.enum(CLOUD_CLI_AGENTS)

export const CLOUD_CLI_AGENT_LABELS: Record<CloudCliAgent, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

export type CloudCliModel = { id: string; label: string; tagline: string }

/** Same ids as Desktop's local Claude Code picker (freebuff-desktop/src/shared/models.ts). */
export const CLOUD_CLAUDE_MODELS: readonly CloudCliModel[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    tagline: 'Powerful all-round coding model',
  },
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    tagline: "Anthropic's most intelligent model",
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    tagline: 'Fast, capable everyday model',
  },
]

/** Same ids as Desktop's Codex fallback list; the ChatGPT plan decides what it may run. */
export const CLOUD_CODEX_MODELS: readonly CloudCliModel[] = [
  {
    id: 'gpt-6-sol',
    label: 'GPT-6-Sol',
    tagline: 'Reliable agentic workhorse for everyday tasks',
  },
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1-Sol',
    tagline: 'Latest agentic workhorse for everyday tasks',
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6-Astra',
    tagline: 'Most capable model for complex, demanding work',
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6-Luna',
    tagline: 'Fast and affordable agentic coding model',
  },
]

export function cloudCliModels(agent: CloudCliAgent): readonly CloudCliModel[] {
  return agent === 'claude-code' ? CLOUD_CLAUDE_MODELS : CLOUD_CODEX_MODELS
}

export function isCloudCliModel(agent: CloudCliAgent, model: string): boolean {
  return cloudCliModels(agent).some((entry) => entry.id === model)
}

/**
 * A picker value for a CLI agent's model, kept apart from Freebuff catalog ids and
 * `byok:` provider ids: `agent:<agent>:<model>`.
 */
export function cloudCliModelValue(agent: CloudCliAgent, model: string) {
  return `agent:${agent}:${model}`
}

export function parseCloudCliModelValue(
  value: string | null | undefined,
): { agent: CloudCliAgent; model: string } | null {
  const match = value?.match(/^agent:(claude-code|codex):([a-z0-9][a-z0-9.-]{0,99})$/)
  if (!match) return null
  const agent = match[1] as CloudCliAgent
  return isCloudCliModel(agent, match[2]!) ? { agent, model: match[2]! } : null
}

/** What a Claude Code credential is; never its value. */
export const CLAUDE_CREDENTIAL_KINDS = ['api_key', 'oauth_token'] as const
export type ClaudeCredentialKind = (typeof CLAUDE_CREDENTIAL_KINDS)[number]

/**
 * `sk-ant-api…` is an Anthropic Console API key; `sk-ant-oat…` is the long-lived token
 * `claude setup-token` prints for a Claude subscription.
 */
export function claudeCredentialKind(value: string): ClaudeCredentialKind | null {
  if (!/^sk-ant-[A-Za-z0-9_-]{20,400}$/.test(value)) return null
  return value.startsWith('sk-ant-oat') ? 'oauth_token' : 'api_key'
}

export const claudeCredentialInputSchema = z
  .object({ key: z.string().trim().min(1).max(512) })
  .strict()

export type CloudAgentCredentialStatus = {
  claudeCode: {
    kind: ClaudeCredentialKind
    /** The last four characters, to tell two keys apart. */
    hint: string
    updatedAt: string
  } | null
  /**
   * Codex runs on an OpenAI API key saved for it, or else the account's Sign in
   * with ChatGPT. `apiKey` is absent from servers that predate the key.
   */
  codex: {
    signedIn: boolean
    apiKey?: { hint: string; updatedAt: string } | null
  }
}

/** `sk-…` (including `sk-proj-…`): an OpenAI API key for Codex. */
export function isOpenAiApiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]{20,400}$/.test(value) && !value.startsWith('sk-ant-')
}

/**
 * A Freebuff connection's current credential, for Desktop's local runs of the
 * same agent (`POST /api/v1/cloud/agent-credentials/:agent/access`). One login,
 * owned and refreshed by the server, runs both Cloud and this computer; the
 * local CLI's own login is the fallback when there is no connection. Never
 * served to a browser.
 */
export type CloudAgentAccess =
  | { agent: 'claude-code'; kind: ClaudeCredentialKind; token: string }
  | {
      agent: 'codex'
      /** Codex's OpenAI API key. Codex runs on it, when present, instead of the sign-in. */
      apiKey?: string
      /** The ChatGPT sign-in, when there is one; its models need it even beside a key. */
      accessToken?: string
      accountId?: string | null
      /** Epoch milliseconds. */
      expiresAt?: number
    }

/** Device catalogs come from the installed CLI, independently of the VM allowlist. */
export function parseNativeCliModelValue(value: string | null | undefined): { agent: CloudCliAgent; model: string } | null {
  const match = value?.match(/^agent:(claude-code|codex):([a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199})$/)
  return match ? { agent: match[1] as CloudCliAgent, model: match[2]! } : null
}
