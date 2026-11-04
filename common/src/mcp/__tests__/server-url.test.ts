import { describe, expect, test } from 'bun:test'

import { remoteMcpUrl } from '../client'
import { normalizeMcpServerUrl } from '../server-url'

describe('normalizeMcpServerUrl', () => {
  test.each([
    ['bare host', 'mcp.example.com', 'https://mcp.example.com'],
    ['host and path', 'example.com/mcp', 'https://example.com/mcp'],
    ['host and sse path', 'mcp.example.com/sse', 'https://mcp.example.com/sse'],
    ['host and port', 'mcp.example.com:8443/mcp', 'https://mcp.example.com:8443/mcp'],
    ['host and port only', 'mcp.example.com:8443', 'https://mcp.example.com:8443'],
    ['query kept', 'example.com/mcp?tenant=acme', 'https://example.com/mcp?tenant=acme'],
    ['protocol-relative', '//example.com/mcp', 'https://example.com/mcp'],
    ['localhost', 'localhost:3000/mcp', 'http://localhost:3000/mcp'],
    ['bare localhost', 'localhost', 'http://localhost'],
    ['IPv4 loopback', '127.0.0.1:8080/mcp', 'http://127.0.0.1:8080/mcp'],
    ['IPv6 loopback', '[::1]:8080/mcp', 'http://[::1]:8080/mcp'],
    ['non-loopback IP', '10.0.0.5:8080/mcp', 'https://10.0.0.5:8080/mcp'],
    ['surrounding whitespace', '  \texample.com/mcp \n', 'https://example.com/mcp'],
  ])('adds a scheme: %s', (_name, input, expected) => {
    expect(normalizeMcpServerUrl(input)).toBe(expected)
  })

  test.each([
    ['https', 'https://example.com/mcp'],
    ['uppercase https', 'HTTPS://example.com/mcp'],
    ['http on a public host', 'http://example.com/mcp'],
    ['http on localhost', 'http://localhost:3000/mcp'],
    ['https on localhost', 'https://localhost:3000/mcp'],
  ])('keeps a typed scheme: %s', (_name, input) => {
    expect(normalizeMcpServerUrl(` ${input} `)).toBe(input)
  })

  // Returned as given, so each surface's scheme check rejects them exactly as it did before.
  test.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'ftp://example.com/mcp',
    'data:text/html,hi',
    'ws://example.com/mcp',
  ])('never rewrites another scheme: %s', (input) => {
    expect(normalizeMcpServerUrl(input)).toBe(input)
  })

  test('leaves empty and unparseable input for the caller to reject', () => {
    expect(normalizeMcpServerUrl('   ')).toBe('')
    expect(normalizeMcpServerUrl('not a url')).toBe('not a url')
  })
})

// The CLI and SDK connect through `remoteMcpUrl`, reading `mcp.json` as the user wrote it.
describe('remoteMcpUrl', () => {
  const remote = (url: string, params: Record<string, string> = {}) =>
    remoteMcpUrl({ type: 'http', url, params, headers: {} })

  test('connects a bare host over https and keeps params', () => {
    expect(remote('mcp.example.com/sse', { key: 'v' }).href).toBe(
      'https://mcp.example.com/sse?key=v',
    )
    expect(remote('localhost:3000/mcp').href).toBe('http://localhost:3000/mcp')
    expect(remote('http://example.com/mcp').href).toBe('http://example.com/mcp')
  })

  test('refuses a scheme that is not http(s)', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/mcp'])
      expect(() => remote(url)).toThrow('must use https')
    expect(() => remote('not a url')).toThrow()
  })
})
