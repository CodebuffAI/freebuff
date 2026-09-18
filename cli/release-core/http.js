const http = require('http')
const https = require('https')
const fs = require('fs')
const { pipeline } = require('stream/promises')
const tls = require('tls')

/**
 * Hosts a release request may be redirected to, beyond the host it started
 * on. The download route on codebuff.com answers with a 302 to a GitHub
 * release asset, which GitHub in turn serves from *.githubusercontent.com.
 * Anything outside this list is refused: a redirect is the one place where a
 * compromised or misconfigured origin could otherwise hand the download to an
 * arbitrary host.
 */
const REDIRECT_ALLOWED_HOSTS = new Set([
  'codebuff.com',
  'www.codebuff.com',
  'freebuff.com',
  'www.freebuff.com',
  'github.com',
])
const REDIRECT_ALLOWED_HOST_SUFFIXES = ['.githubusercontent.com']

function isRedirectHostAllowed(hostname, originalHostname) {
  const host = hostname.toLowerCase()
  if (host === originalHostname.toLowerCase()) return true
  if (REDIRECT_ALLOWED_HOSTS.has(host)) return true
  return REDIRECT_ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/**
 * Decide whether a redirect may be followed. Pure, so it can be tested
 * without a transport.
 *
 * @param {string} currentUrl the URL that answered with the redirect
 * @param {string} location its Location header (absolute or relative)
 * @param {{ originalUrl?: string }} [options] the first URL of the chain;
 *   its host is always an acceptable destination
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
function evaluateRedirect(currentUrl, location, options = {}) {
  const from = new URL(currentUrl)
  let target
  try {
    target = new URL(location, currentUrl)
  } catch {
    return { ok: false, reason: `Redirect to an invalid URL: ${location}` }
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    return {
      ok: false,
      reason: `Redirect to unsupported protocol: ${target.protocol}`,
    }
  }
  if (from.protocol === 'https:' && target.protocol === 'http:') {
    return {
      ok: false,
      reason: `Refusing redirect from https to insecure http host ${target.hostname}`,
    }
  }

  const originalHostname = new URL(options.originalUrl || currentUrl).hostname
  if (!isRedirectHostAllowed(target.hostname, originalHostname)) {
    return {
      ok: false,
      reason: `Refusing redirect to unexpected host ${target.hostname}`,
    }
  }

  return { ok: true, url: target.href }
}

function createReleaseHttpClient({
  env = process.env,
  userAgent,
  requestTimeout,
  httpModule = http,
  httpsModule = https,
  fsModule = fs,
  pipelineFn = pipeline,
  tlsModule = tls,
}) {
  function getProxyUrl(protocol = 'https:') {
    if (protocol === 'http:') {
      return (
        env.HTTP_PROXY ||
        env.http_proxy ||
        env.HTTPS_PROXY ||
        env.https_proxy ||
        null
      )
    }
    return (
      env.HTTPS_PROXY ||
      env.https_proxy ||
      env.HTTP_PROXY ||
      env.http_proxy ||
      null
    )
  }

  function shouldBypassProxy(hostname) {
    const noProxy = env.NO_PROXY || env.no_proxy || ''
    if (!noProxy) return false

    const domains = noProxy
      .split(',')
      .map((domain) => domain.trim().toLowerCase().replace(/:\d+$/, ''))
    const host = hostname.toLowerCase()

    return domains.some((domain) => {
      if (domain === '*') return true
      if (domain.startsWith('.')) {
        return host.endsWith(domain) || host === domain.slice(1)
      }
      return host === domain || host.endsWith(`.${domain}`)
    })
  }

  function connectThroughProxy(proxyUrl, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
      const proxy = new URL(proxyUrl)
      const isHttpsProxy = proxy.protocol === 'https:'
      const connectOptions = {
        hostname: proxy.hostname,
        port: proxy.port || (isHttpsProxy ? 443 : 80),
        method: 'CONNECT',
        path: `${targetHost}:${targetPort}`,
        headers: {
          Host: `${targetHost}:${targetPort}`,
        },
      }

      if (proxy.username || proxy.password) {
        const auth = Buffer.from(
          `${decodeURIComponent(proxy.username || '')}:${decodeURIComponent(
            proxy.password || '',
          )}`,
        ).toString('base64')
        connectOptions.headers['Proxy-Authorization'] = `Basic ${auth}`
      }

      const transport = isHttpsProxy ? httpsModule : httpModule
      const req = transport.request(connectOptions)

      req.on('connect', (res, socket) => {
        if (res.statusCode === 200) {
          resolve(socket)
          return
        }

        socket.destroy()
        reject(new Error(`Proxy CONNECT failed with status ${res.statusCode}`))
      })

      req.on('error', (error) => {
        reject(new Error(`Proxy connection failed: ${error.message}`))
      })

      req.setTimeout(requestTimeout, () => {
        req.destroy()
        reject(new Error('Proxy connection timeout.'))
      })

      req.end()
    })
  }

  async function buildRequest(url, options = {}) {
    const parsedUrl = new URL(url)
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`)
    }
    const isHttps = parsedUrl.protocol === 'https:'
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': userAgent,
        ...options.headers,
      },
    }

    const proxyUrl = getProxyUrl(parsedUrl.protocol)
    if (!proxyUrl || shouldBypassProxy(parsedUrl.hostname)) {
      return { transport: isHttps ? httpsModule : httpModule, reqOptions }
    }

    const proxy = new URL(proxyUrl)
    if (!['http:', 'https:'].includes(proxy.protocol)) {
      throw new Error(`Unsupported proxy protocol: ${proxy.protocol}`)
    }

    if (!isHttps) {
      reqOptions.hostname = proxy.hostname
      reqOptions.port = proxy.port || (proxy.protocol === 'https:' ? 443 : 80)
      reqOptions.path = parsedUrl.href
      reqOptions.headers.Host = parsedUrl.host
      if (proxy.username || proxy.password) {
        const auth = Buffer.from(
          `${decodeURIComponent(proxy.username || '')}:${decodeURIComponent(proxy.password || '')}`,
        ).toString('base64')
        reqOptions.headers['Proxy-Authorization'] = `Basic ${auth}`
      }
      return {
        transport: proxy.protocol === 'https:' ? httpsModule : httpModule,
        reqOptions,
      }
    }

    const tunnelSocket = await connectThroughProxy(
      proxyUrl,
      parsedUrl.hostname,
      parsedUrl.port || 443,
    )

    class TunnelAgent extends httpsModule.Agent {
      createConnection(_options, callback) {
        const secureSocket = tlsModule.connect({
          socket: tunnelSocket,
          servername: parsedUrl.hostname,
        })

        if (typeof callback === 'function') {
          if (typeof secureSocket.once === 'function') {
            let settled = false
            const finish = (error) => {
              if (settled) return
              settled = true
              callback(error || null, error ? undefined : secureSocket)
            }

            secureSocket.once('secureConnect', () => finish(null))
            secureSocket.once('error', (error) => finish(error))
          } else {
            callback(null, secureSocket)
          }
        }

        return secureSocket
      }
    }

    reqOptions.agent = new TunnelAgent({ keepAlive: false })
    return { transport: httpsModule, reqOptions }
  }

  async function httpGet(url, options = {}) {
    const redirectCount = options.redirectCount || 0
    const { transport, reqOptions } = await buildRequest(url, options)

    return new Promise((resolve, reject) => {
      const req = transport.get(reqOptions, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume()

          if (!res.headers.location) {
            reject(
              new Error(`Redirect ${res.statusCode} missing Location header.`),
            )
            return
          }
          if (redirectCount >= (options.maxRedirects ?? 10)) {
            reject(new Error('Too many redirects.'))
            return
          }

          const originalUrl = options.originalUrl || url
          const redirect = evaluateRedirect(url, res.headers.location, {
            originalUrl,
          })
          if (!redirect.ok) {
            const error = new Error(redirect.reason)
            error.code = 'EREDIRECT_REFUSED'
            error.retryable = false
            error.requestUrl = url
            reject(error)
            return
          }

          httpGet(redirect.url, {
            ...options,
            originalUrl,
            redirectCount: redirectCount + 1,
          })
            .then(resolve)
            .catch(reject)
          return
        }

        res.requestUrl = url
        resolve(res)
      })

      req.on('error', (error) => {
        error.requestUrl = url
        reject(error)
      })
      req.setTimeout(options.timeout || requestTimeout, () => {
        req.destroy()
        const error = new Error('Request timeout.')
        error.code = 'ETIMEDOUT'
        error.requestUrl = url
        reject(error)
      })
    })
  }

  function getFileSize(filePath) {
    try {
      return fsModule.statSync(filePath).size
    } catch (error) {
      if (error.code === 'ENOENT') return 0
      throw error
    }
  }

  function removeFileIfPresent(filePath) {
    try {
      fsModule.unlinkSync(filePath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  function throwResponseError(res, message, requestUrl, retryable) {
    res.resume()
    const error = new Error(message)
    error.statusCode = res.statusCode
    error.retryable = retryable
    error.requestUrl = requestUrl
    throw error
  }

  function parseContentRange(value) {
    if (!value) return null

    const completeMatch = value.match(/^bytes (\d+)-(\d+)\/(\d+)$/i)
    if (completeMatch) {
      const start = Number(completeMatch[1])
      const end = Number(completeMatch[2])
      const total = Number(completeMatch[3])
      if (start > end || end >= total) return null
      return {
        start,
        end,
        total,
      }
    }

    const unsatisfiedMatch = value.match(/^bytes \*\/(\d+)$/i)
    if (unsatisfiedMatch) {
      return { start: null, end: null, total: Number(unsatisfiedMatch[1]) }
    }

    return null
  }

  function isRetryableStatus(statusCode) {
    return (
      statusCode === 408 ||
      statusCode === 425 ||
      statusCode === 429 ||
      statusCode >= 500
    )
  }

  async function downloadFile(url, destinationPath, options = {}) {
    let resumedFrom = getFileSize(destinationPath)
    let totalBytes = null

    const headers = { ...options.headers }
    if (resumedFrom > 0) {
      headers.Range = `bytes=${resumedFrom}-`
    }

    const res = await httpGet(url, { ...options, headers })
    const responseUrl = res.requestUrl || url
    const contentRange = parseContentRange(res.headers['content-range'])

    if (res.statusCode === 416 && contentRange?.total === resumedFrom) {
      res.resume()
      return {
        downloadedBytes: resumedFrom,
        totalBytes: resumedFrom,
        resumedFrom,
        responseUrl,
      }
    }

    if (res.statusCode === 416) {
      removeFileIfPresent(destinationPath)
      throwResponseError(
        res,
        'Saved partial download is no longer valid',
        responseUrl,
        true,
      )
    }

    let writeFlags
    let expectedResponseBytes = null
    if (res.statusCode === 206) {
      if (!contentRange || contentRange.start !== resumedFrom) {
        removeFileIfPresent(destinationPath)
        throwResponseError(
          res,
          `Download resume mismatch: expected byte ${resumedFrom}`,
          responseUrl,
          true,
        )
      }
      totalBytes = contentRange.total
      expectedResponseBytes = contentRange.end - contentRange.start + 1
      writeFlags = 'a'
    } else if (res.statusCode === 200) {
      // The server may ignore Range. Restart safely instead of appending a
      // complete response to the existing partial archive.
      resumedFrom = 0
      totalBytes = Number(res.headers['content-length']) || null
      writeFlags = 'w'
    } else {
      throwResponseError(
        res,
        `Download failed: HTTP ${res.statusCode}`,
        responseUrl,
        isRetryableStatus(res.statusCode),
      )
    }

    let downloadedBytes = resumedFrom
    res.on('data', (chunk) => {
      downloadedBytes += chunk.length
      options.onProgress?.({ downloadedBytes, totalBytes, resumedFrom })
    })

    try {
      await pipelineFn(
        res,
        fsModule.createWriteStream(destinationPath, { flags: writeFlags }),
      )
    } catch (error) {
      error.requestUrl ||= responseUrl
      error.downloadedBytes = getFileSize(destinationPath)
      error.totalBytes = totalBytes
      throw error
    }

    downloadedBytes = getFileSize(destinationPath)
    const responseBytes = downloadedBytes - resumedFrom
    if (
      expectedResponseBytes !== null &&
      responseBytes !== expectedResponseBytes
    ) {
      if (responseBytes > expectedResponseBytes) {
        removeFileIfPresent(destinationPath)
      }
      const error = new Error(
        `Download incomplete: response contained ${responseBytes} of ${expectedResponseBytes} bytes`,
      )
      error.code = 'EINCOMPLETE'
      error.retryable = true
      error.requestUrl = responseUrl
      error.downloadedBytes = getFileSize(destinationPath)
      error.totalBytes = totalBytes
      throw error
    }
    if (totalBytes !== null && downloadedBytes !== totalBytes) {
      const error = new Error(
        `Download incomplete: received ${downloadedBytes} of ${totalBytes} bytes`,
      )
      error.code = 'EINCOMPLETE'
      error.retryable = true
      error.requestUrl = responseUrl
      error.downloadedBytes = downloadedBytes
      error.totalBytes = totalBytes
      throw error
    }

    return { downloadedBytes, totalBytes, resumedFrom, responseUrl }
  }

  async function withRetries(
    operation,
    {
      maxAttempts = 1,
      baseDelayMs = 1000,
      shouldRetry = () => true,
      onRetry = () => {},
      sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  ) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation(attempt)
      } catch (error) {
        if (attempt >= maxAttempts || !shouldRetry(error)) {
          throw error
        }

        const delayMs = baseDelayMs * 2 ** (attempt - 1)
        await onRetry({ error, attempt, nextAttempt: attempt + 1, delayMs })
        await sleep(delayMs)
      }
    }
  }

  return {
    getProxyUrl,
    downloadFile,
    httpGet,
    withRetries,
  }
}

module.exports = {
  createReleaseHttpClient,
  evaluateRedirect,
}
