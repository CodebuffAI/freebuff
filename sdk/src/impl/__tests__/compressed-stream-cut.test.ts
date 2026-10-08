/**
 * A compressed chat-completions body cut mid-stream must recover like an
 * uncompressed one. When a web deploy takes an instance away, the HTTP body
 * can end cleanly before the gzip stream does. On an identity body that is a
 * clean end, which classifyStreamEndRecovery handles; on a gzip/br body Bun's
 * fetch throws instead (code ZlibError / BrotliDecompressionError). Before
 * those codes counted as transient, every deploy failed several hundred
 * turns (2026-10-08, after SSE gzip went to 100%).
 *
 * This serves real compressed SSE over loopback, ends the response without
 * finishing the compressor, and reads it with the runtime's own fetch.
 */
import http from 'node:http'
import {
  constants as zlibConstants,
  createBrotliCompress,
  createGzip,
} from 'node:zlib'

import { describe, expect, it } from 'bun:test'

import { classifyThrownStreamRecovery } from '../stream-interruption'

type Encoding = 'gzip' | 'br'

async function readCutCompressedBody(encoding: Encoding): Promise<unknown> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Content-Encoding': encoding,
    })
    const compressor =
      encoding === 'gzip'
        ? createGzip({ flush: zlibConstants.Z_SYNC_FLUSH })
        : createBrotliCompress({ flush: zlibConstants.BROTLI_OPERATION_FLUSH })
    compressor.pipe(res)
    compressor.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
    compressor.flush(() => {
      // End the HTTP body with the compressed stream unfinished.
      compressor.unpipe(res)
      setTimeout(() => res.end(), 20)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`)
    await response.text()
    return undefined
  } catch (error) {
    return error
  } finally {
    server.close()
  }
}

describe('a compressed completion stream cut mid-body', () => {
  for (const encoding of ['gzip', 'br'] as const) {
    it(`classifies a cut ${encoding} body as stream-interrupted`, async () => {
      const error = await readCutCompressedBody(encoding)
      // Node's fetch ends such a body cleanly (no throw); that path is
      // classifyStreamEndRecovery's, so there is nothing to classify here.
      if (error === undefined) return
      expect(
        classifyThrownStreamRecovery({ aborted: false, error }),
      ).not.toBeNull()
    })
  }

  it('still leaves an aborted request alone', async () => {
    const error = await readCutCompressedBody('gzip')
    if (error === undefined) return
    expect(classifyThrownStreamRecovery({ aborted: true, error })).toBeNull()
  })
})
