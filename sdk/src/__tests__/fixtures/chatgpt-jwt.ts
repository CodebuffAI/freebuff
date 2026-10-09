/** An unsigned JWT shaped like a ChatGPT access token: an hour of life and an account id. */
export function fakeChatGptJwt(claims: Record<string, unknown> = {}): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return [
    part({ alg: 'none' }),
    part({
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_fixture' },
      ...claims,
    }),
    'signature',
  ].join('.')
}
