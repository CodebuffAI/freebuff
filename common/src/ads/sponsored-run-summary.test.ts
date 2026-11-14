import { expect, test } from 'bun:test'
import { scrubSponsoredRunSummary } from './sponsored-run-summary'
import { parseSponsoredRunEvidence } from './sponsored-run-evidence'

test('closing explanations survive the wire and remove secret and identifying fields', () => {
  const summary =
    'Signed in, but key creation failed. API key: tiny-secret https://example.com/key user@example.com /Users/josh/private.env'
  const safe = scrubSponsoredRunSummary(summary)!
  expect(safe).toContain('Signed in, but key creation failed.')
  for (const privateValue of ['tiny-secret', 'example.com', '/Users/josh'])
    expect(safe).not.toContain(privateValue)
  expect(
    parseSponsoredRunEvidence({
      version: 1,
      ending: 'completed',
      checks: [],
      agentSummary: summary,
    })?.agentSummary,
  ).toBe(safe)
  expect(
    parseSponsoredRunEvidence({
      version: 1,
      ending: 'completed',
      checks: [],
      agentSummary: 'x'.repeat(801),
    }),
  ).toBeUndefined()
  expect(scrubSponsoredRunSummary('  ')).toBeNull()
})
