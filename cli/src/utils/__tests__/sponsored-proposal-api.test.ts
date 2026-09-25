import { afterEach, describe, expect, mock, test } from 'bun:test'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const {
  acceptSponsoredProposal,
  acknowledgeSponsoredProposalDisplay,
  fetchSponsoredProposal,
  previewSponsoredProposal,
  sponsoredProcedureSha256,
} = await import('../sponsored-proposal-api')

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

function binding() {
  return {
    runId: '00000000-0000-4000-8000-000000000001',
    procedureSha256:
      'e0398edf7222298cb1af685870a496350db33a54d32e766b8d94523f4848e304',
  }
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

describe('funded CLI procedure binding', () => {
  test('carries the opaque target through preview and funded accept', async () => {
    const calls: Request[] = []
    const target = {
      kind: 'workspace' as const,
      workspaceId: '00000000-0000-4000-8000-000000000000',
    }
    const procedure = 'Create the local database foundation.'
    const procedureSha256 = sponsoredProcedureSha256(procedure)
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new Request(input, init))
        return new Response(
          JSON.stringify(
            calls.length === 1
              ? { proposalId: 'proposal-1', procedure, procedureSha256, target }
              : {
                  proposalId: 'proposal-1',
                  state: 'accepted',
                  procedure,
                  runToken: 'run-token',
                  computeGrant: {
                    token: 'scg_1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    proposalId: 'proposal-1',
                    runId: binding().runId,
                    procedureSha256,
                    modelId: 'model',
                    expiresAtMs: Date.now() + 60_000,
                    allowanceUsdMicros: 1,
                  },
                },
          ),
          { status: 200 },
        )
      },
    ) as unknown as typeof fetch
    expect(
      (await previewSponsoredProposal('proposal-1', 'token', target)).ok,
    ).toBe(true)
    expect(
      (
        await acceptSponsoredProposal('proposal-1', 'token', {
          runId: binding().runId,
          procedureSha256,
          target,
        })
      ).ok,
    ).toBe(true)
    expect(calls[0]!.url).toContain(`workspace=${target.workspaceId}`)
    expect(await calls[1]!.json()).toMatchObject({ surface: 'cli', target })
  })

  test('previews the exact reviewed procedure before consent', async () => {
    const procedure = 'Create the local database foundation.'
    const procedureSha256 = sponsoredProcedureSha256(procedure)
    respond({ proposalId: 'proposal-1', procedure, procedureSha256 })
    expect(await previewSponsoredProposal('proposal-1', 'token')).toEqual({
      ok: true,
      preview: { proposalId: 'proposal-1', procedure, procedureSha256 },
    })
  })

  test('rejects a grant that is not bound to the reviewed run', async () => {
    const procedure = 'Wire up the Acme deploy hook.'
    respond({
      proposalId: 'proposal-1',
      procedure,
      runToken: 'run-token',
      computeGrant: {
        token: 'scg_1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        proposalId: 'proposal-1',
        runId: '00000000-0000-4000-8000-000000000099',
        procedureSha256: binding().procedureSha256,
        modelId: 'freebuff/deepseek-v4-flash',
        expiresAtMs: Date.now() + 60_000,
        allowanceUsdMicros: 500_000,
      },
    })
    expect(
      await acceptSponsoredProposal('proposal-1', 'token', binding()),
    ).toMatchObject({
      ok: false,
      status: 502,
    })
  })
})

describe('acknowledgeSponsoredProposalDisplay', () => {
  test('posts to the stable proposal display endpoint with its bearer token', async () => {
    const calls: Request[] = []
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new Request(input, init))
        return new Response(JSON.stringify({ ok: true, recorded: true }), {
          status: 200,
        })
      },
    ) as unknown as typeof fetch
    expect(
      await acknowledgeSponsoredProposalDisplay('proposal-1', 'token'),
    ).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/api/v1/ads/proposal/proposal-1/display')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer token')
  })
})

describe('acceptSponsoredProposal renders a refusal, never a code', () => {
  test('a refusal code becomes the sentence that names the remedy, and keeps its code', async () => {
    // The user must read what to do, not the wire code the route answered
    // with -- and in this surface's words, not Desktop's. The code rides
    // beside it for the one decision the run service makes on it.
    respond(
      {
        error: 'funded_accept_required',
        message:
          'Update Freebuff Desktop to accept sponsored tasks. Nothing was started.',
      },
      409,
    )
    const result = await acceptSponsoredProposal(
      'proposal-1',
      'token',
      binding(),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.message).not.toContain('funded_accept_required')
    expect(result.message).toContain('Update Freebuff')
    expect(result.message).not.toContain('Desktop')
    expect(result.message.endsWith('.')).toBe(true)
    expect(result.code).toBe('funded_accept_required')
  })

  test('the Accept says this build runs in place, and names its surface', async () => {
    const bodies: unknown[] = []
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ error: 'invalid_state' }), {
        status: 409,
      })
    }) as unknown as typeof fetch
    await acceptSponsoredProposal('proposal-1', 'token', {
      ...binding(),
      clientExecutionSurface: 'cli_linux',
    })
    expect(bodies[0]).toMatchObject({
      surface: 'cli',
      inPlaceExecutionVersion: 1,
      clientExecutionSurface: 'cli_linux',
    })
  })

  test("an unknown code yields upstream's own sentence when it sent one", async () => {
    respond(
      { error: 'some_future_refusal', message: 'Open it in the web app.' },
      409,
    )
    const result = await acceptSponsoredProposal(
      'proposal-1',
      'token',
      binding(),
    )
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      message: 'Open it in the web app.',
    })
  })

  test('an unknown code with no sentence falls back to a sentence of ours', async () => {
    respond({ error: 'some_future_refusal' }, 422)
    const result = await acceptSponsoredProposal(
      'proposal-1',
      'token',
      binding(),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('Freebuff refused this sponsored task.')
  })

  test('genuine prose in `error` is still shown as-is', async () => {
    respond({ error: 'Proposal not found' }, 404)
    const result = await acceptSponsoredProposal(
      'proposal-1',
      'token',
      binding(),
    )
    expect(result).toMatchObject({
      ok: false,
      status: 404,
      message: 'Proposal not found',
    })
  })
})
