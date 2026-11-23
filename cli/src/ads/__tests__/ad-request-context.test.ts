import { describe, expect, test } from 'bun:test'

import { parseAdClientContext } from '@codebuff/common/types/ad-client-context'
import { normalizeClientUserAgent } from '@codebuff/common/util/client-user-agent'

import { buildAdAuctionRequest } from '../ad-request'

describe('the auction request carries the client context (COD-757)', () => {
  test('a parseable `clientContext` and the CLI product User-Agent', async () => {
    const saved = process.env.CODEBUFF_API_KEY
    process.env.CODEBUFF_API_KEY = saved || 'test-key'
    try {
      const built = await buildAdAuctionRequest({
        provider: 'gravity',
        surface: 'cli_chat',
        placementId: 'Above-Input-CLI',
      })
      expect(built).not.toBeNull()
      const body = JSON.parse(String(built!.init.body))
      expect(body.clientContext).toBeDefined()
      expect(parseAdClientContext(body.clientContext)).toEqual(
        body.clientContext,
      )
      expect(body.clientContext.v).toBe(1)
      // static facts are always known, whatever the test's terminal
      expect(body.clientContext.term.terminal).toBeString()
      expect(body.clientContext.sys.arch).toBeString()

      // `srv.uaProduct` is derived server-side from this header, so it must
      // be the CLI's product token and never the fake browser UA in the body.
      const headers = built!.init.headers as Record<string, string>
      expect(['freebuff-cli', 'codebuff-cli']).toContain(
        normalizeClientUserAgent(headers['User-Agent'])!.product,
      )
    } finally {
      if (saved === undefined) delete process.env.CODEBUFF_API_KEY
      else process.env.CODEBUFF_API_KEY = saved
    }
  })
})

describe('networkAdInView on the auction request', () => {
  test('sent as true only when asked; absent otherwise', async () => {
    const saved = process.env.CODEBUFF_API_KEY
    process.env.CODEBUFF_API_KEY = saved || 'test-key'
    try {
      const body = async (networkAdInView?: boolean) =>
        JSON.parse(
          String(
            (await buildAdAuctionRequest({
              provider: 'gravity',
              surface: 'cli_chat',
              placementId: 'Inline-After-Agent-CLI',
              ...(networkAdInView === undefined ? {} : { networkAdInView }),
            }))!.init.body,
          ),
        )
      expect((await body(true)).networkAdInView).toBe(true)
      expect('networkAdInView' in (await body(false))).toBe(false)
      expect('networkAdInView' in (await body())).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.CODEBUFF_API_KEY
      else process.env.CODEBUFF_API_KEY = saved
    }
  })
})
