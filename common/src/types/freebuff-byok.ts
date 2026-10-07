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

/** Most saved account providers one account may keep. */
export const ACCOUNT_BYOK_MAX_CONNECTIONS = 20

/** Browser writes carry this header, which a cross-site form cannot send. */
export const ACCOUNT_BYOK_REQUEST_HEADER = 'x-freebuff-byok'

export interface AccountByokConnection {
  id: string
  /** Bumped by every change; runs and edits name the revision they saw. */
  revision: number
  name: string
  provider: AccountByokProvider
  model: string
  /** Normalized endpoint. OpenRouter's is fixed. */
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

/** Changing the provider or endpoint requires supplying the key again. */
export type AccountByokConnectionPatch = Partial<AccountByokConnectionInput>

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
