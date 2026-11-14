/**
 * The CLI's account step for a sponsored run (`sponsored-account-step.ts`):
 * the sign-in question, the masked key form, and what the model is told.
 * Everything is injected; nothing opens a browser or writes a file.
 */
import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'

import {
  LAB_SIGNUP_DECLINED_NOTE,
  LAB_SIGNUP_NO_STEP_NOTE,
} from '@codebuff/common/ads/agentic-ad-lab-run'
import { resolveSponsoredCredentialLinks } from '@codebuff/common/ads/sponsored-run-links'

import {
  SponsoredAccountStep,
  SponsoredHeldCredentials,
} from '../sponsored-account-step'

import type {
  SponsoredAccountAsk,
  SponsoredAccountStepDeps,
} from '../sponsored-account-step'

const KEY = 'acme_live_0123456789abcdef'
const CREDENTIAL = {
  env: 'ACME_API_KEY',
  label: 'Acme API key',
  getUrl: 'https://acme.example/keys',
}

function harness(overrides: Partial<SponsoredAccountStepDeps> = {}) {
  const shown: Array<SponsoredAccountAsk | null> = []
  const opened: string[] = []
  const saved: Array<Readonly<Record<string, string>>> = []
  let now = 1_000
  const held = new SponsoredHeldCredentials()
  const step = new SponsoredAccountStep({
    offerName: 'Acme',
    signup: undefined,
    credentials: [CREDENTIAL],
    held,
    openUrl: async (url) => {
      opened.push(url)
      return true
    },
    show: (ask) => shown.push(ask),
    save: async (values) => {
      saved.push(values)
      return '.env.local'
    },
    deadlineMs: () => now + 60_000,
    now: () => now,
    ...overrides,
  })
  return {
    step,
    held,
    shown,
    opened,
    saved,
    advance: (ms: number) => {
      now += ms
    },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a credential-only campaign', () => {
  test('the key form is the question; a short key is refused and the form stays up', async () => {
    const h = harness()
    const result = h.step.request(new AbortController().signal)
    await tick()
    expect(h.step.asking?.kind).toBe('credentials')
    expect(
      h.step.answer({ kind: 'credentials', values: { ACME_API_KEY: 'abc' } }),
    ).toBe('That Acme API key looks too short. Paste the whole key.')
    expect(h.shown.at(-1)).toMatchObject({
      kind: 'credentials',
      error: 'That Acme API key looks too short. Paste the whole key.',
    })
    expect(
      h.step.answer({
        kind: 'credentials',
        values: { ACME_API_KEY: `  ${KEY} ` },
      }),
    ).toBeNull()
    const answered = await result
    expect(answered.status).toBe('confirmed')
    // Names only: the model is told the variable, never the value.
    expect(answered.note).toContain('`ACME_API_KEY`')
    expect(answered.note).toContain('`.env.local`')
    expect(answered.note).not.toContain(KEY)
    expect(h.held.env()).toEqual({ ACME_API_KEY: KEY })
    expect(h.saved).toEqual([{ ACME_API_KEY: KEY }])
    expect(h.shown.at(-1)).toBeNull()
  })

  test('skip is a decline, and a decline is final', async () => {
    const h = harness()
    const first = h.step.request(new AbortController().signal)
    await tick()
    h.step.answer({ kind: 'skip' })
    expect(await first).toEqual({
      status: 'declined',
      note: LAB_SIGNUP_DECLINED_NOTE,
    })
    expect((await h.step.request(new AbortController().signal)).status).toBe(
      'declined',
    )
    expect(h.held.size).toBe(0)
    expect(h.saved).toEqual([])
  })

  test('the deadline continues without the key', async () => {
    const h = harness({ deadlineMs: () => 0 })
    const result = await h.step.request(new AbortController().signal)
    expect(result.status).toBe('declined')
    expect(h.held.size).toBe(0)
  })

  test('a stopped run stops waiting', async () => {
    const h = harness()
    const abort = new AbortController()
    const result = h.step.request(abort.signal)
    await tick()
    abort.abort()
    expect((await result).status).toBe('declined')
    expect(h.step.asking).toBeNull()
  })

  test('an unsaved key says so, so the model tells the user', async () => {
    const h = harness({ save: async () => undefined })
    const result = h.step.request(new AbortController().signal)
    await tick()
    h.step.answer({ kind: 'credentials', values: { ACME_API_KEY: KEY } })
    expect((await result).note).toContain(
      'Freebuff did NOT save the value to an env file',
    )
  })
})

describe('a tracked signup link', () => {
  const signup = {
    url: 'https://acme.example/signup?bfcid=bfc_1.p.s&email={email}',
  }

  test('opens the link without the email, asks, and a Yes confirms then asks for the key', async () => {
    const h = harness({ signup })
    const result = h.step.request(new AbortController().signal)
    await tick()
    expect(h.opened).toEqual(['https://acme.example/signup?bfcid=bfc_1.p.s'])
    expect(h.step.asking).toEqual({
      kind: 'signin',
      offerName: 'Acme',
      url: 'https://acme.example/signup?bfcid=bfc_1.p.s',
      opened: true,
    })
    h.step.answer({ kind: 'signin', confirmed: true })
    await tick()
    expect(h.step.signupConfirmed).toBe(true)
    expect(h.step.asking?.kind).toBe('credentials')
    h.step.answer({ kind: 'credentials', values: { ACME_API_KEY: KEY } })
    const answered = await result
    expect(answered.status).toBe('confirmed')
    expect(answered.note).toStartWith('The user confirmed browser sign-in.')
    expect(answered.note).toContain('`ACME_API_KEY`')
  })

  test('a No declines and confirms nothing', async () => {
    const h = harness({ signup, credentials: [] })
    const result = h.step.request(new AbortController().signal)
    await tick()
    h.step.answer({ kind: 'signin', confirmed: false })
    expect((await result).status).toBe('declined')
    expect(h.step.signupConfirmed).toBe(false)
  })

  test('a browser that would not open still shows the link', async () => {
    const h = harness({ signup, credentials: [], openUrl: async () => false })
    void h.step.request(new AbortController().signal)
    await tick()
    expect(h.step.asking).toMatchObject({ kind: 'signin', opened: false })
  })

  test('an unresolvable link opens nothing', async () => {
    const h = harness({ signup: { url: null } })
    expect((await h.step.request(new AbortController().signal)).status).toBe(
      'unavailable',
    )
    expect(h.opened).toEqual([])
  })
})

describe('a key page link with a {bfcid} slot (COD-965)', () => {
  const TOKEN = 'bfc_1.p.s'
  const declared = [
    {
      env: 'ACME_API_KEY',
      label: 'Acme API key',
      getUrl: 'https://acme.example/keys?bfcid={bfcid}',
    },
    {
      env: 'ACME_ORG',
      label: 'Acme org id',
      getUrl: 'https://acme.example/org',
    },
  ]

  test('takes the signed click id, and the form shows that link', async () => {
    const credentials = resolveSponsoredCredentialLinks(declared, {
      advertiserLink: `https://acme.example/?bfcid=${TOKEN}`,
    })
    expect(credentials).toEqual([
      { ...declared[0]!, getUrl: `https://acme.example/keys?bfcid=${TOKEN}` },
      declared[1]!,
    ])
    const h = harness({ credentials })
    void h.step.request(new AbortController().signal)
    await Promise.resolve()
    const ask = h.step.asking
    expect(ask?.kind).toBe('credentials')
    if (ask?.kind !== 'credentials') return
    expect(ask.credentials[0]!.getUrl).toBe(
      `https://acme.example/keys?bfcid=${TOKEN}`,
    )
  })

  test('without a signed click id the link is dropped, never shown with the slot', () => {
    for (const advertiserLink of [null, 'https://acme.example/', undefined]) {
      const credentials = resolveSponsoredCredentialLinks(declared, {
        advertiserLink: advertiserLink as string | null,
      })
      expect(credentials).toEqual([
        { env: 'ACME_API_KEY', label: 'Acme API key' },
        declared[1]!,
      ])
      expect(JSON.stringify(credentials)).not.toContain('bfcid}')
    }
  })

  test('an encoded slot is filled too, and an {email} slot is removed', () => {
    const [credential] = resolveSponsoredCredentialLinks(
      [
        {
          env: 'ACME_API_KEY',
          label: 'Acme API key',
          getUrl: 'https://acme.example/keys?bfcid=%7Bbfcid%7D&email={email}',
        },
      ],
      { advertiserLink: `https://acme.example/?bfcid=${TOKEN}` },
    )
    expect(credential!.getUrl).toBe(`https://acme.example/keys?bfcid=${TOKEN}`)
  })
})

test('no account step answers unavailable', async () => {
  const h = harness({ credentials: [] })
  expect(await h.step.request(new AbortController().signal)).toEqual({
    status: 'unavailable',
    note: LAB_SIGNUP_NO_STEP_NOTE,
  })
})

test('held credentials never serialize their values', () => {
  const held = new SponsoredHeldCredentials()
  held.hold([{ name: 'ACME_API_KEY', value: KEY }])
  expect(JSON.stringify({ held })).not.toContain(KEY)
  expect(inspect(held)).not.toContain(KEY)
  expect(`${held}`).not.toContain(KEY)
  expect(held.redactDeep({ stdout: `key=${KEY}` })).toEqual({
    stdout: 'key=[redacted:ACME_API_KEY]',
  })
  held.forget()
  expect(held.env()).toBeUndefined()
})

describe('the unfilled click id guard (COD-965)', () => {
  const TOKEN = 'bfc_1.p.s'
  const SIGNED = `https://acme.example/?bfcid=${TOKEN}`

  test('a sign-up link with a placeholder is never opened; the signed advertiser link is', async () => {
    const blocked: string[] = []
    const h = harness({
      signup: { url: 'https://acme.example/signup?bfcid=%257Bbfcid%257D' },
      credentials: [],
      advertiserLink: SIGNED,
      onUnfilledClickIdBlocked: (fallback) => blocked.push(fallback),
    })
    void h.step.request(new AbortController().signal)
    await tick()
    expect(h.opened).toEqual([SIGNED])
    expect(blocked).toEqual(['advertiser_link'])
  })

  test('with no signed advertiser link nothing is opened and the step is unavailable', async () => {
    const blocked: string[] = []
    const h = harness({
      signup: { url: 'https://acme.example/signup?bfcid={bfcid}' },
      credentials: [],
      onUnfilledClickIdBlocked: (fallback) => blocked.push(fallback),
    })
    const result = await h.step.request(new AbortController().signal)
    expect(result.status).toBe('unavailable')
    expect(h.opened).toEqual([])
    expect(blocked).toEqual(['none'])
  })

  test('the key form never shows a placeholder key page', async () => {
    const h = harness({
      credentials: [
        { ...CREDENTIAL, getUrl: 'https://acme.example/keys?bfcid={bfcid}' },
      ],
    })
    void h.step.request(new AbortController().signal)
    await tick()
    const ask = h.step.asking
    if (ask?.kind !== 'credentials') throw new Error('expected the form')
    expect(ask.credentials).toEqual([
      { env: CREDENTIAL.env, label: CREDENTIAL.label },
    ])
  })
})
