import { describe, expect, test } from 'bun:test'
import * as acp from '@agentclientprotocol/sdk'

import { FreebuffAcpAgent } from '../acp-agent'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

/**
 * Drives the ACP server the way a real client (Zed, and any other ACP
 * implementation) does, over the protocol itself rather than by calling the
 * agent's methods: initialize -> session/new -> session/prompt, and checks
 * that the agent's `session/update` notifications carry the turn's content.
 */
function buildAgentApp(backend: FreebuffAcpAgent) {
  return acp
    .agent({ name: 'freebuff-test' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    }))
    .onRequest(acp.methods.agent.session.new, ({ params }) => ({
      sessionId: backend.newSession(params.cwd),
    }))
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const stop = await backend.prompt(params.sessionId, params.prompt, client)
      return { stopReason: stop }
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      backend.cancel(params.sessionId)
    })
}

describe('ACP protocol round trip', () => {
  test('a prompt turn streams agent text to the client as session updates', async () => {
    // A stub turn: the SDK run path itself is covered by the CLI's own
    // integration tests; here we verify the protocol surface.
    const backend = new FreebuffAcpAgent({
      runTurn: async (request) => {
        await request.onEvent({ type: 'text', text: 'hello ' })
        await request.onEvent({ type: 'text', text: 'world' })
        return { previousRun: null }
      },
    })
    const agentApp = buildAgentApp(backend)

    const updates: Array<Record<string, unknown>> = []

    const clientApp = acp
      .client({ name: 'test-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params.update as Record<string, unknown>)
      })

    await clientApp.connectWith(agentApp, async (agent) => {
      const init = await agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
      })
      expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION)

      const session = await agent.request(acp.methods.agent.session.new, {
        cwd: '/tmp/project',
        mcpServers: [],
      })
      expect(session.sessionId).toBeTruthy()

      const response = await agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'say hi' }],
      })
      expect(response.stopReason).toBe('end_turn')
    })

    const kinds = updates.map((u) => u.sessionUpdate)
    expect(kinds).toEqual(['agent_message_chunk', 'agent_message_chunk'])
    expect((updates[0]!.content as { text: string }).text).toBe('hello ')
    expect((updates[1]!.content as { text: string }).text).toBe('world')
  })

  test('the event mapping is what the server sends for a text event', () => {
    const backend = new FreebuffAcpAgent()
    const sessionId = backend.newSession('/tmp/project')
    const event: PrintModeEvent = { type: 'text', text: 'hi' }
    const mapped = backend.eventToUpdate(sessionId, event)
    expect(mapped).toEqual({
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      },
    })
  })
})
