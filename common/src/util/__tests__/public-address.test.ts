import { describe, expect, test } from 'bun:test'

import { isPublicAddress, PRIVATE_HOSTNAME } from '../public-address'

describe('isPublicAddress', () => {
  test('globally routable addresses are public', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
      expect(isPublicAddress(address)).toBe(true)
  })

  test('private, reserved and special-purpose addresses are not', () => {
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.0.0.1',
      '192.168.1.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '64:ff9b::a00:1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
      'not-an-address',
    ])
      expect(isPublicAddress(address)).toBe(false)
  })

  // The advertiser fetcher's own copy of this list allowed these two.
  test('transition ranges that can carry a private IPv4 address are not', () => {
    for (const address of [
      // 6to4 relay anycast
      '192.88.99.1',
      // Teredo
      '2001::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      // 6to4 embedding 10.0.0.1 and 127.0.0.1
      '2002:a00:1::',
      '2002:7f00:1::',
    ])
      expect(isPublicAddress(address)).toBe(false)
  })

  test('a public address next to a transition range stays public', () => {
    // Google public DNS sits in 2001:4860::/32, outside Teredo's 2001::/32.
    expect(isPublicAddress('2001:4860:4860::8888')).toBe(true)
    expect(isPublicAddress('192.88.100.1')).toBe(true)
  })
})

describe('PRIVATE_HOSTNAME', () => {
  test('names a private network', () => {
    for (const host of [
      'localhost',
      'printer.local',
      'metadata.google.internal',
      'router.lan',
      'nas.home.arpa',
    ])
      expect(PRIVATE_HOSTNAME.test(host)).toBe(true)
  })

  test('leaves public names alone', () => {
    for (const host of ['example.com', 'localhost.example.com', 'lan.dev'])
      expect(PRIVATE_HOSTNAME.test(host)).toBe(false)
  })
})
