import { afterEach, describe, expect, mock, test } from 'bun:test'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const {
  acceptSponsoredProposal,
  acknowledgeSponsoredProposalDisplay,
  fetchSponsoredProposal,
  previewSponsoredProposal,
  reportSponsoredRunState,
  resolveSponsoredPackage,
  sponsoredProcedureSha256,
} = await import('../sponsored-proposal-api')
const { SPONSORED_INSTALL_CAP_REFUSAL } = await import(
  '@codebuff/common/ads/sponsored-install-tool'
)
const { getCliAdRequestUserAgent } = await import('../ad-client-identity')

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
      runSpecVersion: 1,
      // This build registers `install_package` (COD-965).
      installToolVersion: 1,
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

describe('every proposal request names this CLI build (I3)', () => {
  test('call, callDetailed, getDetailed and the proposal read all send the product User-Agent', async () => {
    const seen: Array<{ url: string; userAgent: string | null }> = []
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          url: String(input),
          userAgent: new Headers(init?.headers).get('user-agent'),
        })
        return new Response(JSON.stringify({ proposal: null }), {
          status: 200,
        })
      },
    ) as unknown as typeof fetch
    // `fetchSponsoredProposal`
    await fetchSponsoredProposal('acme/deploys', 'token')
    // `call`
    await acknowledgeSponsoredProposalDisplay('proposal-1', 'token')
    // `getDetailed`
    await previewSponsoredProposal('proposal-1', 'token')
    // `callDetailed`, through both of its callers
    await acceptSponsoredProposal('proposal-1', 'token', binding())
    await reportSponsoredRunState(
      'proposal-1',
      'run-token',
      { state: 'running', runId: binding().runId },
      'token',
    )
    expect(seen).toHaveLength(5)
    const userAgent = getCliAdRequestUserAgent()
    expect(userAgent).toMatch(/^(Freebuff|Codebuff)-CLI\//)
    for (const request of seen) expect(request.userAgent).toBe(userAgent)
  })
})

describe('the Accept refusals added with COD-665', () => {
  test.each([
    ['sponsor_funding_refused', 'The sponsor could not fund this task'],
    ['accept_expired', 'too much time has passed since it was accepted'],
  ])('%s becomes a sentence, and keeps its code', async (code, sentence) => {
    respond({ error: code }, 409)
    const result = await acceptSponsoredProposal(
      'proposal-1',
      'token',
      binding(),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.code).toBe(code)
    expect(result.message).toContain(sentence)
    expect(result.message).not.toContain(code)
    expect(result.message).toContain('Nothing in your project changed.')
  })
})

describe('resolveSponsoredPackage (install_package, COD-965)', () => {
  test('POSTs the run token and package to the proposal’s resolver, with the session bearer', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      return new Response(
        JSON.stringify({
          allowed: true,
          ecosystem: 'npm',
          name: '@acme/sdk',
          version: '1.2.3',
          declared: false,
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const result = await resolveSponsoredPackage(
      'proposal-1',
      'run-token-1',
      { ecosystem: 'npm', name: '@acme/sdk' },
      'session-token',
    )
    expect(result).toEqual({
      allowed: true,
      ecosystem: 'npm',
      name: '@acme/sdk',
      version: '1.2.3',
      declared: false,
    })
    expect(seen[0]!.url).toEndWith(
      '/api/v1/ads/proposal/proposal-1/packages/resolve',
    )
    expect(seen[0]!.init?.method).toBe('POST')
    expect(
      (seen[0]!.init?.headers as Record<string, string>).authorization,
    ).toBe('Bearer session-token')
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({
      runToken: 'run-token-1',
      ecosystem: 'npm',
      name: '@acme/sdk',
    })
  })

  test('429 is the run’s install cap', async () => {
    respond({ error: 'install_cap' }, 429)
    expect(
      await resolveSponsoredPackage(
        'proposal-1',
        'run-token-1',
        { ecosystem: 'pypi', name: 'requests', version: '2.32.3' },
        'session-token',
      ),
    ).toEqual({ allowed: false, reason: SPONSORED_INSTALL_CAP_REFUSAL })
  })

  test('another refusal is refused, carrying the status or the server’s sentence', async () => {
    respond({}, 503)
    const result = await resolveSponsoredPackage(
      'proposal-1',
      'run-token-1',
      { ecosystem: 'npm', name: '@acme/sdk' },
      'session-token',
    )
    expect(result.allowed).toBe(false)
    respond({ error: 'not_allowed', message: 'Not part of this integration.' }, 403)
    expect(
      await resolveSponsoredPackage(
        'proposal-1',
        'run-token-1',
        { ecosystem: 'npm', name: 'left-pad' },
        'session-token',
      ),
    ).toEqual({ allowed: false, reason: 'Not part of this integration.' })
  })

  test('a malformed 200 and an unreachable server are refusals, never installs', async () => {
    respond({ allowed: true })
    expect(
      (
        await resolveSponsoredPackage(
          'proposal-1',
          'run-token-1',
          { ecosystem: 'npm', name: '@acme/sdk' },
          'session-token',
        )
      ).allowed,
    ).toBe(false)
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(
      (
        await resolveSponsoredPackage(
          'proposal-1',
          'run-token-1',
          { ecosystem: 'npm', name: '@acme/sdk' },
          'session-token',
        )
      ).allowed,
    ).toBe(false)
  })
})
