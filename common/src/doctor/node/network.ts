import { connect as netConnect } from 'node:net'
import { connect as tlsConnect, type PeerCertificate, type TLSSocket } from 'node:tls'
import { lookup } from 'node:dns/promises'
import { finding, type DoctorFinding } from '../types'

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

// ------------------------------------------------------------------ clock

/** Past this, Desktop skips turn-start probes whose 25 s deadline already "passed" (PR #9473). */
const CLOCK_SKEW_WARN_MS = 20_000
/** Past this, commands (5 min deadline), sign-in and certificate checks break too. */
const CLOCK_SKEW_ERROR_MS = 5 * 60_000

export type ClockReading = { skewMs: number; rttMs: number } | { error: string }

/**
 * Compares this computer's clock with the server's `Date` header. The header has one-second
 * precision, so the server time is taken as the middle of that second and the local time as the
 * middle of the round trip; the error is under a second plus half the round trip.
 */
export async function readClockSkew(url: string, options: { fetch?: Fetch; now?: () => number; timeoutMs?: number } = {}): Promise<ClockReading> {
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const started = now()
  try {
    const response = await fetcher(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 6_000) })
    const ended = now()
    await response.body?.cancel().catch(() => {})
    const header = response.headers.get('date')
    const server = header ? Date.parse(header) : NaN
    if (!Number.isFinite(server)) return { error: 'no-date' }
    return { skewMs: Math.round((started + ended) / 2 - (server + 500)), rttMs: ended - started }
  } catch (error) {
    return { error: classifyNetworkError(error) }
  }
}

function clockSyncSteps(platform: string): string[] {
  if (platform === 'win32')
    return ['Open Settings > Time & language > Date & time.', 'Turn on "Set time automatically", then click "Sync now".', 'Restart Freebuff.']
  if (platform === 'darwin')
    return ['Open System Settings > General > Date & Time.', 'Turn on "Set time and date automatically".', 'Restart Freebuff.']
  return ['Turn on automatic time sync: `timedatectl set-ntp true` on most distributions.', 'Restart Freebuff.']
}

export function clockFinding(reading: ClockReading, platform: string, product: 'desktop' | 'cli'): DoctorFinding {
  if ('error' in reading)
    return finding('clock.unknown', 'info', 'clock', 'Could not compare your clock with Freebuff',
      'The server did not answer, so the clock check was skipped. See the network findings.', [])
  const seconds = Math.round(Math.abs(reading.skewMs) / 1000)
  const direction = reading.skewMs > 0 ? 'ahead' : 'behind'
  const amount = seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`
  if (Math.abs(reading.skewMs) <= CLOCK_SKEW_WARN_MS)
    return finding('clock.ok', 'ok', 'clock', 'Your clock is in sync', `Within ${seconds} s of Freebuff's servers.`)
  const effect = product === 'desktop'
    ? 'Freebuff gives each piece of work it sends to this computer a deadline. With a clock this far off, Desktop treats that work as already expired and silently skips it, so turns can start without your files or terminal.'
    : 'Sign-in tokens and secure connections carry time limits, and a clock this far off can make them fail.'
  return finding('clock.skew', Math.abs(reading.skewMs) > CLOCK_SKEW_ERROR_MS ? 'error' : 'warning', 'clock',
    `Your computer's clock is ${amount} ${direction}`,
    `${effect} Set your clock to sync automatically.`, clockSyncSteps(platform))
}

// ---------------------------------------------------------------- reachability

export type NetworkErrorKind = 'dns' | 'refused' | 'timeout' | 'reset' | 'tls' | 'offline' | 'other'

const TLS_ERROR = /CERT|certificate|SSL|TLS|self[- ]signed|UNABLE_TO_(?:GET|VERIFY)/i

export function classifyNetworkError(error: unknown): NetworkErrorKind {
  const e = error as { code?: unknown; name?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | undefined
  const text = [e?.code, e?.name, e?.message, e?.cause?.code, e?.cause?.message].filter(v => typeof v === 'string').join(' ')
  if (TLS_ERROR.test(text)) return 'tls'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS|resolve host/i.test(text)) return 'dns'
  if (/ECONNREFUSED|ConnectionRefused/i.test(text)) return 'refused'
  if (/ETIMEDOUT|Timeout|timed out|AbortError/i.test(text)) return 'timeout'
  if (/ECONNRESET|socket hang up|ConnectionClosed|EPIPE/i.test(text)) return 'reset'
  if (/ENETUNREACH|EHOSTUNREACH|FailedToOpenSocket|network is unreachable/i.test(text)) return 'offline'
  return 'other'
}

export type Endpoint = { id: string; label: string; url: string }
export type EndpointResult = { endpoint: Endpoint; ms: number } & ({ ok: true; status: number } | { ok: false; error: NetworkErrorKind })

export async function probeEndpoint(endpoint: Endpoint, options: { fetch?: Fetch; timeoutMs?: number; now?: () => number } = {}): Promise<EndpointResult> {
  const now = options.now ?? Date.now
  const started = now()
  try {
    const response = await (options.fetch ?? fetch)(endpoint.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 6_000) })
    await response.body?.cancel().catch(() => {})
    // Any HTTP answer, even a 404, means the network path works.
    return { endpoint, ms: now() - started, ok: true, status: response.status }
  } catch (error) {
    return { endpoint, ms: now() - started, ok: false, error: classifyNetworkError(error) }
  }
}

const NETWORK_STEPS: Record<NetworkErrorKind, { why: string; steps: string[] }> = {
  dns: { why: 'its name could not be looked up (DNS)', steps: ['Check that you are online.', 'If you use a DNS filter, ad blocker or Pi-hole, allow freebuff.com and codebuff.com.', 'Check the hosts file finding in this report.'] },
  refused: { why: 'the connection was refused', steps: ['A firewall, VPN or proxy is blocking it. Allow freebuff.com and codebuff.com.'] },
  timeout: { why: 'it did not answer in time', steps: ['Check your connection.', 'If you use a VPN or proxy, try without it.'] },
  reset: { why: 'the connection was cut off', steps: ['A firewall, VPN or antivirus web shield may be interrupting it. Allow freebuff.com and codebuff.com.'] },
  tls: { why: 'its security certificate was rejected', steps: ['Turn off HTTPS or SSL scanning in your antivirus, or exclude freebuff.com and codebuff.com.', 'On a work network, ask IT to exempt freebuff.com and codebuff.com from TLS inspection.', 'Check that your clock is correct.'] },
  offline: { why: 'there is no route to it', steps: ['Check that you are online.'] },
  other: { why: 'the request failed', steps: ['Check your connection, VPN and firewall.'] },
}

export function endpointFindings(results: EndpointResult[]): DoctorFinding[] {
  const failed = results.filter((r): r is Extract<EndpointResult, { ok: false }> => !r.ok)
  if (!failed.length)
    return [finding('network.reachable', 'ok', 'network', 'Freebuff is reachable',
      `Reached ${results.map(r => r.endpoint.label).join(', ')}.`)]
  return failed.map(result => {
    const { why, steps } = NETWORK_STEPS[result.error]
    return finding(`network.unreachable.${result.endpoint.id}`, result.endpoint.id === 'api' ? 'error' : 'warning', 'network',
      result.error === 'tls' ? `Can't reach ${result.endpoint.label}: HTTPS is being intercepted` : `Can't reach ${result.endpoint.label}`,
      `Freebuff could not reach ${result.endpoint.label} because ${why}.` +
      (result.error === 'tls' ? ' This is what HTTPS scanning by antivirus or a corporate proxy looks like from inside the app.' : ''), steps)
  })
}

// ---------------------------------------------------------------- TLS

// Issuers that only appear when something on this computer or network re-signs HTTPS traffic.
const INTERCEPTORS = /Avast|AVG|Kaspersky|ESET|Bitdefender|Norton|Symantec|McAfee|Sophos|Trend ?Micro|Webroot|F-Secure|Malwarebytes|Zscaler|Netskope|Fortinet|FortiGate|Palo Alto|Cisco Umbrella|Blue ?Coat|Forcepoint|Barracuda|Check ?Point|Cloudflare Gateway|mitmproxy|Charles Proxy|Fiddler|DO_NOT_TRUST|Proxy/i

export type TlsInspection =
  | { authorized: boolean; authorizationError: string | null; issuers: string[] }
  | { error: NetworkErrorKind }

export function inspectTls(host: string, options: { connect?: typeof tlsConnect; timeoutMs?: number } = {}): Promise<TlsInspection> {
  return new Promise(resolve => {
    let socket: TLSSocket | undefined
    const timer = setTimeout(() => { socket?.destroy(); resolve({ error: 'timeout' }) }, options.timeoutMs ?? 6_000)
    try {
      // rejectUnauthorized: false so a rejected chain can still be described; nothing is sent.
      const opened: TLSSocket = (options.connect ?? tlsConnect)({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
        clearTimeout(timer)
        const issuers: string[] = []
        try {
          let cert: PeerCertificate | undefined = opened.getPeerCertificate(true)
          const seen = new Set<string>()
          while (cert && Object.keys(cert).length && issuers.length < 6) {
            const name = [cert.issuer?.O, cert.issuer?.CN].flat().filter(Boolean).join(' / ')
            if (name) issuers.push(name)
            const next: PeerCertificate | undefined = (cert as PeerCertificate & { issuerCertificate?: PeerCertificate }).issuerCertificate
            if (!next || seen.has(cert.fingerprint256) || next.fingerprint256 === cert.fingerprint256) break
            seen.add(cert.fingerprint256)
            cert = next
          }
        } catch { /* a runtime without chain access still reports authorization */ }
        const authorizationError = opened.authorizationError ? String(opened.authorizationError) : null
        resolve({ authorized: opened.authorized, authorizationError, issuers })
        opened.end()
      })
      socket = opened
      opened.on('error', error => { clearTimeout(timer); resolve({ error: classifyNetworkError(error) }) })
    } catch (error) {
      clearTimeout(timer)
      resolve({ error: classifyNetworkError(error) })
    }
  })
}

export function tlsFinding(host: string, inspection: TlsInspection): DoctorFinding {
  if ('error' in inspection)
    return finding('tls.unknown', 'info', 'network', `Could not inspect the secure connection to ${host}`,
      'The connection failed before its certificate could be read. See the network findings.', [])
  const interceptor = inspection.issuers.find(name => INTERCEPTORS.test(name))
  if (!inspection.authorized || interceptor) {
    const by = interceptor ? ` The certificate was issued by "${interceptor}", not by a public authority.` : ''
    return finding('tls.intercepted', inspection.authorized ? 'warning' : 'error', 'network',
      'HTTPS to Freebuff is being intercepted',
      `Something between this computer and ${host} replaces Freebuff's certificate.${by} Antivirus HTTPS scanning and corporate proxies do this, and it makes Freebuff fail with "Can't reach Freebuff".`,
      NETWORK_STEPS.tls.steps)
  }
  return finding('tls.ok', 'ok', 'network', 'Secure connections are not intercepted', `${host} presented a certificate from a public authority.`)
}

// ---------------------------------------------------------------- DNS and hosts

const FREEBUFF_DOMAINS = ['freebuff.com', 'codebuff.com']

const LOCAL_ADDRESS = /^(?:0\.0\.0\.0|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|::1?$|::ffff:127\.|f[cd][0-9a-f]{2}:|fe80:)/i

function isLocalAddress(address: string) {
  return LOCAL_ADDRESS.test(address)
}

export async function dnsFindings(hosts: string[], resolve: (host: string) => Promise<string[]> = async host =>
  (await lookup(host, { all: true })).map(entry => entry.address)): Promise<DoctorFinding[]> {
  const results = await Promise.all(hosts.map(async host => {
    try { return { host, addresses: await resolve(host) } } catch (error) { return { host, error: classifyNetworkError(error) } }
  }))
  const out: DoctorFinding[] = []
  for (const result of results) {
    if ('error' in result) continue // reported by reachability, which says why
    if (result.addresses.some(isLocalAddress))
      out.push(finding(`dns.blocked.${result.host}`, 'error', 'network', `${result.host} points at this computer or your local network`,
        `Your system resolves ${result.host} to a local address, so Freebuff's requests never leave your network. A hosts file entry, ad blocker, Pi-hole or DNS filter does this.`,
        ['Remove the entry from your hosts file, or allow the domain in your DNS filter.', 'Restart Freebuff.']))
  }
  return out
}

export function hostsFilePath(platform: string, env: Record<string, string | undefined>) {
  return platform === 'win32' ? `${env.SystemRoot ?? env.windir ?? 'C:\\Windows'}\\System32\\drivers\\etc\\hosts` : '/etc/hosts'
}

/** Hosts-file lines that name one of our domains (or a subdomain), comments ignored. */
export function hostsFileEntries(text: string, domains = FREEBUFF_DOMAINS): Array<{ address: string; host: string }> {
  const entries: Array<{ address: string; host: string }> = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const [address, ...names] = line.split(/\s+/)
    for (const name of names) {
      const host = name.toLowerCase()
      if (domains.some(domain => host === domain || host.endsWith(`.${domain}`))) entries.push({ address: address!, host })
    }
  }
  return entries
}

export function hostsFinding(entries: Array<{ address: string; host: string }>): DoctorFinding {
  if (!entries.length) return finding('hosts.ok', 'ok', 'network', 'Your hosts file does not redirect Freebuff', 'No entries for Freebuff domains.')
  return finding('hosts.pinned', 'error', 'network', 'Your hosts file redirects Freebuff',
    `It has ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} for ${[...new Set(entries.map(e => e.host))].join(', ')}. Freebuff's addresses change, so a pinned or blocked entry breaks it.`,
    ['Open the hosts file as an administrator and delete those lines.', 'Restart Freebuff.'])
}

// ---------------------------------------------------------------- proxy and environment

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

export function configuredProxies(env: Record<string, string | undefined>) {
  const seen = new Map<string, { variable: string; host: string; port: number }>()
  for (const variable of PROXY_VARS) {
    const value = env[variable]
    if (!value) continue
    try {
      const url = new URL(value.includes('://') ? value : `http://${value}`)
      const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
      // Only host and port: a proxy URL can carry a user name and password.
      const key = `${url.hostname}:${port}`
      if (!seen.has(key)) seen.set(key, { variable, host: url.hostname, port })
    } catch {
      seen.set(`invalid:${variable}`, { variable, host: '', port: 0 })
    }
  }
  return [...seen.values()]
}

function tcpReachable(host: string, port: number, timeoutMs = 3_000, connect = netConnect): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const done = (ok: boolean) => { clearTimeout(timer); socket.destroy(); resolve(ok) }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

export async function proxyFindings(env: Record<string, string | undefined>, reachable: typeof tcpReachable = tcpReachable): Promise<DoctorFinding[]> {
  const proxies = configuredProxies(env)
  const out: DoctorFinding[] = []
  for (const proxy of proxies) {
    if (!proxy.host) {
      out.push(finding(`proxy.invalid.${proxy.variable.toLowerCase()}`, 'warning', 'network', `${proxy.variable} is not a valid proxy address`,
        'Freebuff sends its requests through this setting, and it cannot be read.', [`Fix or remove the ${proxy.variable} environment variable.`]))
      continue
    }
    if (!(await reachable(proxy.host, proxy.port)))
      out.push(finding(`proxy.down.${proxy.variable.toLowerCase()}`, 'error', 'network', `The proxy in ${proxy.variable} does not answer`,
        `${proxy.variable} sends Freebuff's requests through ${proxy.host}:${proxy.port}, which refused or ignored a connection.`,
        ['Start the proxy, or remove the variable if you no longer use it.', 'Restart Freebuff (and your terminal) after changing it.']))
  }
  if (proxies.length && !out.length)
    out.push(finding('proxy.ok', 'info', 'network', 'A proxy is configured', `Requests go through ${proxies.map(p => `${p.host}:${p.port}`).join(', ')}, which answers. If it inspects HTTPS, see the secure-connection finding.`))
  return out
}

export function environmentFindings(env: Record<string, string | undefined>): DoctorFinding[] {
  const out: DoctorFinding[] = []
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    out.push(finding('env.tls-verification-off', 'warning', 'environment', 'Certificate checking is turned off',
      'NODE_TLS_REJECT_UNAUTHORIZED=0 makes JavaScript tools accept any certificate, including an attacker\'s. It is usually left over from working around a proxy.',
      ['Remove NODE_TLS_REJECT_UNAUTHORIZED from your environment.', 'If a corporate proxy needs it, point NODE_EXTRA_CA_CERTS at the proxy\'s root certificate instead.']))
  if (env.NODE_EXTRA_CA_CERTS || env.SSL_CERT_FILE)
    out.push(finding('env.extra-ca', 'info', 'environment', 'Extra trusted certificates are configured',
      'NODE_EXTRA_CA_CERTS or SSL_CERT_FILE adds certificates JavaScript tools trust. This is normal behind a corporate proxy.', []))
  if (env.NODE_OPTIONS && /--(?:require|import|loader|experimental-loader)\b|-r\s/.test(env.NODE_OPTIONS))
    out.push(finding('env.node-options-preload', 'warning', 'environment', 'NODE_OPTIONS loads extra code into every Node process',
      'A preload in NODE_OPTIONS runs inside Freebuff\'s tools too and can break them.', ['Remove the preload from NODE_OPTIONS, or unset it before starting Freebuff.']))
  return out
}
