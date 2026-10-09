/**
 * Account-level "bring your own key" providers: stored with the Freebuff
 * account and used by Cloud runs from Desktop and the web. Distinct from
 * Desktop's device-local providers, whose keys never leave the computer.
 *
 * No wire shape here carries a key back to a client. A key is write-only:
 * supplied on create or replace, then only ever used server-side.
 */

export const ACCOUNT_BYOK_PROVIDERS = ['openrouter', 'openai-compatible'] as const
export type AccountByokProvider = (typeof ACCOUNT_BYOK_PROVIDERS)[number]
/**
 * A ChatGPT plan, connected by signing in rather than with a key: never
 * accepted on create, only made by the sign-in flow (`/chatgpt/*`).
 */
export const ACCOUNT_BYOK_CHATGPT_PROVIDER = 'chatgpt'
export type AccountByokConnectionProvider =
  | AccountByokProvider
  | typeof ACCOUNT_BYOK_CHATGPT_PROVIDER

/** Most saved account providers one account may keep. */
export const ACCOUNT_BYOK_MAX_CONNECTIONS = 20

/** Browser writes carry this header, which a cross-site form cannot send. */
export const ACCOUNT_BYOK_REQUEST_HEADER = 'x-freebuff-byok'

export interface AccountByokConnection {
  id: string
  /** Bumped by every change; runs and edits name the revision they saw. */
  revision: number
  name: string
  provider: AccountByokConnectionProvider
  model: string
  /** Normalized endpoint. OpenRouter's and ChatGPT's are fixed. */
  baseUrl: string
  contextWindow: number
  maxOutputTokens: number
  keyUpdatedAt: string
  createdAt: string
  updatedAt: string
}

export interface AccountByokConnectionInput {
  name: string
  provider: AccountByokProvider
  model: string
  baseUrl?: string
  apiKey: string
  contextWindow?: number
  maxOutputTokens?: number
}

/**
 * A ChatGPT sign-in in progress: show `userCode` and `verificationUrl`, then
 * poll with `handle` every `intervalMs`. The handle is sealed by the server
 * and opaque to clients.
 */
export interface AccountChatGptLogin {
  handle: string
  userCode: string
  verificationUrl: string
  expiresAt: number
  intervalMs: number
}

export type AccountChatGptPoll =
  | { status: 'pending'; intervalMs: number }
  | { status: 'connected'; connections: AccountByokConnection[] }

export type AccountByokValidation =
  | { ok: true }
  | { ok: false; message: string; statusCode?: number }

/** A Cloud run's account provider, pinned to the revision the user picked. */
export interface CloudByokSelection {
  connectionId: string
  revision: number
}

const CLOUD_BYOK_MODEL =
  /^byok:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9][0-9]{0,8})$/i

/**
 * The model id a Cloud run records when it ran on an account provider, so
 * any client reopening the chat selects the same provider again. The run's
 * `byok` field, not this id, is what the API authorizes.
 */
export function cloudByokModelId(selection: CloudByokSelection): string {
  return `byok:${selection.connectionId}:${selection.revision}`
}

export function parseCloudByokModelId(
  model: string | null | undefined,
): CloudByokSelection | null {
  const match = model ? CLOUD_BYOK_MODEL.exec(model) : null
  return match ? { connectionId: match[1]!, revision: Number(match[2]) } : null
}
