import { describe, expect, test } from 'bun:test'

import { INTEGRATION_TOOLS, integrationsPrompt } from './integration-agent'

import type { IntegrationConnection } from './integrations'

const gmail: IntegrationConnection = {
  app: { slug: 'gmail', name: 'Gmail', logo: 'https://freebuff.com/api/integrations/logo/gmail' },
  accounts: [{ id: 'a', handle: 'gmail_red-castle', label: 'sam@example.com', connectedAt: '2026-10-01T00:00:00Z' }],
}

describe('integrationsPrompt', () => {
  test('offers an app before a task is impossible without it, in both states', () => {
    for (const prompt of [integrationsPrompt([]), integrationsPrompt([gmail])]) {
      expect(prompt).toContain(`Offer an app with ${INTEGRATION_TOOLS.connect}`)
      expect(prompt).toContain('at most once in a conversation')
      expect(prompt).not.toContain('This chat is for everyday work')
    }
  })

  test('chat mode leans towards offering', () => {
    expect(integrationsPrompt([], { chatMode: true })).toContain('This chat is for everyday work')
    expect(integrationsPrompt([gmail], { chatMode: true })).toContain('This chat is for everyday work')
  })

  test("a CLI's helper command names the connect step", () => {
    const names = {
      search: 'freebuff integrations search',
      schemas: 'freebuff integrations schemas',
      run: 'freebuff integrations run',
      connect: 'freebuff integrations connect',
    }
    const prompt = integrationsPrompt([], { names })
    expect(prompt).toContain('Offer an app with freebuff integrations connect')
    expect(prompt).not.toContain(INTEGRATION_TOOLS.connect)
  })
})
