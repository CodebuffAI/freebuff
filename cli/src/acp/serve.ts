/**
 * `freebuff --acp` entry point: serves the Agent Client Protocol (v1) over
 * stdio using the official TypeScript SDK. See acp-agent.ts for the design.
 */
import * as acp from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'

import { logger } from '../utils/logger'
import { loadPackageVersion } from '../cli-args'
import { FreebuffAcpAgent } from './acp-agent'
import { acpFreebuffSession } from './freebuff-session'

import type { Logger } from '@codebuff/common/types/contracts/logger'

export const ACP_PROTOCOL_VERSION = acp.PROTOCOL_VERSION

export function serveAcp(options: { logger?: Logger } = {}): void {
  const log: Logger = options.logger ?? logger

  // The constructor takes an options bag, not a bare Logger: passing `log`
  // directly silently dropped it and fell back to the default logger.
  const backend = new FreebuffAcpAgent({ logger: log })

  const app = acp
    .agent({ name: 'freebuff' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
      authMethods: [],
      agentInfo: {
        name: 'freebuff',
        title: 'Freebuff',
        version: loadPackageVersion(),
      },
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

  // Anything written to stdout becomes protocol traffic. The CLI logger writes
  // to its log file, never stdout, and the protocol itself owns
  // `process.stdout`, so the realistic stray writer is `console`. Send those to
  // stderr rather than patching `process.stdout.write`, which the transport
  // itself uses.
  const toStderr = (...args: unknown[]) => console.error(...args)
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr

  let shuttingDown = false
  const shutdown = (code: number) => {
    if (shuttingDown) return
    shuttingDown = true
    void acpFreebuffSession.release('shutdown').finally(() => process.exit(code))
  }

  // The editor owns the lifetime: `closed` settles when the peer closes the
  // pipe or the transport fails. Signals are covered here too, and the held
  // free session is released on the way out.
  process.once('SIGINT', () => shutdown(0))
  process.once('SIGTERM', () => shutdown(0))

  const connection = app.connect(stream)
  connection.closed
    .then(() => shutdown(0))
    .catch((error: unknown) => {
      log.error({ error }, '[acp] protocol stream failed')
      shutdown(1)
    })
  log.info({}, '[acp] serving Agent Client Protocol v1 over stdio')
}
