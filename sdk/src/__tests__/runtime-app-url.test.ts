import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { WEBSITE_URL, getWebsiteUrl } from '../constants'
import {
  getRuntimeAppUrlFromEnv,
  isAllowedRuntimeAppUrl,
  isCustomRuntimeAppUrlAllowed,
} from '../env'
import { isFirstPartyRuntimeAppUrl } from '@codebuff/common/util/runtime-app-url'

/** The bundle-time URL, as getWebsiteUrl() returns it when no override applies. */
const bundledUrl = WEBSITE_URL.replace(/\/$/, '')

describe('isAllowedRuntimeAppUrl', () => {
  test('https on any host is allowed', () => {
    expect(isAllowedRuntimeAppUrl('https://www.codebuff.com')).toBe(true)
    expect(isAllowedRuntimeAppUrl('https://staging.example.net:8443/')).toBe(
      true,
    )
    expect(isAllowedRuntimeAppUrl('https://1.2.3.4')).toBe(true)
  })

  test('http on a loopback host is allowed', () => {
    expect(isAllowedRuntimeAppUrl('http://localhost:3000')).toBe(true)
    expect(isAllowedRuntimeAppUrl('HTTP://LOCALHOST:3000/')).toBe(true)
    expect(isAllowedRuntimeAppUrl('http://127.0.0.1:3002')).toBe(true)
    expect(isAllowedRuntimeAppUrl('http://[::1]:3000')).toBe(true)
    expect(isAllowedRuntimeAppUrl('http://foo.localhost:3000')).toBe(true)
    expect(isAllowedRuntimeAppUrl('http://api.dev.localhost')).toBe(true)
  })

  test('http to any other host is rejected', () => {
    expect(isAllowedRuntimeAppUrl('http://evil.example')).toBe(false)
    expect(isAllowedRuntimeAppUrl('http://evil.example:3000/api')).toBe(false)
    expect(isAllowedRuntimeAppUrl('http://10.0.0.5:3000')).toBe(false)
    expect(isAllowedRuntimeAppUrl('http://localhost.evil.example')).toBe(false)
    expect(isAllowedRuntimeAppUrl('http://notlocalhost')).toBe(false)
    expect(isAllowedRuntimeAppUrl('http://host.docker.internal:3000')).toBe(
      false,
    )
  })

  test('other schemes and garbage are rejected', () => {
    expect(isAllowedRuntimeAppUrl('ftp://localhost')).toBe(false)
    expect(isAllowedRuntimeAppUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedRuntimeAppUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedRuntimeAppUrl('not a url')).toBe(false)
    expect(isAllowedRuntimeAppUrl('www.codebuff.com')).toBe(false)
    expect(isAllowedRuntimeAppUrl('')).toBe(false)
  })
})

describe('isFirstPartyRuntimeAppUrl', () => {
  test('first-party domains and their subdomains over https', () => {
    expect(isFirstPartyRuntimeAppUrl('https://codebuff.com')).toBe(true)
    expect(isFirstPartyRuntimeAppUrl('https://www.codebuff.com/')).toBe(true)
    expect(isFirstPartyRuntimeAppUrl('https://staging.codebuff.com')).toBe(true)
    expect(isFirstPartyRuntimeAppUrl('https://freebuff.com')).toBe(true)
    expect(isFirstPartyRuntimeAppUrl('https://WWW.FREEBUFF.COM')).toBe(true)
  })

  test('loopback over http or https', () => {
    expect(isFirstPartyRuntimeAppUrl('http://localhost:3000')).toBe(true)
    expect(isFirstPartyRuntimeAppUrl('https://127.0.0.1:3000')).toBe(true)
    expect(isFirstPartyRuntimeAppUrl('http://[::1]:3000')).toBe(true)
    expect(isFirstPartyRuntimeAppUrl('http://api.localhost')).toBe(true)
  })

  test('any other https host, lookalikes and downgrades are not first-party', () => {
    expect(isFirstPartyRuntimeAppUrl('https://attacker.example')).toBe(false)
    expect(isFirstPartyRuntimeAppUrl('https://evilcodebuff.com')).toBe(false)
    expect(isFirstPartyRuntimeAppUrl('https://codebuff.com.evil.example')).toBe(
      false,
    )
    expect(isFirstPartyRuntimeAppUrl('https://codebuff.com.')).toBe(false)
    expect(isFirstPartyRuntimeAppUrl('https://1.2.3.4')).toBe(false)
    expect(isFirstPartyRuntimeAppUrl('http://codebuff.com')).toBe(false)
    expect(isFirstPartyRuntimeAppUrl('not a url')).toBe(false)
  })
})

describe('getRuntimeAppUrlFromEnv / getWebsiteUrl', () => {
  const saved = {
    NEXT_PUBLIC_CODEBUFF_APP_URL: process.env.NEXT_PUBLIC_CODEBUFF_APP_URL,
    CODEBUFF_APP_URL: process.env.CODEBUFF_APP_URL,
    CODEBUFF_ALLOW_CUSTOM_APP_URL: process.env.CODEBUFF_ALLOW_CUSTOM_APP_URL,
  }
  let warn: ReturnType<typeof spyOn>

  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
    delete process.env.CODEBUFF_ALLOW_CUSTOM_APP_URL
  })

  afterEach(() => {
    warn.mockRestore()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('the test build is not a dev build, so no host is allowed implicitly', () => {
    expect(isCustomRuntimeAppUrlAllowed()).toBe(false)
  })

  test('a first-party https override is honoured, with its trailing slash stripped', () => {
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = 'https://staging.codebuff.com/'
    expect(getRuntimeAppUrlFromEnv()).toBe('https://staging.codebuff.com/')
    expect(getWebsiteUrl()).toBe('https://staging.codebuff.com')
    expect(warn).not.toHaveBeenCalled()
  })

  test('an https override to a third-party host is ignored without the opt-in', () => {
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL =
      'https://token-sink.example/collect'
    expect(getRuntimeAppUrlFromEnv()).toBeUndefined()
    expect(getWebsiteUrl()).toBe(bundledUrl)
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('https://token-sink.example')
    expect(message).toContain('CODEBUFF_ALLOW_CUSTOM_APP_URL')
    expect(message).not.toContain('/collect')
  })

  test('the explicit opt-in lets an https third-party host through', () => {
    process.env.CODEBUFF_ALLOW_CUSTOM_APP_URL = '1'
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = 'https://api.example.com/'
    expect(getRuntimeAppUrlFromEnv()).toBe('https://api.example.com/')
    expect(getWebsiteUrl()).toBe('https://api.example.com')
    expect(warn).not.toHaveBeenCalled()
  })

  test('the opt-in never re-admits plain http to a remote host', () => {
    process.env.CODEBUFF_ALLOW_CUSTOM_APP_URL = 'true'
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = 'http://opt-in-downgrade.example'
    expect(getRuntimeAppUrlFromEnv()).toBeUndefined()
    expect(getWebsiteUrl()).toBe(bundledUrl)
  })

  test('only affirmative opt-in values count', () => {
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = 'https://api.example.com/'
    for (const value of ['0', 'false', '', 'no', 'https://api.example.com']) {
      process.env.CODEBUFF_ALLOW_CUSTOM_APP_URL = value
      expect(getRuntimeAppUrlFromEnv()).toBeUndefined()
    }
  })

  test('an http override on localhost is honoured', () => {
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = 'http://localhost:3999/'
    expect(getWebsiteUrl()).toBe('http://localhost:3999')
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = 'http://127.0.0.1:3999'
    expect(getWebsiteUrl()).toBe('http://127.0.0.1:3999')
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = 'http://[::1]:3999'
    expect(getWebsiteUrl()).toBe('http://[::1]:3999')
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = 'http://foo.localhost:3999'
    expect(getWebsiteUrl()).toBe('http://foo.localhost:3999')
    expect(warn).not.toHaveBeenCalled()
  })

  test('an http override to a remote host is ignored and the bundled URL is used', () => {
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL =
      'http://evil.example:3000/steal/token'
    expect(getRuntimeAppUrlFromEnv()).toBeUndefined()
    expect(getWebsiteUrl()).toBe(bundledUrl)
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('NEXT_PUBLIC_CODEBUFF_APP_URL')
    expect(message).toContain('http://evil.example:3000')
    // protocol + host only: the path is not repeated into the log
    expect(message).not.toContain('/steal')
  })

  test('the warning is emitted once per process, not once per call', () => {
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL =
      'http://evil.example:3000/steal/token'
    getWebsiteUrl()
    getWebsiteUrl()
    getWebsiteUrl()
    // this origin already warned in the previous test; the dedup set is
    // module-level, so no new line is produced here either
    expect(warn).not.toHaveBeenCalled()
  })

  test('garbage is ignored and the bundled URL is used', () => {
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = 'definitely not a url'
    expect(getRuntimeAppUrlFromEnv()).toBeUndefined()
    expect(getWebsiteUrl()).toBe(bundledUrl)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('unparseable value')
  })

  test('an empty override reads as unset, without a warning', () => {
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = ''
    delete process.env.CODEBUFF_APP_URL
    expect(getRuntimeAppUrlFromEnv()).toBeUndefined()
    expect(getWebsiteUrl()).toBe(bundledUrl)
    expect(warn).not.toHaveBeenCalled()
  })

  test('the CODEBUFF_APP_URL fallback variable is held to the same rule', () => {
    delete process.env.NEXT_PUBLIC_CODEBUFF_APP_URL
    process.env.CODEBUFF_APP_URL = 'https://www.codebuff.com/'
    expect(getWebsiteUrl()).toBe('https://www.codebuff.com')

    process.env.CODEBUFF_APP_URL = 'http://attacker.example'
    expect(getRuntimeAppUrlFromEnv()).toBeUndefined()
    expect(getWebsiteUrl()).toBe(bundledUrl)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'CODEBUFF_APP_URL (http://attacker.example)',
    )
  })

  test('a rejected NEXT_PUBLIC value does not fall through to CODEBUFF_APP_URL', () => {
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = 'http://rejected.example'
    process.env.CODEBUFF_APP_URL = 'https://would-be-honoured.codebuff.com'
    expect(getRuntimeAppUrlFromEnv()).toBeUndefined()
    expect(getWebsiteUrl()).toBe(bundledUrl)
  })
})
