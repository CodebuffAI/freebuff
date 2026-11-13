import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Writable } from 'node:stream'
import { pipeline as nodePipeline } from 'node:stream/promises'

const require = createRequire(import.meta.url)

const helperModules = [
  {
    name: 'shared release helper',
    path: fileURLToPath(
      new URL('../../../release-core/http.js', import.meta.url),
    ),
  },
]

function createResponse(
  statusCode: number,
  headers: Record<string, string>,
  body = '',
) {
  const response = Readable.from(body.length > 0 ? [body] : [])
  return Object.assign(response, {
    statusCode,
    headers,
  })
}

function createConnectRequest({
  statusCode = 200,
  tunnelSocket,
  recorder,
}: {
  statusCode?: number
  tunnelSocket: object
  recorder: { timeoutCalls: number }
}) {
  const emitter = new EventEmitter()

  return {
    on(event: string, listener: (...args: any[]) => void) {
      emitter.on(event, listener)
      return this
    },
    setTimeout() {
      recorder.timeoutCalls += 1
      return this
    },
    destroy() {},
    end() {
      queueMicrotask(() => {
        emitter.emit('connect', { statusCode }, tunnelSocket)
      })
    },
  }
}

for (const helperModule of helperModules) {
  describe(helperModule.name, () => {
    test('uses plain HTTP for local release servers', async () => {
      const httpGetCalls: Array<Record<string, unknown>> = []
      const { createReleaseHttpClient } = require(helperModule.path)
      const client = createReleaseHttpClient({
        env: {},
        userAgent: 'release-test-agent',
        requestTimeout: 2500,
        httpModule: {
          get(
            options: Record<string, unknown>,
            callback: (response: Readable) => void,
          ) {
            httpGetCalls.push(options)
            queueMicrotask(() => callback(createResponse(200, {}, 'ok')))
            return {
              on() {
                return this
              },
              setTimeout() {
                return this
              },
              destroy() {},
            }
          },
        },
        httpsModule: {
          get() {
            throw new Error('HTTPS transport should not be used')
          },
        },
      })

      const response = await client.httpGet('http://localhost/releases/file')
      response.resume()

      expect(httpGetCalls).toEqual([
        {
          hostname: 'localhost',
          port: 80,
          path: '/releases/file',
          headers: { 'User-Agent': 'release-test-agent' },
        },
      ])
    })

    test('sends HTTP release requests through an HTTP proxy', async () => {
      const httpGetCalls: Array<Record<string, unknown>> = []
      const { createReleaseHttpClient } = require(helperModule.path)
      const client = createReleaseHttpClient({
        env: { HTTP_PROXY: 'http://proxy.internal:7890' },
        userAgent: 'release-test-agent',
        requestTimeout: 2500,
        httpModule: {
          get(
            options: Record<string, unknown>,
            callback: (response: Readable) => void,
          ) {
            httpGetCalls.push(options)
            queueMicrotask(() => callback(createResponse(200, {}, 'ok')))
            return {
              on() {
                return this
              },
              setTimeout() {
                return this
              },
              destroy() {},
            }
          },
        },
      })

      const response = await client.httpGet(
        'http://releases.internal:3000/files/asset',
      )
      response.resume()

      expect(httpGetCalls).toEqual([
        {
          hostname: 'proxy.internal',
          port: '7890',
          path: 'http://releases.internal:3000/files/asset',
          headers: {
            Host: 'releases.internal:3000',
            'User-Agent': 'release-test-agent',
          },
        },
      ])
    })

    test('uses a tunnel agent instead of createConnection for proxied HTTPS requests', async () => {
      const connectCalls: Array<Record<string, unknown>> = []
      const httpsGetCalls: Array<Record<string, unknown>> = []
      const tlsConnectCalls: Array<Record<string, unknown>> = []

      const tunnelSocket = { kind: 'tunnel-socket' }
      const tlsSocket = { kind: 'tls-socket' }

      const { createReleaseHttpClient } = require(helperModule.path)

      const client = createReleaseHttpClient({
        env: {
          HTTPS_PROXY: 'http://proxy.internal:7890',
        },
        userAgent: 'release-test-agent',
        requestTimeout: 2500,
        httpModule: {
          request(options: Record<string, unknown>) {
            connectCalls.push(options)
            return createConnectRequest({
              tunnelSocket,
              recorder: { timeoutCalls: 0 },
            })
          },
        },
        httpsModule: {
          Agent: class FakeAgent {
            options: Record<string, unknown>

            constructor(options: Record<string, unknown>) {
              this.options = options
            }
          },
          get(
            options: Record<string, any>,
            callback: (response: Readable) => void,
          ) {
            httpsGetCalls.push(options)
            options.agent.createConnection(options)
            queueMicrotask(() => {
              callback(createResponse(200, {}, '{"version":"0.0.33"}'))
            })
            return {
              on() {
                return this
              },
              setTimeout() {
                return this
              },
              destroy() {},
            }
          },
        },
        tlsModule: {
          connect(options: Record<string, unknown>) {
            tlsConnectCalls.push(options)
            return tlsSocket
          },
        },
      })

      const response = await client.httpGet(
        'https://registry.npmjs.org/freebuff/latest',
      )
      response.resume()

      expect(connectCalls).toHaveLength(1)
      expect(connectCalls[0]).toMatchObject({
        hostname: 'proxy.internal',
        port: '7890',
        method: 'CONNECT',
        path: 'registry.npmjs.org:443',
        headers: {
          Host: 'registry.npmjs.org:443',
        },
      })

      expect(httpsGetCalls).toHaveLength(1)
      expect(httpsGetCalls[0]?.createConnection).toBeUndefined()
      expect(httpsGetCalls[0]?.agent).toBeDefined()
      expect(httpsGetCalls[0]).toMatchObject({
        hostname: 'registry.npmjs.org',
        path: '/freebuff/latest',
        headers: {
          'User-Agent': 'release-test-agent',
        },
      })

      expect(tlsConnectCalls).toEqual([
        {
          socket: tunnelSocket,
          servername: 'registry.npmjs.org',
        },
      ])
    })

    test('reuses the same proxy strategy across redirects', async () => {
      const httpsGetCalls: Array<Record<string, unknown>> = []

      const { createReleaseHttpClient } = require(helperModule.path)

      let callCount = 0
      const client = createReleaseHttpClient({
        env: {
          HTTPS_PROXY: 'http://proxy.internal:7890',
        },
        userAgent: 'release-test-agent',
        requestTimeout: 2500,
        httpModule: {
          request() {
            return createConnectRequest({
              tunnelSocket: { kind: 'tunnel-socket' },
              recorder: { timeoutCalls: 0 },
            })
          },
        },
        httpsModule: {
          Agent: class FakeAgent {},
          get(
            options: Record<string, any>,
            callback: (response: Readable) => void,
          ) {
            httpsGetCalls.push(options)
            callCount += 1

            queueMicrotask(() => {
              if (callCount === 1) {
                callback(
                  createResponse(307, {
                    location: '/redirected',
                  }),
                )
                return
              }

              callback(createResponse(200, {}, 'ok'))
            })

            return {
              on() {
                return this
              },
              setTimeout() {
                return this
              },
              destroy() {},
            }
          },
        },
        tlsModule: {
          connect() {
            return { kind: 'tls-socket' }
          },
        },
      })

      const response = await client.httpGet(
        'https://registry.npmjs.org/freebuff/latest',
      )
      response.resume()

      expect(httpsGetCalls).toHaveLength(2)
      expect(httpsGetCalls[0]).toMatchObject({
        hostname: 'registry.npmjs.org',
        path: '/freebuff/latest',
      })
      expect(httpsGetCalls[1]).toMatchObject({
        hostname: 'registry.npmjs.org',
        path: '/redirected',
      })
      expect(
        httpsGetCalls.every((call) => call.createConnection === undefined),
      ).toBe(true)
      expect(httpsGetCalls.every((call) => call.agent != null)).toBe(true)
    })

    test('refuses redirect credentials and unexpected ports', async () => {
      for (const location of [
        'https://user:pass@github.com/releases/freebuff.tar.gz',
        'https://github.com:444/releases/freebuff.tar.gz',
      ]) {
        let callCount = 0
        const { createReleaseHttpClient } = require(helperModule.path)
        const client = createReleaseHttpClient({
          env: {},
          userAgent: 'release-test-agent',
          requestTimeout: 2500,
          httpsModule: {
            get(_options: unknown, callback: (response: Readable) => void) {
              callCount += 1
              queueMicrotask(() => {
                callback(createResponse(302, { location }))
              })
              return {
                on() {
                  return this
                },
                setTimeout() {
                  return this
                },
                destroy() {},
              }
            },
          },
        })

        await expect(
          client.httpGet('https://codebuff.com/api/releases/download/file'),
        ).rejects.toMatchObject({ code: 'EREDIRECT_REFUSED' })
        expect(callCount).toBe(1)
      }
    })

    test('limits redirect chains', async () => {
      const { createReleaseHttpClient } = require(helperModule.path)
      let callCount = 0

      const client = createReleaseHttpClient({
        env: {},
        userAgent: 'release-test-agent',
        requestTimeout: 2500,
        httpsModule: {
          get(_options: unknown, callback: (response: Readable) => void) {
            callCount += 1
            queueMicrotask(() => {
              callback(createResponse(302, { location: '/again' }))
            })
            return {
              on() {
                return this
              },
              setTimeout() {
                return this
              },
              destroy() {},
            }
          },
        },
      })

      await expect(
        client.httpGet('https://example.com/start', { maxRedirects: 2 }),
      ).rejects.toThrow('Too many redirects')
      expect(callCount).toBe(3)
    })

    test('retries transient operations with exponential backoff', async () => {
      const { createReleaseHttpClient } = require(helperModule.path)
      const client = createReleaseHttpClient({
        env: {},
        userAgent: 'release-test-agent',
        requestTimeout: 2500,
      })
      const delays: number[] = []
      const retryAttempts: number[] = []
      let attempts = 0

      const result = await client.withRetries(
        async () => {
          attempts += 1
          if (attempts < 3) throw new Error('temporary failure')
          return 'ok'
        },
        {
          maxAttempts: 3,
          baseDelayMs: 10,
          onRetry: ({ attempt }: { attempt: number }) => {
            retryAttempts.push(attempt)
          },
          sleep: async (delayMs: number) => {
            delays.push(delayMs)
          },
        },
      )

      expect(result).toBe('ok')
      expect(attempts).toBe(3)
      expect(retryAttempts).toEqual([1, 2])
      expect(delays).toEqual([10, 20])
    })

    test('does not retry permanent failures', async () => {
      const { createReleaseHttpClient } = require(helperModule.path)
      const client = createReleaseHttpClient({
        env: {},
        userAgent: 'release-test-agent',
        requestTimeout: 2500,
      })
      const error = Object.assign(new Error('not found'), { retryable: false })
      let attempts = 0

      await expect(
        client.withRetries(
          async () => {
            attempts += 1
            throw error
          },
          {
            maxAttempts: 3,
            shouldRetry: (caught: Error & { retryable?: boolean }) =>
              caught.retryable !== false,
            sleep: async () => {},
          },
        ),
      ).rejects.toBe(error)
      expect(attempts).toBe(1)
    })

    test('resumes an interrupted file download from the saved byte', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'release-resume-'))
      const destinationPath = join(tempDir, 'asset.part')
      const httpsGetCalls: Array<Record<string, any>> = []

      try {
        const { createReleaseHttpClient } = require(helperModule.path)
        let callCount = 0
        let pipelineCallCount = 0
        const client = createReleaseHttpClient({
          env: {},
          userAgent: 'release-test-agent',
          requestTimeout: 2500,
          async pipelineFn(source: Readable, destination: Writable) {
            pipelineCallCount += 1
            if (pipelineCallCount === 1) {
              for await (const chunk of source) {
                destination.write(chunk)
              }
              await new Promise<void>((resolve, reject) => {
                destination.end(resolve)
                destination.once('error', reject)
              })
              throw Object.assign(new Error('read ECONNRESET'), {
                code: 'ECONNRESET',
              })
            }
            return nodePipeline(source, destination)
          },
          httpsModule: {
            get(
              options: Record<string, any>,
              callback: (response: Readable) => void,
            ) {
              httpsGetCalls.push(options)
              callCount += 1
              queueMicrotask(() => {
                if (callCount === 1) {
                  callback(
                    createResponse(200, { 'content-length': '10' }, 'hello'),
                  )
                  return
                }
                callback(
                  createResponse(
                    206,
                    { 'content-range': 'bytes 5-9/10' },
                    'world',
                  ),
                )
              })
              return {
                on() {
                  return this
                },
                setTimeout() {
                  return this
                },
                destroy() {},
              }
            },
          },
        })

        await expect(
          client.downloadFile('https://example.com/asset', destinationPath),
        ).rejects.toMatchObject({
          code: 'ECONNRESET',
          downloadedBytes: 5,
          totalBytes: 10,
        })
        expect(readFileSync(destinationPath, 'utf8')).toBe('hello')

        const result = await client.downloadFile(
          'https://example.com/asset',
          destinationPath,
        )

        expect(httpsGetCalls[1]?.headers?.Range).toBe('bytes=5-')
        expect(result).toMatchObject({
          downloadedBytes: 10,
          resumedFrom: 5,
          totalBytes: 10,
        })
        expect(readFileSync(destinationPath, 'utf8')).toBe('helloworld')
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    test('restarts safely when a server ignores the Range header', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'release-restart-'))
      const destinationPath = join(tempDir, 'asset.part')
      writeFileSync(destinationPath, 'stale')

      try {
        const { createReleaseHttpClient } = require(helperModule.path)
        let requestHeaders: Record<string, string> = {}
        const client = createReleaseHttpClient({
          env: {},
          userAgent: 'release-test-agent',
          requestTimeout: 2500,
          httpsModule: {
            get(
              options: Record<string, any>,
              callback: (response: Readable) => void,
            ) {
              requestHeaders = options.headers
              queueMicrotask(() => {
                callback(
                  createResponse(200, { 'content-length': '5' }, 'fresh'),
                )
              })
              return {
                on() {
                  return this
                },
                setTimeout() {
                  return this
                },
                destroy() {},
              }
            },
          },
        })

        const result = await client.downloadFile(
          'https://example.com/asset',
          destinationPath,
        )

        expect(requestHeaders.Range).toBe('bytes=5-')
        expect(result).toMatchObject({
          downloadedBytes: 5,
          resumedFrom: 0,
          totalBytes: 5,
        })
        expect(readFileSync(destinationPath, 'utf8')).toBe('fresh')
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    test('discards a stale partial file rejected by the server', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'release-stale-'))
      const destinationPath = join(tempDir, 'asset.part')
      writeFileSync(destinationPath, 'too-long')

      try {
        const { createReleaseHttpClient } = require(helperModule.path)
        const client = createReleaseHttpClient({
          env: {},
          userAgent: 'release-test-agent',
          requestTimeout: 2500,
          httpsModule: {
            get(
              _options: Record<string, any>,
              callback: (response: Readable) => void,
            ) {
              queueMicrotask(() => {
                callback(createResponse(416, { 'content-range': 'bytes */5' }))
              })
              return {
                on() {
                  return this
                },
                setTimeout() {
                  return this
                },
                destroy() {},
              }
            },
          },
        })

        await expect(
          client.downloadFile('https://example.com/asset', destinationPath),
        ).rejects.toMatchObject({ statusCode: 416, retryable: true })
        expect(existsSync(destinationPath)).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    test('rejects a response body that overruns its Content-Range', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'release-overrun-'))
      const destinationPath = join(tempDir, 'asset.part')
      writeFileSync(destinationPath, 'hello')

      try {
        const { createReleaseHttpClient } = require(helperModule.path)
        const client = createReleaseHttpClient({
          env: {},
          userAgent: 'release-test-agent',
          requestTimeout: 2500,
          httpsModule: {
            get(
              _options: Record<string, any>,
              callback: (response: Readable) => void,
            ) {
              queueMicrotask(() => {
                callback(
                  createResponse(
                    206,
                    { 'content-range': 'bytes 5-8/10' },
                    'world',
                  ),
                )
              })
              return {
                on() {
                  return this
                },
                setTimeout() {
                  return this
                },
                destroy() {},
              }
            },
          },
        })

        await expect(
          client.downloadFile('https://example.com/asset', destinationPath),
        ).rejects.toMatchObject({
          code: 'EINCOMPLETE',
          downloadedBytes: 0,
          totalBytes: 10,
        })
        expect(existsSync(destinationPath)).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })
  })
}
