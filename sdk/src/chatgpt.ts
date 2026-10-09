/**
 * Sign in with ChatGPT: the OAuth device-code flow the Codex CLI uses, and the
 * token refresh that keeps a saved sign-in usable. The tokens it returns run
 * the Freebuff harness on the user's own ChatGPT plan through the Codex
 * Responses endpoint (see impl/chatgpt-responses.ts); they are stored only as
 * a saved provider's credential, in the same stores as an API key.
 *
 * Every request here has a fixed destination, never follows a redirect, and
 * never puts a provider response body in an error: token endpoints can echo
 * what they were sent.
 */

/** The saved-provider type a ChatGPT sign-in creates. */
export const CHATGPT_BYOK_PROVIDER = 'chatgpt' as const

/** The Codex CLI's public installed-application client. Not a secret. */
export const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_ORIGIN = 'https://auth.openai.com'
const DEVICE_CODE_URL = `${AUTH_ORIGIN}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/deviceauth/token`
const TOKEN_URL = `${AUTH_ORIGIN}/oauth/token`
const DEVICE_REDIRECT_URI = `${AUTH_ORIGIN}/deviceauth/callback`
/** Where the user enters the code. Fixed, so a provider answer cannot redirect them. */
export const CHATGPT_DEVICE_VERIFICATION_URL = `${AUTH_ORIGIN}/codex/device`

/** The Codex backend every ChatGPT-plan request goes to. */
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const CHATGPT_CODEX_RESPONSES_URL = `${CHATGPT_CODEX_BASE_URL}/responses`
/** Sent as `originator`, so OpenAI can tell these requests from the Codex CLI's. */
export const CHATGPT_ORIGINATOR = 'freebuff'

/** A model a ChatGPT sign-in saves as a provider. */
export type ChatGptModelChoice = {
  model: string
  name: string
  /** The plan's input window for it, when the listing reported one. */
  contextWindow?: number
}

/**
 * What a sign-in saves when the plan's own list (listChatGptModels) cannot be
 * read. Limits are explicit so a run never asks the Codex backend for an
 * OpenAI-style `/models` listing; the window is the Codex input limit.
 */
export const CHATGPT_DEFAULT_MODELS: readonly ChatGptModelChoice[] = [
  { model: 'gpt-6-sol', name: 'GPT-6-Sol (ChatGPT)' },
  { model: 'gpt-6-astra', name: 'GPT-6-Astra (ChatGPT)' },
  { model: 'gpt-6-luna', name: 'GPT-6-Luna (ChatGPT)' },
]
export const CHATGPT_CONTEXT_WINDOW = 272_000
export const CHATGPT_MAX_OUTPUT_TOKENS = 32_000

/**
 * The client version the model listing is asked for. OpenAI tailors the list
 * to it, leaving out models newer than the client (0.131.0 is offered two
 * models, 0.153.3 seven, 1.0.0 the full ten as of 2026-10-08), and the
 * Responses endpoint does not check it.
 */
export const CHATGPT_MODELS_CLIENT_VERSION = '1.0.0'

/** Refresh this long before the access token expires. */
export const CHATGPT_REFRESH_MARGIN_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 12_000
const USER_AGENT = 'Freebuff/1.0'

export type ChatGptTokens = {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds. */
  expiresAt: number
  /** The ChatGPT workspace the plan belongs to, sent as `ChatGPT-Account-Id`. */
  accountId?: string
}

export type ChatGptDeviceLogin = {
  deviceAuthId: string
  userCode: string
  verificationUrl: string
  /** Epoch milliseconds. */
  expiresAt: number
  intervalMs: number
}

export type ChatGptDevicePoll =
  | { status: 'pending'; slowDown?: boolean }
  | { status: 'connected'; tokens: ChatGptTokens }

/**
 * A sign-in failure with a message we wrote, safe to show as is. `expired`
 * means the saved sign-in can no longer be refreshed and the user has to sign
 * in again; anything else may succeed on retry.
 */
export class ChatGptAuthError extends Error {
  override name = 'ChatGptAuthError'
  constructor(
    message: string,
    readonly expired = false,
  ) {
    super(message)
  }
}

export const CHATGPT_SIGN_IN_AGAIN =
  'Your ChatGPT sign-in has expired. Sign in with ChatGPT again in API provider settings.'

function decodeClaims(token: unknown): Record<string, unknown> {
  if (typeof token !== 'string') return {}
  const payload = token.split('.')[1]
  if (!payload) return {}
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * The ChatGPT account id a token names. Decoded claims are routing hints
 * only; OpenAI authenticates the token itself.
 */
export function chatGptAccountId(token: unknown): string | undefined {
  const claims = decodeClaims(token)
  const auth = claims['https://api.openai.com/auth'] as
    | Record<string, unknown>
    | undefined
  const id = auth?.chatgpt_account_id ?? claims.chatgpt_account_id
  return typeof id === 'string' && id ? id : undefined
}

function positiveSeconds(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value)
    throw new ChatGptAuthError(
      'ChatGPT returned an unexpected sign-in response. Try again.',
    )
  return value
}

function tokensFrom(
  data: Record<string, unknown>,
  previous?: ChatGptTokens,
): ChatGptTokens {
  const accessToken = requiredString(data.access_token)
  const exp = decodeClaims(accessToken).exp
  const accountId =
    chatGptAccountId(data.id_token) ??
    chatGptAccountId(accessToken) ??
    previous?.accountId
  return {
    accessToken,
    // A refresh may omit the refresh token, which then stays the same.
    refreshToken: requiredString(data.refresh_token || previous?.refreshToken),
    expiresAt:
      typeof exp === 'number'
        ? exp * 1000
        : Date.now() + positiveSeconds(data.expires_in, 3600) * 1000,
    ...(accountId ? { accountId } : {}),
  }
}

async function post(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, string>,
  encoding: 'json' | 'form',
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type':
          encoding === 'json'
            ? 'application/json'
            : 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body:
        encoding === 'json'
          ? JSON.stringify(body)
          : new URLSearchParams(body).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new ChatGptAuthError(
      'Could not reach ChatGPT sign-in. Check your connection and try again.',
    )
  }
}

async function readObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => null)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Step 1: get a code for the user to enter at the verification URL. */
export async function startChatGptDeviceLogin(
  fetchImpl: typeof fetch = fetch,
): Promise<ChatGptDeviceLogin> {
  const response = await post(
    fetchImpl,
    DEVICE_CODE_URL,
    { client_id: CHATGPT_OAUTH_CLIENT_ID },
    'json',
  )
  if (!response.ok) {
    await response.body?.cancel()
    throw new ChatGptAuthError(
      `ChatGPT sign-in could not start (HTTP ${response.status}). Try again in a minute.`,
    )
  }
  const data = await readObject(response)
  return {
    deviceAuthId: requiredString(data.device_auth_id),
    userCode: requiredString(data.user_code),
    verificationUrl: CHATGPT_DEVICE_VERIFICATION_URL,
    expiresAt:
      Date.now() + Math.min(positiveSeconds(data.expires_in, 900), 900) * 1000,
    intervalMs: Math.max(1000, positiveSeconds(data.interval, 5) * 1000),
  }
}

/**
 * Step 2, repeated every `intervalMs`: `pending` until the user approves, then
 * the tokens. The device authorization yields a PKCE code, exchanged here.
 */
export async function pollChatGptDeviceLogin(
  login: Pick<ChatGptDeviceLogin, 'deviceAuthId' | 'userCode' | 'expiresAt'>,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatGptDevicePoll> {
  if (Date.now() >= login.expiresAt)
    throw new ChatGptAuthError('The ChatGPT sign-in code expired. Start again.')
  const response = await post(
    fetchImpl,
    DEVICE_TOKEN_URL,
    { device_auth_id: login.deviceAuthId, user_code: login.userCode },
    'json',
  )
  // Not yet approved.
  if (response.status === 403 || response.status === 404) {
    await response.body?.cancel()
    return { status: 'pending' }
  }
  const data = await readObject(response)
  if (!response.ok) {
    if (data.error === 'authorization_pending') return { status: 'pending' }
    if (data.error === 'slow_down') return { status: 'pending', slowDown: true }
    throw new ChatGptAuthError(
      `ChatGPT sign-in was denied or expired (HTTP ${response.status}). Start again.`,
    )
  }
  const exchange = await post(
    fetchImpl,
    TOKEN_URL,
    {
      grant_type: 'authorization_code',
      code: requiredString(data.authorization_code),
      code_verifier: requiredString(data.code_verifier),
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      redirect_uri: DEVICE_REDIRECT_URI,
    },
    'form',
  )
  if (!exchange.ok) {
    await exchange.body?.cancel()
    throw new ChatGptAuthError(
      `ChatGPT sign-in could not finish (HTTP ${exchange.status}). Start again.`,
    )
  }
  return { status: 'connected', tokens: tokensFrom(await readObject(exchange)) }
}

/**
 * A new access token. OpenAI rotates the refresh token on every use, so a
 * caller must hold its store's lock across this call and save the answer
 * before anyone else refreshes: a second refresh with the old token fails.
 */
export async function refreshChatGptTokens(
  previous: ChatGptTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatGptTokens> {
  const response = await post(
    fetchImpl,
    TOKEN_URL,
    {
      grant_type: 'refresh_token',
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      refresh_token: previous.refreshToken,
    },
    'form',
  )
  if (!response.ok) {
    await response.body?.cancel()
    // 400/401 is a revoked, reused or expired refresh token: only a new
    // sign-in fixes it. Anything else may be transient.
    if (response.status === 400 || response.status === 401)
      throw new ChatGptAuthError(CHATGPT_SIGN_IN_AGAIN, true)
    throw new ChatGptAuthError(
      `Could not refresh your ChatGPT sign-in (HTTP ${response.status}). Try again shortly.`,
    )
  }
  return tokensFrom(await readObject(response), previous)
}

export function needsChatGptRefresh(
  tokens: Pick<ChatGptTokens, 'expiresAt'>,
  now = Date.now(),
): boolean {
  return tokens.expiresAt - now <= CHATGPT_REFRESH_MARGIN_MS
}

/** The stored form of a sign-in. Never logged; it is a credential. */
export function serializeChatGptTokens(tokens: ChatGptTokens): string {
  return JSON.stringify({
    v: 1,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
  })
}

export function parseChatGptTokens(value: string): ChatGptTokens {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(value) as Record<string, unknown>
  } catch {
    throw new ChatGptAuthError(CHATGPT_SIGN_IN_AGAIN, true)
  }
  if (
    data?.v !== 1 ||
    typeof data.accessToken !== 'string' ||
    !data.accessToken ||
    typeof data.refreshToken !== 'string' ||
    !data.refreshToken ||
    typeof data.expiresAt !== 'number'
  )
    throw new ChatGptAuthError(CHATGPT_SIGN_IN_AGAIN, true)
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt,
    ...(typeof data.accountId === 'string' && data.accountId
      ? { accountId: data.accountId }
      : {}),
  }
}

type ListedModel = {
  slug?: unknown
  display_name?: unknown
  visibility?: unknown
  upgrade?: unknown
  priority?: unknown
  context_window?: unknown
}

/**
 * The Codex models the signed-in plan offers, in OpenAI's order: those it
 * lists in its own picker (`visibility: list`), less any being retired in
 * favour of another (`upgrade`). Hidden ones (internal reviewers, retiring
 * models) are left out. Throws ChatGptAuthError; callers fall back to
 * CHATGPT_DEFAULT_MODELS so a sign-in never fails on this.
 */
export async function listChatGptModels(
  tokens: Pick<ChatGptTokens, 'accessToken' | 'accountId'>,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatGptModelChoice[]> {
  let response: Response
  try {
    response = await fetchImpl(
      `${CHATGPT_CODEX_BASE_URL}/models?client_version=${CHATGPT_MODELS_CLIENT_VERSION}`,
      {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${tokens.accessToken}`,
          originator: CHATGPT_ORIGINATOR,
          'user-agent': USER_AGENT,
          ...(tokens.accountId
            ? { 'chatgpt-account-id': tokens.accountId }
            : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    )
  } catch {
    throw new ChatGptAuthError('Could not read your ChatGPT plan’s models.')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new ChatGptAuthError(
      `Could not read your ChatGPT plan’s models (HTTP ${response.status}).`,
    )
  }
  const data = (await response.json().catch(() => null)) as {
    models?: unknown
  } | null
  const listed = (
    Array.isArray(data?.models) ? data.models : []
  ) as ListedModel[]
  const models = listed
    .filter(
      (item): item is ListedModel & { slug: string } =>
        typeof item?.slug === 'string' &&
        /^[\w.:-]{1,128}$/.test(item.slug) &&
        item.visibility === 'list' &&
        !item.upgrade,
    )
    .sort((a, b) => Number(a.priority ?? 1e9) - Number(b.priority ?? 1e9))
    .map((item) => {
      const label =
        typeof item.display_name === 'string' && item.display_name.trim()
          ? item.display_name.trim().slice(0, 200)
          : item.slug
      const window = Number(item.context_window)
      return {
        model: item.slug,
        name: `${label} (ChatGPT)`,
        ...(Number.isInteger(window) &&
        window > CHATGPT_MAX_OUTPUT_TOKENS &&
        window <= 2_000_000
          ? { contextWindow: window }
          : {}),
      }
    })
  if (!models.length)
    throw new ChatGptAuthError('Your ChatGPT plan listed no Codex models.')
  return models
}

/** The plan's models, or the defaults when its list cannot be read. */
export async function chatGptModelsOrDefaults(
  tokens: Pick<ChatGptTokens, 'accessToken' | 'accountId'>,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly ChatGptModelChoice[]> {
  try {
    return await listChatGptModels(tokens, fetchImpl)
  } catch {
    return CHATGPT_DEFAULT_MODELS
  }
}
