/**
 * `freebuff --acp` entry point: serves the Agent Client Protocol (v1) over
 * stdio using the official TypeScript SDK. See acp-agent.ts for the design.
 */
import * as acp from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'

import { logger } from '../utils/logger'
import { FreebuffAcpAgent } from './acp-agent'

import type { Logger } from '@codebuff/common/types/contracts/logger'

export const ACP_PROTOCOL_VERSION = acp.PROTOCOL_VERSION

export function serveAcp(options: { logger?: Logger } = {}): void {
  const log: Logger = options.logger ?? logger

  const backend = new FreebuffAcpAgent(log)

  const app = acp
    .agent({ name: 'freebuff' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
      authMethods: [],
      agentInfo: { name: 'freebuff', title: 'Freebuff', version: '1.0.0' },
    }))
    .onRequest(acp.methods.agent.session.new, ({ params }) => {
      const sessionId = backend.newSession(params.cwd)
      return { sessionId }
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const stop = await backend.prompt(params.sessionId, params.prompt, client)
      return { stopReason: stop }
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      backend.cancel(params.sessionId)
    })

  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  )
  app.connect(stream)
  log.info({}, '[acp] serving Agent Client Protocol v1 over stdio')
}
