import { describe, expect, test } from 'bun:test'

import {
  CHATGPT_DEFAULT_MODELS,
  CHATGPT_DEVICE_VERIFICATION_URL,
  CHATGPT_MODELS_CLIENT_VERSION,
  chatGptModelsOrDefaults,
  listChatGptModels,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_SIGN_IN_AGAIN,
  ChatGptAuthError,
  chatGptAccountId,
  needsChatGptRefresh,
  parseChatGptTokens,
  pollChatGptDeviceLogin,
  refreshChatGptTokens,
  serializeChatGptTokens,
  startChatGptDeviceLogin,
} from './chatgpt'
import { fakeChatGptJwt } from './__tests__/fixtures/chatgpt-jwt'

type Call = { url: string; init: RequestInit }
function recorder(answers: Response[]) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const answer = answers.shift()
    if (!answer) throw new Error('unexpected request')
    return answer
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}
const json = (value: unknown, status = 200) => Response.json(value, { status })

describe('ChatGPT device sign-in', () => {
  test('starts with the public Codex client and a fixed verification URL', async () => {
    const { calls, fetchImpl } = recorder([
      json({
        device_auth_id: 'device-1',
        user_code: 'ABCD-EFGH',
        interval: 7,
        verification_uri: 'https://evil.example/phish',
      }),
    ])
    const login = await startChatGptDeviceLogin(fetchImpl)
    expect(login).toMatchObject({
      deviceAuthId: 'device-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: CHATGPT_DEVICE_VERIFICATION_URL,
      intervalMs: 7000,
    })
    expect(calls[0]!.url).toBe(
      'https://auth.openai.com/api/accounts/deviceauth/usercode',
    )
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      client_id: CHATGPT_OAUTH_CLIENT_ID,
    })
    expect(calls[0]!.init.redirect).toBe('error')
  })

  test('reports pending until approval, then exchanges the PKCE code for tokens', async () => {
    const login = {
      deviceAuthId: 'device-1',
      userCode: 'ABCD-EFGH',
      expiresAt: Date.now() + 60_000,
    }
    const pending = recorder([new Response('', { status: 403 })])
    expect(await pollChatGptDeviceLogin(login, pending.fetchImpl)).toEqual({
      status: 'pending',
    })

    const accessToken = fakeChatGptJwt()
    const approved = recorder([
      json({ authorization_code: 'code-1', code_verifier: 'verifier-1' }),
      json({
        access_token: accessToken,
        refresh_token: 'refresh-1',
        id_token: fakeChatGptJwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct_id_token',
          },
        }),
      }),
    ])
    const result = await pollChatGptDeviceLogin(login, approved.fetchImpl)
    expect(result.status).toBe('connected')
    if (result.status !== 'connected') return
    expect(result.tokens).toMatchObject({
      accessToken,
      refreshToken: 'refresh-1',
      accountId: 'acct_id_token',
    })
    expect(result.tokens.expiresAt).toBeGreaterThan(Date.now())
    const exchange = new URLSearchParams(String(approved.calls[1]!.init.body))
    expect(approved.calls[1]!.url).toBe('https://auth.openai.com/oauth/token')
    expect(exchange.get('grant_type')).toBe('authorization_code')
    expect(exchange.get('code')).toBe('code-1')
    expect(exchange.get('code_verifier')).toBe('verifier-1')
  })

  test('an expired code fails without a request', async () => {
    const { calls, fetchImpl } = recorder([])
    await expect(
      pollChatGptDeviceLogin(
        { deviceAuthId: 'd', userCode: 'u', expiresAt: Date.now() - 1 },
        fetchImpl,
      ),
    ).rejects.toBeInstanceOf(ChatGptAuthError)
    expect(calls).toHaveLength(0)
  })
})

describe('ChatGPT token refresh', () => {
  const previous = {
    accessToken: 'old-access',
    refreshToken: 'refresh-1',
    expiresAt: Date.now(),
    accountId: 'acct_previous',
  }

  test('keeps the refresh token and account when the answer omits them', async () => {
    const accessToken = fakeChatGptJwt({ 'https://api.openai.com/auth': {} })
    const { calls, fetchImpl } = recorder([json({ access_token: accessToken })])
    const refreshed = await refreshChatGptTokens(previous, fetchImpl)
    expect(refreshed).toMatchObject({
      accessToken,
      refreshToken: 'refresh-1',
      accountId: 'acct_previous',
    })
    const sent = new URLSearchParams(String(calls[0]!.init.body))
    expect(sent.get('grant_type')).toBe('refresh_token')
    expect(sent.get('refresh_token')).toBe('refresh-1')
  })

  test('a rejected refresh token asks for a new sign-in and never echoes the body', async () => {
    const { fetchImpl } = recorder([
      json({ error: 'refresh_token_reused', echo: 'refresh-1' }, 400),
    ])
    const error = await refreshChatGptTokens(previous, fetchImpl).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ChatGptAuthError)
    expect((error as ChatGptAuthError).expired).toBe(true)
    expect((error as Error).message).toBe(CHATGPT_SIGN_IN_AGAIN)
  })

  test('refreshes inside the margin only', () => {
    expect(needsChatGptRefresh({ expiresAt: Date.now() + 60_000 })).toBe(true)
    expect(needsChatGptRefresh({ expiresAt: Date.now() + 3_600_000 })).toBe(
      false,
    )
  })
})

test('stored tokens round-trip and reject anything else', () => {
  const tokens = {
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: 123,
    accountId: 'acct',
  }
  expect(parseChatGptTokens(serializeChatGptTokens(tokens))).toEqual(tokens)
  expect(() => parseChatGptTokens('sk-not-a-sign-in')).toThrow(ChatGptAuthError)
  expect(() => parseChatGptTokens('{"v":1}')).toThrow(ChatGptAuthError)
})

test('reads the account id from either claim location', () => {
  expect(chatGptAccountId(fakeChatGptJwt())).toBe('acct_fixture')
  expect(
    chatGptAccountId(
      fakeChatGptJwt({
        'https://api.openai.com/auth': undefined,
        chatgpt_account_id: 'acct_top',
      }),
    ),
  ).toBe('acct_top')
  expect(chatGptAccountId('not-a-jwt')).toBeUndefined()
})

describe('ChatGPT plan models', () => {
  const listing = {
    models: [
      {
        slug: 'gpt-5.6-luna',
        display_name: 'GPT-5.6-Luna',
        visibility: 'list',
        priority: 9,
        context_window: 272000,
      },
      {
        slug: 'gpt-reserve',
        display_name: 'GPT-Reserve',
        visibility: 'hide',
        priority: 4,
      },
      {
        slug: 'gpt-6.1-sol',
        display_name: 'GPT-6.1-Sol',
        visibility: 'list',
        priority: 1,
        context_window: 400000,
      },
      {
        slug: 'gpt-5.5',
        display_name: 'GPT-5.5',
        visibility: 'list',
        priority: 13,
        upgrade: { model: 'gpt-6.1-sol' },
      },
      { slug: 'bad slug!', visibility: 'list', priority: 2 },
    ],
  }

  test('lists the plan’s pickable models in its order, at the pinned client version', async () => {
    const { calls, fetchImpl } = recorder([json(listing)])
    const models = await listChatGptModels(
      { accessToken: 'access', accountId: 'acct_1' },
      fetchImpl,
    )
    expect(models).toEqual([
      {
        model: 'gpt-6.1-sol',
        name: 'GPT-6.1-Sol (ChatGPT)',
        contextWindow: 400000,
      },
      {
        model: 'gpt-5.6-luna',
        name: 'GPT-5.6-Luna (ChatGPT)',
        contextWindow: 272000,
      },
    ])
    expect(calls[0]!.url).toBe(
      `https://chatgpt.com/backend-api/codex/models?client_version=${CHATGPT_MODELS_CLIENT_VERSION}`,
    )
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('authorization')).toBe('Bearer access')
    expect(headers.get('chatgpt-account-id')).toBe('acct_1')
    expect(calls[0]!.init.redirect).toBe('error')
  })

  test('falls back to the defaults when the list cannot be read or is empty', async () => {
    for (const answer of [json({ error: 'nope' }, 401), json({ models: [] })]) {
      const { fetchImpl } = recorder([answer])
      expect(
        await chatGptModelsOrDefaults({ accessToken: 'a' }, fetchImpl),
      ).toBe(CHATGPT_DEFAULT_MODELS)
    }
  })
})
