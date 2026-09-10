import { afterEach, describe, expect, mock, test } from 'bun:test'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const { acceptSponsoredProposal, fetchSponsoredProposal } =
  await import('../sponsored-proposal-api')

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

const proposal = {
  _id: 'proposal-1',
  advertiser_id: 'adv-acme',
  state: 'offered' as const,
  advertiser_name: 'Acme Deploys',
  headline: 'Add deploy previews',
  body: 'Wire deploy previews into this repository.',
}

function respond(body: unknown, status = 200): void {
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch
}

describe('fetchSponsoredProposal', () => {
  test('returns present for a valid proposal payload', async () => {
    respond({ proposal })
    expect(await fetchSponsoredProposal('Acme/Deploys', 'token')).toEqual({
      status: 'present',
      proposal,
    })
  })

  test('only an authoritative 200 null is absent', async () => {
    respond({ proposal: null })
    expect(await fetchSponsoredProposal('acme/deploys', 'token')).toEqual({
      status: 'absent',
    })
  })

  test('an HTTP failure is unavailable rather than absent', async () => {
    respond({ error: 'temporary' }, 503)
    expect(await fetchSponsoredProposal('acme/deploys', 'token')).toEqual({
      status: 'unavailable',
    })
  })

  test('a transport failure is unavailable rather than absent', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await fetchSponsoredProposal('acme/deploys', 'token')).toEqual({
      status: 'unavailable',
    })
  })

  test('a malformed success is unavailable rather than current data', async () => {
    respond({ proposal: { ...proposal, steps: 'not-an-array' } })
    expect(await fetchSponsoredProposal('acme/deploys', 'token')).toEqual({
      status: 'unavailable',
    })
  })
})

describe('acceptSponsoredProposal renders a refusal, never a code', () => {
  test('funded_accept_required becomes the sentence that names the remedy (COD-438)', async () => {
    // The server refuses every unfunded off-Cloud Accept by this code, and
    // the CLI cannot make a funded one. The user must read what to do, not
    // the wire code the route answered with.
    respond(
      {
        error: 'funded_accept_required',
        message:
          'Update Freebuff Desktop to accept sponsored tasks. Nothing was started.',
      },
      409,
    )
    const result = await acceptSponsoredProposal('proposal-1', 'token')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.message).not.toContain('funded_accept_required')
    expect(result.message).toContain('Freebuff Desktop')
    expect(result.message.endsWith('.')).toBe(true)
  })

  test("an unknown code yields upstream's own sentence when it sent one", async () => {
    respond(
      { error: 'some_future_refusal', message: 'Open it in the web app.' },
      409,
    )
    const result = await acceptSponsoredProposal('proposal-1', 'token')
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      message: 'Open it in the web app.',
    })
  })

  test('an unknown code with no sentence falls back to a sentence of ours', async () => {
    respond({ error: 'some_future_refusal' }, 422)
    const result = await acceptSponsoredProposal('proposal-1', 'token')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('Freebuff refused this sponsored task.')
  })

  test('genuine prose in `error` is still shown as-is', async () => {
    respond({ error: 'Proposal not found' }, 404)
    const result = await acceptSponsoredProposal('proposal-1', 'token')
    expect(result).toMatchObject({
      ok: false,
      status: 404,
      message: 'Proposal not found',
    })
  })
})
