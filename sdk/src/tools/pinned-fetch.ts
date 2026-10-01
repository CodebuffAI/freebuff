import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { pipeline, Readable } from 'node:stream'
import zlib from 'node:zlib'

import { resolveAllowedAddresses, unwrapHost } from './ssrf'

import type { AddressPolicy, HostLookup } from './ssrf'
import type { LookupAddress, LookupOptions } from 'node:dns'
import type { IncomingMessage } from 'node:http'

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void

/**
 * A `lookup` for `net.connect` that resolves through `lookupHost`, refuses the
 * host if ANY answer is blocked, and hands the connection only the addresses
 * it just validated.
 *
 * This is what closes DNS rebinding: the address that is checked is the
 * address that is connected to, in one resolution, instead of a check that
 * resolves the name and a fetch that resolves it again on its own.
 */
export function validatingLookup(opts: {
  lookupHost?: HostLookup
  isBlocked?: AddressPolicy
}) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ): void => {
    resolveAllowedAddresses(hostname, opts).then(
      (addresses) => {
        const wanted =
          options?.family === 4 || options?.family === 6 ? options.family : 0
        const entries = addresses
          .map((address) => ({ address, family: net.isIP(address) }))
          .filter((entry) => entry.family !== 0)
          .filter((entry) => wanted === 0 || entry.family === wanted)
        if (entries.length === 0) {
          const error: NodeJS.ErrnoException = new Error(
            `Could not resolve host "${hostname}"`,
          )
          error.code = 'ENOTFOUND'
          callback(error, '', 0)
          return
        }
        if (options?.all) callback(null, entries)
        else callback(null, entries[0]!.address, entries[0]!.family)
      },
      (error: unknown) =>
        callback(
          error instanceof Error ? error : new Error(String(error)),
          '',
          0,
        ),
    )
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/** The body, decompressed the way `fetch` would. */
function decodedBody(response: IncomingMessage): Readable {
  const encoding = String(response.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase()
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? zlib.createGunzip()
      : encoding === 'deflate'
        ? zlib.createInflate()
        : encoding === 'br'
          ? zlib.createBrotliDecompress()
          : null
  if (!decoder) return response
  return pipeline(response, decoder, () => {}) as unknown as Readable
}

function toResponse(response: IncomingMessage): Response {
  const status = response.statusCode ?? 0
  if (status < 200 || status > 599) {
    response.destroy()
    throw new Error(`Unexpected HTTP status ${status}`)
  }
  const headers = new Headers()
  const decoding = /^(x-gzip|gzip|deflate|br)$/i.test(
    String(response.headers['content-encoding'] ?? '').trim(),
  )
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue
    // The body handed on is decoded, so its encoding and length no longer apply.
    if (decoding && (name === 'content-encoding' || name === 'content-length'))
      continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else {
      headers.set(name, value)
    }
  }
  if (NULL_BODY_STATUSES.has(status)) {
    response.resume()
    return new Response(null, {
      status,
      statusText: response.statusMessage,
      headers,
    })
  }
  const body = Readable.toWeb(decodedBody(response)) as unknown as BodyInit
  return new Response(body, {
    status,
    statusText: response.statusMessage,
    headers,
  })
}

/**
 * A GET whose connection is pinned to addresses validated against `isBlocked`
 * (by default every private, reserved, link-local, loopback, CGNAT and
 * unique-local range, IPv4 and IPv6, IPv4-mapped included).
 *
 * Same contract as `fetch(url, { redirect: 'manual' })`: a redirect comes back
 * as the 3xx response, and the caller validates the next hop before calling
 * again. Uses `node:http`/`node:https` rather than `fetch` because a
 * `lookup` hook is the one place every runtime we ship on lets the caller
 * choose the address a socket connects to; TLS still verifies the hostname.
 */
export function pinnedFetch(
  url: string | URL,
  init: {
    headers?: Record<string, string>
    signal?: AbortSignal
    lookupHost?: HostLookup
    isBlocked?: AddressPolicy
  } = {},
): Promise<Response> {
  const target = typeof url === 'string' ? new URL(url) : url
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return Promise.reject(
      new Error('Only http:// and https:// URLs are supported'),
    )
  }
  const signal = init.signal
  if (signal?.aborted) return Promise.reject(abortError())

  const transport = target.protocol === 'https:' ? https : http
  return new Promise<Response>((resolve, reject) => {
    const request = transport.request({
      protocol: target.protocol,
      hostname: unwrapHost(target.hostname),
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        ...init.headers,
        'accept-encoding': 'gzip, deflate, br',
      },
      // No shared agent: a pooled socket could outlive the address it was
      // validated for.
      agent: false,
      lookup: validatingLookup({
        lookupHost: init.lookupHost,
        isBlocked: init.isBlocked,
      }),
    })

    let response: IncomingMessage | undefined
    const onAbort = () => {
      const error = abortError()
      request.destroy(error)
      response?.destroy(error)
      reject(error)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = () => signal?.removeEventListener('abort', onAbort)

    request.on('error', (error) => {
      done()
      reject(error)
    })
    request.on('response', (incoming) => {
      response = incoming
      incoming.on('close', done)
      try {
        resolve(toResponse(incoming))
      } catch (error) {
        done()
        reject(error)
      }
    })
    request.end()
  })
}
